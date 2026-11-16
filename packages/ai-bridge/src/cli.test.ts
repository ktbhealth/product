import { describe, expect, it } from "vitest";

import { connect, main, parseArgs, type BridgeProcess, type BridgeWebSocket } from "./cli.ts";

/** Fake agent process — stdout data and lifecycle events are driven
 * manually so the test controls interleaving precisely. */
const makeProc = () => {
	const stdin: string[] = [];
	const listeners = new Map<string, ((...a: readonly unknown[]) => void)[]>();
	const stdoutData: ((c: string | Uint8Array) => void)[] = [];
	const proc: BridgeProcess = {
		stdin: { write: (c: string) => stdin.push(c) },
		stdout: { on: (_e, l) => stdoutData.push(l) },
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
		stdoutData,
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
			parseArgs(["connect", "https://x/api/ai/bridge?token=t", "--cmd", "claude agent acp"]),
		).toEqual({
			url: "https://x/api/ai/bridge?token=t",
			cmd: "claude agent acp",
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
});

describe("connect", () => {
	it("pipes ws→stdin and stdout→ws (line framing), then exits on --once drop", async () => {
		FakeWS.reset();
		const { proc, stdin, stdoutData } = makeProc();
		const p = connect(
			{ url: "wss://x/api/ai/bridge?token=t", cmd: "agent", once: true },
			deps(proc),
		);
		const ws = FakeWS.instances[0]!;
		ws.open();
		// Agent → worker: a whole line frame (blank lines skipped).
		stdoutData[0]!('\n{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
		expect(ws.sent).toHaveLength(1);
		expect(JSON.parse(ws.sent[0]!)).toMatchObject({ id: 1 });
		// Worker → agent: one JSON message per stdin line.
		ws.message('{"jsonrpc":"2.0","id":2,"method":"session/prompt"}');
		expect(stdin[0]).toBe('{"jsonrpc":"2.0","id":2,"method":"session/prompt"}\n');
		ws.drop();
		expect(await p).toBe(1);
	});

	it("decodes Content-Length stdout frames and binary ws messages", async () => {
		FakeWS.reset();
		const { proc, stdin, stdoutData } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.open();
		stdoutData[0]!('Content-Length: 9\r\n\r\n{"a":"b"}');
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
		const { proc, stdoutData } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		// never open()ed — readyState stays CONNECTING.
		stdoutData[0]!('{"id":1}\n');
		expect(ws.sent).toHaveLength(0);
		ws.drop();
		await p;
	});

	it("reconnects with backoff until retries run out", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", retries: 2 }, deps(proc, { backoffMs: () => 0 }));
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
	});

	it("--once never reconnects", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		FakeWS.instances[0]!.open();
		FakeWS.instances[0]!.drop();
		expect(await p).toBe(1);
		expect(FakeWS.instances).toHaveLength(1);
	});

	it("stops when the agent process exits mid-attach", async () => {
		FakeWS.reset();
		const { proc, emit } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a" }, deps(proc));
		FakeWS.instances[0]!.open();
		emit("exit");
		expect(await p).toBe(1);
		expect(FakeWS.instances).toHaveLength(1);
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
		expect(await p).toBe(1);
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
		const p = connect(
			{ url: "wss://x", cmd: "a", retries: 3 },
			deps(proc, { backoffMs: () => 20 }),
		);
		FakeWS.instances[0]!.open();
		FakeWS.instances[0]!.drop();
		await sleep(5); // inside the backoff window
		emit("exit");
		expect(await p).toBe(1);
		expect(FakeWS.instances).toHaveLength(1);
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
	});

	it("reconnects with the default backoff and heartbeat knobs", async () => {
		FakeWS.reset();
		const { proc } = makeProc();
		const d = deps(proc);
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
		const { proc, stdoutData } = makeProc();
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.open();
		ws.send = () => {
			throw new Error("gone mid-frame");
		};
		stdoutData[0]!('{"id":1}\n');
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
		const p = connect({ url: "wss://x", cmd: "a", once: true }, deps(proc));
		const ws = FakeWS.instances[0]!;
		ws.open();
		ws.message('{"id":1}');
		expect(await p).toBe(1);
	});
});

describe("main", () => {
	it("prints usage and exits 2 on bad argv", async () => {
		expect(await main([])).toBe(2);
	});

	it("delegates valid argv to connect (which owns deps)", async () => {
		// main can't take deps — a garbage url fails the real WebSocket
		// constructor inside the first attach, before any net I/O.
		await expect(main(["connect", "not-a-url", "--cmd", "true"])).rejects.toThrow();
	});
});
