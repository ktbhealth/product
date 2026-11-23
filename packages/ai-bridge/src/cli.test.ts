import { describe, expect, it } from "vitest";

import { connect, main, parseArgs, type BridgeProcess, type BridgeWebSocket } from "./cli.ts";

/** Fake agent process — stdout data and lifecycle events are driven
 * manually so the test controls interleaving precisely. */
const makeProc = () => {
	const stdin: string[] = [];
	const listeners = new Map<string, ((...a: readonly unknown[]) => void)[]>();
	const stdoutListeners = new Map<string, ((c: string | Uint8Array) => void)[]>();
	const proc: BridgeProcess = {
		stdin: { write: (c: string) => stdin.push(c) },
		stdout: {
			on: (ev, l) => {
				const arr = stdoutListeners.get(ev) ?? [];
				arr.push(l);
				stdoutListeners.set(ev, arr);
			},
		},
		on: (ev, l) => {
			const arr = listeners.get(ev) ?? [];
			arr.push(l);
			listeners.set(ev, arr);
		},
		kill: () => {},
	};
	return {
		proc,
		stdin,
		emitStdout: (chunk: string | Uint8Array, ev = "data") =>
			stdoutListeners.get(ev)?.forEach((l) => l(chunk)),
		emit: (ev: string) => listeners.get(ev)?.forEach((l) => l()),
	};
};

class FakeWS implements BridgeWebSocket {
	static instances: FakeWS[] = [];
	static reset() {
		FakeWS.instances = [];
	}
	readyState = 0;
	readonly sent: string[] = [];
	closeThrows = false;
	closed = false;
	closeCalls = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { readonly data: unknown }) => void) | null = null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	constructor(readonly url: string) {
		FakeWS.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closeCalls += 1;
		if (this.closeThrows) throw new Error("already closing");
		this.closed = true;
	}
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}
	message(data: unknown): void {
		this.onmessage?.({ data });
	}
	drop(): void {
		this.onclose?.({ code: 1006, reason: "lost" });
	}
	error(): void {
		this.onerror?.(new Error("boom"));
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const deps = (proc: BridgeProcess, extra: Record<string, unknown> = {}) => ({
	ws: FakeWS as unknown as new (url: string) => BridgeWebSocket,
	spawn: () => proc,
	heartbeatMs: 60_000,
	backoffMs: () => 0,
	log: () => {},
	...extra,
});

describe("parseArgs", () => {
	it("parses the canonical connect form", () => {
		expect(
			parseArgs([
				"connect",
				"https://x/api/ai/bridge?token=t",
				"--cmd",
				"bunx @agentclientprotocol/claude-agent-acp",
			]),
		).toEqual({
			url: "https://x/api/ai/bridge?token=t",
			cmd: "bunx @agentclientprotocol/claude-agent-acp",
			once: false,
		});
	});

	it("parses --once and --retries", () => {
		expect(parseArgs(["connect", "u", "--cmd", "a", "--once", "--retries", "3"])).toEqual({
			url: "u",
			cmd: "a",
			once: true,
			retries: 3,
		});
	});

	it("rejects non-connect subcommands, missing flags, bad values", () => {
		expect(parseArgs([])).toBeNull();
		expect(parseArgs(["listen", "u"])).toBeNull();
		expect(parseArgs(["connect", "u"])).toBeNull();
		expect(parseArgs(["connect", "--cmd", "x"])).toBeNull();
		expect(parseArgs(["connect", "u", "--cmd", "  "])).toBeNull();
		expect(parseArgs(["connect", "u", "--cmd", "x", "--bogus"])).toBeNull();
		expect(parseArgs(["connect", "u", "--cmd", "x", "--retries", "nope"])).toBeNull();
	});

	it("rejects a non-connect subcommand even with full connect args", () => {
		expect(parseArgs(["listen", "u", "--cmd", "x"])).toBeNull();
	});

	it("rejects fractional, negative and non-numeric retries", () => {
		expect(parseArgs(["connect", "u", "--cmd", "x", "--retries", "1.5"])).toBeNull();
		expect(parseArgs(["connect", "u", "--cmd", "x", "--retries", "-1"])).toBeNull();
	});

	it("accepts --retries 0 and omits the retries key when absent", () => {
		expect(parseArgs(["connect", "u", "--cmd", "x", "--retries", "0"])).toEqual({
			url: "u",
			cmd: "x",
			once: false,
			retries: 0,
		});
		const parsed = parseArgs(["connect", "u", "--cmd", "x"]);
		expect(parsed).not.toBeNull();
		expect(parsed).not.toHaveProperty("retries");
	});

	it("rejects a second positional url and accepts dash-suffixed urls", () => {
		expect(parseArgs(["connect", "u1", "u2", "--cmd", "x"])).toBeNull();
		expect(parseArgs(["connect", "u-", "--cmd", "x"])).toEqual({
			url: "u-",
			cmd: "x",
			once: false,
		});
	});
});

describe("connect", () => {
	it("pipes ws→stdin and stdout→ws (line framing), then exits on --once drop", async () => {
		FakeWS.reset();
		const { proc, stdin, emitStdout } = makeProc();
		const p = connect(
			{ url: "wss://x/api/ai/bridge?token=t", cmd: "agent", once: true },
			deps(proc),
		);
		const ws = FakeWS.instances[0]!;
		ws.open();
		// Agent → worker: a whole line frame (blank lines skipped).
		emitStdout('\n{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
		expect(ws.sent).toHaveLength(1);
		expect(JSON.parse(ws.sent[0]!)).toMatchObject({ id: 1 });
		// Worker → agent: one JSON message per stdin line.
		ws.message('{"jsonrpc":"2.0","id":2,"method":"session/prompt"}');
		expect(stdin[0]).toBe('{"jsonrpc":"2.0","id":2,"method":"session/prompt"}\n');
		ws.drop();
		expect(await p).toBe(1);
		expect(ws.closed).toBe(true);
		expect(ws.closeCalls).toBe(1);
	});

	it("skips whitespace-only agent frames", async () => {
		FakeWS.reset();
		const { proc, emitStdout } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.open();
		emitStdout("   \n");
		expect(ws.sent).toHaveLength(0);
		ws.drop();
		await p;
	});

	it("ignores agent output after the socket is gone", async () => {
		FakeWS.reset();
		const { proc, emitStdout } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.open();
		ws.drop();
		await p;
		// ws is null now — a late frame must not reach the dead socket
		// (or crash on a null readyState read).
		expect(() => emitStdout('{"id":9}\n')).not.toThrow();
		expect(ws.sent).toHaveLength(0);
	});

	it("decodes Content-Length stdout frames and binary ws messages", async () => {
		FakeWS.reset();
		const { proc, stdin, emitStdout } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.open();
		emitStdout('Content-Length: 9\r\n\r\n{"a":"b"}');
		expect(ws.sent[0]).toBe('{"a":"b"}');
		ws.message(new TextEncoder().encode('{"n":1}'));
		expect(stdin[0]).toBe('{"n":1}\n');
		// Un-decodable message payloads are ignored.
		ws.message(42);
		expect(stdin).toHaveLength(1);
		ws.drop();
		await p;
	});

	it("drops agent output while the socket is closed", async () => {
		FakeWS.reset();
		const { proc, emitStdout } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		// never open()ed — readyState stays CONNECTING.
		emitStdout('{"id":1}\n');
		expect(ws.sent).toHaveLength(0);
		ws.drop();
		await p;
	});

	it("reconnects with backoff until retries run out", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const logs: string[] = [];
		const p = connect(
			{ url: "wss://x", cmd: "a", retries: 2 },
			deps(proc, { backoffMs: () => 0, log: (l: string) => logs.push(l) }),
		);
		for (let i = 0; i < 3; i++) {
			// The next attach runs after a setTimeout(0) backoff — wait
			// for the instance to exist before driving it.
			for (let w = 0; FakeWS.instances[i] === undefined && w < 50; w++) await sleep(2);
			const ws = FakeWS.instances[i]!;
			ws.open();
			ws.drop();
		}
		expect(await p).toBe(1);
		expect(FakeWS.instances).toHaveLength(3); // initial + 2 retries
		expect(logs.some((l) => l.includes("giving up after 2 retries"))).toBe(true);
	});

	it("--once never reconnects", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const logs: string[] = [];
		const p = connect(
			{ url: "wss://x", cmd: "a", once: true },
			deps(proc, { log: (l: string) => logs.push(l) }),
		);
		FakeWS.instances[0]!.open();
		FakeWS.instances[0]!.drop();
		expect(await p).toBe(1);
		expect(FakeWS.instances).toHaveLength(1);
		expect(logs.some((l) => l.includes("socket closed"))).toBe(true);
	});

	it("stops when the agent process exits mid-attach", async () => {
		FakeWS.reset();
		const { proc, emit } = makeProc();
		const logs: string[] = [];
		const p = connect(
			{ url: "wss://x", cmd: "a" },
			deps(proc, { log: (l: string) => logs.push(l) }),
		);
		FakeWS.instances[0]!.open();
		emit("exit");
		expect(await p).toBe(1);
		expect(FakeWS.instances).toHaveLength(1);
		expect(logs.some((l) => l.includes("agent process exited"))).toBe(true);
		expect(logs.some((l) => l.includes("reconnecting"))).toBe(false);
	});

	it("sends the heartbeat control frame", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc, { heartbeatMs: 5 }));
		const ws = FakeWS.instances[0]!;
		ws.open();
		await sleep(20);
		expect(ws.sent).toContain(JSON.stringify({ type: "ping" }));
		ws.drop();
		await p;
	});

	it("stops pinging once the socket settles", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc, { heartbeatMs: 5 }));
		const ws = FakeWS.instances[0]!;
		ws.open();
		ws.drop();
		await p;
		const count = ws.sent.length;
		await sleep(20);
		expect(ws.sent).toHaveLength(count);
	});

	it("treats a heartbeat send failure as a dropped socket", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc, { heartbeatMs: 5 }));
		const ws = FakeWS.instances[0]!;
		ws.open();
		ws.send = () => {
			throw new Error("gone");
		};
		await sleep(20);
		// Race the settle so a regression fails fast instead of hanging.
		const code = await Promise.race([p, sleep(200).then(() => "hung" as const)]);
		expect(code).toBe(1);
	});

	it("agent death before attach completes short-circuits the loop", async () => {
		FakeWS.reset();
		const { proc, emit } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		emit("error"); // dead before the first socket even opens
		expect(await p).toBe(1);
	});

	it("stops when the agent dies between reconnect attempts", async () => {
		FakeWS.reset();
		const { proc, emit } = makeProc();
		const logs: string[] = [];
		const p = connect(
			{ url: "wss://x", cmd: "a", retries: 3 },
			deps(proc, { backoffMs: () => 20, log: (l: string) => logs.push(l) }),
		);
		FakeWS.instances[0]!.open();
		FakeWS.instances[0]!.drop();
		await sleep(5); // inside the backoff window
		emit("exit");
		expect(await p).toBe(1);
		expect(FakeWS.instances).toHaveLength(1);
		expect(logs.some((l) => l.includes("agent process exited"))).toBe(true);
	});

	it("agent death racing a socket close still reports agent exit", async () => {
		FakeWS.reset();
		const { proc, emit } = makeProc();
		const logs: string[] = [];
		const p = connect(
			{ url: "wss://x", cmd: "a", retries: 3 },
			deps(proc, { backoffMs: () => 0, log: (l: string) => logs.push(l) }),
		);
		FakeWS.instances[0]!.open();
		// The socket closes first, then the agent dies before the
		// attempt continuation runs — dead must win over "closed".
		FakeWS.instances[0]!.drop();
		emit("exit");
		expect(await p).toBe(1);
		expect(logs.some((l) => l.includes("agent process exited"))).toBe(true);
		expect(logs.some((l) => l.includes("reconnecting"))).toBe(false);
	});

	it("tolerates error+close double events on one socket", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.open();
		ws.error();
		ws.drop(); // second done() call hits the settled guard
		expect(await p).toBe(1);
		expect(ws.closeCalls).toBe(1);
	});

	it("reconnects with the default backoff and heartbeat knobs", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const logs: string[] = [];
		const d = deps(proc, { log: (l: string) => logs.push(l) });
		delete (d as Record<string, unknown>).heartbeatMs;
		delete (d as Record<string, unknown>).backoffMs;
		const p = connect({ url: "wss://x", cmd: "a", retries: 1 }, d);
		for (let i = 0; i < 2; i++) {
			for (let w = 0; FakeWS.instances[i] === undefined && w < 300; w++) await sleep(10);
			FakeWS.instances[i]!.open();
			FakeWS.instances[i]!.drop();
		}
		expect(await p).toBe(1);
		expect(FakeWS.instances).toHaveLength(2); // initial + 1 retry, default 500ms backoff
		// tries=1 → default backoff is min(2**1 * 500, 10_000) = 1000ms.
		expect(logs.some((l) => l.includes("reconnecting in 1000ms"))).toBe(true);
	});

	it("decodes ArrayBuffer ws messages", async () => {
		FakeWS.reset();
		const { proc, stdin } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.open();
		ws.message(new TextEncoder().encode('{"n":7}').buffer);
		expect(stdin[0]).toBe('{"n":7}\n');
		ws.drop();
		await p;
	});

	it("an error event detaches like a close", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		FakeWS.instances[0]!.open();
		FakeWS.instances[0]!.error();
		expect(await p).toBe(1);
	});

	it("skips heartbeats while the socket is not open", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc, { heartbeatMs: 5 }));
		const ws = FakeWS.instances[0]!;
		// never open()ed — pings fire but early-return.
		await sleep(15);
		expect(ws.sent).toHaveLength(0);
		ws.drop();
		await p;
	});

	it("close() throwing during teardown is tolerated", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.closeThrows = true;
		ws.open();
		ws.drop();
		expect(await p).toBe(1);
		expect(ws.closed).toBe(false); // the throw swallowed the flag
	});

	it("logs through console.error when no log dep is given", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const errors: unknown[][] = [];
		const orig = console.error;
		console.error = (...a: unknown[]) => errors.push(a);
		try {
			const d = deps(proc);
			delete (d as Record<string, unknown>).log;
			const p = connect({ url: "wss://x", cmd: "a", once: true }, d);
			FakeWS.instances[0]!.open();
			FakeWS.instances[0]!.drop();
			await p;
		} finally {
			console.error = orig;
		}
		expect(errors.some((a) => String(a[0]).includes("[ai-bridge]"))).toBe(true);
	});

	it("spawn send() throwing inside the relay loop is swallowed", async () => {
		FakeWS.reset();
		const { proc, emitStdout } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.open();
		ws.send = () => {
			throw new Error("gone mid-frame");
		};
		emitStdout('{"id":1}\n');
		ws.drop();
		await p;
	});

	it("spawns through node:child_process when no spawn dep is given", async () => {
		FakeWS.reset();
		const d = {
			ws: FakeWS as unknown as new (url: string) => BridgeWebSocket,
			heartbeatMs: 60_000,
			backoffMs: () => 0,
			log: () => {},
		};
		// `sh -c true` exits 0 immediately — the default spawn path runs
		// and agent death ends the loop with 1.
		const code = await connect({ url: "wss://x", cmd: "true" }, d);
		expect(code).toBe(1);
	});

	it("stdin write failure counts as agent death", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		(proc.stdin as { write: (c: string) => void }).write = () => {
			throw new Error("closed stdin");
		};
		const logs: string[] = [];
		const p = connect(
			{ url: "wss://x", cmd: "a", retries: 2 },
			deps(proc, { log: (l: string) => logs.push(l) }),
		);
		const ws = FakeWS.instances[0]!;
		ws.open();
		ws.message('{"id":1}');
		// If the failure were treated as a plain socket drop the bridge
		// would keep retrying — drop any follow-up sockets so the run
		// terminates, then assert it never reconnected.
		for (let i = 1; i <= 2; i++) {
			for (let w = 0; FakeWS.instances[i] === undefined && w < 100; w++) await sleep(2);
			FakeWS.instances[i]?.drop();
		}
		expect(await p).toBe(1);
		expect(FakeWS.instances).toHaveLength(1);
		expect(logs.some((l) => l.includes("agent process exited"))).toBe(true);
	});

	it("logs the connect line with the bridge url on open", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const logs: string[] = [];
		const p = connect(
			{ url: "wss://x/api/ai/bridge?token=t", cmd: "a", once: true },
			deps(proc, { log: (l: string) => logs.push(l) }),
		);
		FakeWS.instances[0]!.open();
		FakeWS.instances[0]!.drop();
		await p;
		expect(logs.some((l) => l.includes("connected wss://x/api/ai/bridge?token=t"))).toBe(true);
	});
});

describe("main", () => {
	it("prints usage and exits 2 on bad argv", async () => {
		const errors: unknown[][] = [];
		const orig = console.error;
		console.error = (...a: unknown[]) => errors.push(a);
		try {
			expect(await main([])).toBe(2);
		} finally {
			console.error = orig;
		}
		const usage = errors.map((a) => String(a[0])).join("\n");
		expect(usage).toContain("usage: ai-bridge connect");
		expect(usage).toContain("--cmd");
		expect(usage).toContain("LOCAL");
	});

	it("delegates valid argv to connect (which owns deps)", async () => {
		// main can't take deps — a garbage url fails the real WebSocket
		// constructor inside the first attach, before any net I/O.
		await expect(main(["connect", "not-a-url", "--cmd", "true"])).rejects.toThrow();
	});
});
