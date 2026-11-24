import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import { makeStdioRpc, type SpawnedProcess } from "./stdio-rpc.ts";

const spawnCalls = vi.hoisted(() => ({ list: [] as unknown[][] }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: readonly string[], options?: object) => {
			spawnCalls.list.push([command, args, options]);
			return actual.spawn(command, [...args], options as never);
		},
	};
});

/** In-memory SpawnedProcess: stdin writes are parsed as JSON-RPC frames
 * and forwarded to `onLine` (which replies via `send`); tests can also
 * push raw stdout bytes (`emitOut`) and fire exit/error events. */
interface FakeProc extends SpawnedProcess {
	readonly written: string[];
	readonly fire: (event: "exit" | "error" | "close", ...args: unknown[]) => void;
	readonly emitOut: (data: string | Uint8Array) => void;
	readonly killed: () => boolean;
}

const makeFakeProc = (
	onLine?: (msg: Record<string, unknown>, send: (o: unknown) => void) => void,
	opts?: { readonly noEnd?: boolean },
): FakeProc => {
	const written: string[] = [];
	const outHandlers: ((chunk: string | Uint8Array) => void)[] = [];
	const evtHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
	let lineBuf = "";
	let killed = false;
	const send = (o: unknown) => {
		for (const h of outHandlers) h(`${JSON.stringify(o)}\n`);
	};
	const stdin: SpawnedProcess["stdin"] = {
		write: (chunk) => {
			written.push(chunk);
			lineBuf += chunk;
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop()!;
			for (const line of lines) {
				if (line.trim() === "") continue;
				onLine?.(JSON.parse(line), send);
			}
		},
		...(opts?.noEnd === true ? {} : { end: () => {} }),
	};
	return {
		written,
		stdin,
		stdout: {
			on: (_event, listener) => {
				outHandlers.push(listener);
			},
		},
		on: (event, listener) => {
			evtHandlers.set(event, [...(evtHandlers.get(event) ?? []), listener]);
		},
		kill: () => {
			killed = true;
		},
		fire: (event, ...args) => {
			for (const h of evtHandlers.get(event) ?? []) h(...args);
		},
		emitOut: (data) => {
			for (const h of outHandlers) h(data);
		},
		killed: () => killed,
	};
};

const spawnImpl = (proc: FakeProc) => {
	const calls: string[][] = [];
	return {
		calls,
		impl: (command: string, args: readonly string[]) => {
			calls.push([command, ...args]);
			return proc;
		},
	};
};

const scoped = <A>(eff: Effect.Effect<A, unknown, import("effect/Scope").Scope>) =>
	Effect.runPromise(Effect.scoped(eff));

const echoProc = () =>
	makeFakeProc((msg, send) => {
		if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method } });
	});

describe("makeStdioRpc", () => {
	it("correlates requests by generated id and returns the result", async () => {
		const proc = echoProc();
		const { calls, impl } = spawnImpl(proc);
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["agent", "--acp"], spawnImpl: impl });
				const r = yield* rpc.request("initialize", { protocolVersion: 1 });
				const r2 = yield* rpc.request("session/new");
				return [r, r2];
			}),
		);
		expect(out).toEqual([{ echoed: "initialize" }, { echoed: "session/new" }]);
		expect(calls[0]).toEqual(["agent", "--acp"]);
		expect(JSON.parse(proc.written[0]!)).toMatchObject({
			jsonrpc: "2.0",
			id: "req-1",
			method: "initialize",
			params: { protocolVersion: 1 },
		});
		// params omitted → the key stays off the wire.
		expect("params" in JSON.parse(proc.written[1]!)).toBe(false);
	});

	it("runs the real spawn path (lazy node:child_process import)", async () => {
		const script = [
			'let b="";process.stdin.on("data",(d)=>{b+=d;',
			"const ls=b.split('\\n');b=ls.pop();",
			"for(const l of ls){if(!l.trim())continue;const m=JSON.parse(l);",
			"if(m.method==='ping')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:'pong'})+'\\n');}});",
		].join("");
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: [process.execPath, "-e", script] });
				return yield* rpc.request("ping");
			}),
		);
		expect(out).toBe("pong");
	});

	it("spawns with piped stdin/stdout and inherited stderr", async () => {
		spawnCalls.list.length = 0;
		const script = [
			'let b="";process.stdin.on("data",(d)=>{b+=d;',
			"const ls=b.split('\\n');b=ls.pop();",
			"for(const l of ls){if(!l.trim())continue;const m=JSON.parse(l);",
			"if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:'ok'})+'\\n');}});",
		].join("");
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: [process.execPath, "-e", script] });
				return yield* rpc.request("ping");
			}),
		);
		expect(out).toBe("ok");
		const call = spawnCalls.list.find((c) => c[0] === process.execPath);
		expect(call?.[1]).toEqual(["-e", script]);
		expect(call?.[2]).toEqual({ stdio: ["pipe", "pipe", "inherit"] });
	});

	it("surfaces JSON-RPC error responses as PortError", async () => {
		const proc = makeFakeProc((msg, send) =>
			send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "busy" } }),
		);
		const err = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* Effect.flip(rpc.request("m"));
			}),
		);
		expect(err.message).toBe("agent error -32000: busy");
	});

	it("ignores responses for unknown ids, blank lines and buffers partial frames", async () => {
		const proc = makeFakeProc((msg) => {
			// A bogus reply for an id nothing waits on + a blank line +
			// a frame with neither method nor id, then the real response
			// split across two stdout writes.
			proc.emitOut(
				'\n{"jsonrpc":"2.0","id":"req-999","result":{}}\n{"jsonrpc":"2.0"}\n{"jsonrpc":"2.0","id"',
			);
			proc.emitOut(new TextEncoder().encode(`:"${msg.id}","result":{"ok":true}}\n`));
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* rpc.request("m");
			}),
		);
		expect(out).toEqual({ ok: true });
	});

	it("skips whitespace-only frames instead of corrupting the session", async () => {
		const proc = makeFakeProc((msg, send) => {
			// A frame of pure spaces carries no JSON — it must be
			// ignored like a blank line, not parsed.
			proc.emitOut("   \n");
			if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: "ok" });
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* rpc.request("m");
			}),
		);
		expect(out).toBe("ok");
	});

	it("accepts Content-Length-framed replies, split mid-body and multibyte-safe", async () => {
		const proc = makeFakeProc((msg) => {
			const body = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "resposta — ção" });
			const bytes = new TextEncoder().encode(body);
			// Split mid-`\r\n\r\n` — the first chunk leaves an unterminated
			// header, so framing waits for the rest before slicing.
			proc.emitOut(`Content-Length: ${bytes.length}\r\n\r`);
			proc.emitOut("\n");
			// Split INSIDE the multibyte payload — byte-accurate slicing
			// must not corrupt the frame.
			proc.emitOut(bytes.subarray(0, bytes.length - 3));
			proc.emitOut(bytes.subarray(bytes.length - 3));
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* rpc.request("m");
			}),
		);
		expect(out).toBe("resposta — ção");
	});

	it("accepts Content-Length frames terminated by a bare blank line", async () => {
		const proc = makeFakeProc((msg) => {
			const body = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "lf" });
			proc.emitOut(`Content-Length: ${body.length}\n\n${body}`);
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* rpc.request("m");
			}),
		);
		expect(out).toBe("lf");
	});

	it("a corrupt Content-Length header corrupts framing the same way", async () => {
		const proc = makeFakeProc(() => {
			proc.emitOut("Content-Length: not-a-number\r\n\r\n{}");
		});
		const err = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* Effect.flip(rpc.request("m"));
			}),
		);
		expect(err.message).toContain("invalid json-rpc frame");
	});

	it("fails pending AND future requests on a corrupt frame", async () => {
		const proc = makeFakeProc((msg, send) => {
			if (msg.method === "die") proc.emitOut("<<not json>>\n");
			else send({ jsonrpc: "2.0", id: msg.id, result: "alive" });
		});
		const errs = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				expect(yield* rpc.request("m")).toBe("alive");
				const e1 = yield* Effect.flip(rpc.request("die"));
				// A second death source (process exit) keeps the original
				// PortError — the first failure wins.
				proc.fire("exit", 9);
				// The transport is dead — a later request fails with the
				// same PortError instead of writing into the void.
				const e2 = yield* Effect.flip(rpc.request("m"));
				return [e1, e2];
			}),
		);
		expect(errs[0]!.message).toContain("invalid json-rpc frame");
		expect(errs[1]!.message).toContain("invalid json-rpc frame");
	});

	it("rejects pending requests when the agent exits", async () => {
		const proc = makeFakeProc((msg) => {
			if (msg.method === "die") proc.fire("exit", 2);
		});
		const err = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* Effect.flip(rpc.request("die"));
			}),
		);
		expect(err.message).toBe("acp agent exited (code 2)");
		expect(err.port).toBe("llm");
	});

	it("reports signal death as an unknown exit code", async () => {
		const proc = makeFakeProc((msg) => {
			if (msg.method === "die") proc.fire("exit", null, "SIGKILL");
		});
		const err = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* Effect.flip(rpc.request("die"));
			}),
		);
		expect(err.message).toBe("acp agent exited (code unknown)");
	});

	it("reports a string exit code verbatim", async () => {
		const proc = makeFakeProc((msg) => {
			if (msg.method === "die") proc.fire("exit", "SIGTERM");
		});
		const err = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* Effect.flip(rpc.request("die"));
			}),
		);
		expect(err.message).toBe("acp agent exited (code SIGTERM)");
	});

	it("rejects pending requests on process error events", async () => {
		const proc = makeFakeProc((msg) => {
			if (msg.method === "die") proc.fire("error", new Error("spawn ENOENT"));
		});
		const errs = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				const e1 = yield* Effect.flip(rpc.request("die"));
				return [e1];
			}),
		);
		expect(errs[0]!.message).toBe("acp agent error: spawn ENOENT");

		// Non-Error cause → String() branch.
		const proc2 = makeFakeProc((msg) => {
			if (msg.method === "die") proc2.fire("error", "raw-cause");
		});
		const e2 = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc2 });
				return yield* Effect.flip(rpc.request("die"));
			}),
		);
		expect(e2.message).toBe("acp agent error: raw-cause");
	});

	it("refuses agent→client requests with -32601 instead of hanging", async () => {
		const proc = makeFakeProc((msg, send) => {
			// Only react to client REQUESTS — replies (like our -32601
			// below) carry no method and must not retrigger the loop.
			if (msg.method === undefined) return;
			// The agent asks the client to read a file; the transport must
			// answer so the agent doesn't block on a reply that can't come.
			send({ jsonrpc: "2.0", id: "agent-7", method: "fs/read_text_file", params: {} });
			send({ jsonrpc: "2.0", id: msg.id, result: "done" });
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* rpc.request("session/prompt", {});
			}),
		);
		expect(out).toBe("done");
		const refusal = proc.written.map((w) => JSON.parse(w)).find((m) => m.id === "agent-7");
		expect(refusal).toMatchObject({
			jsonrpc: "2.0",
			error: { code: -32601, message: "client does not implement fs/read_text_file" },
		});
	});

	it("permissionPolicy allow selects the first allow_* option", async () => {
		const proc = makeFakeProc((msg, send) => {
			if (msg.method === undefined) return;
			send({
				jsonrpc: "2.0",
				id: "agent-8",
				method: "session/request_permission",
				params: {
					options: [
						{ optionId: "rej-1", kind: "reject_once" },
						{ optionId: "alw-1", kind: "allow_once" },
						{ optionId: "alw-2", kind: "allow_always" },
					],
				},
			});
			send({ jsonrpc: "2.0", id: msg.id, result: "done" });
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({
					argv: ["a"],
					spawnImpl: () => proc,
					permissionPolicy: "allow",
				});
				return yield* rpc.request("session/prompt", {});
			}),
		);
		expect(out).toBe("done");
		const reply = proc.written.map((w) => JSON.parse(w)).find((m) => m.id === "agent-8");
		expect(reply).toMatchObject({
			result: { outcome: { outcome: "selected", optionId: "alw-1" } },
		});
	});

	it("permissionPolicy reject selects the first reject_* option", async () => {
		const proc = makeFakeProc((msg, send) => {
			if (msg.method === undefined) return;
			send({
				jsonrpc: "2.0",
				id: "agent-9",
				method: "session/request_permission",
				params: {
					options: [
						{ optionId: "alw-1", kind: "allow_once" },
						{ optionId: "rej-1", kind: "reject_once" },
					],
				},
			});
			send({ jsonrpc: "2.0", id: msg.id, result: "done" });
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({
					argv: ["a"],
					spawnImpl: () => proc,
					permissionPolicy: "reject",
				});
				return yield* rpc.request("session/prompt", {});
			}),
		);
		expect(out).toBe("done");
		const reply = proc.written.map((w) => JSON.parse(w)).find((m) => m.id === "agent-9");
		expect(reply).toMatchObject({
			result: { outcome: { outcome: "selected", optionId: "rej-1" } },
		});
	});

	it("permissionPolicy answers -32602 when no option matches the policy", async () => {
		const proc = makeFakeProc((msg, send) => {
			if (msg.method === undefined) return;
			send({
				jsonrpc: "2.0",
				id: "agent-10",
				method: "session/request_permission",
				params: { options: [{ optionId: "alw-1", kind: "allow_once" }] },
			});
			send({ jsonrpc: "2.0", id: msg.id, result: "done" });
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({
					argv: ["a"],
					spawnImpl: () => proc,
					permissionPolicy: "reject",
				});
				return yield* rpc.request("session/prompt", {});
			}),
		);
		expect(out).toBe("done");
		const reply = proc.written.map((w) => JSON.parse(w)).find((m) => m.id === "agent-10");
		expect(reply).toMatchObject({
			jsonrpc: "2.0",
			error: { code: -32602, message: "no matching permission option" },
		});
	});

	it("delivers agent notifications to onNotification", async () => {
		const seen: unknown[][] = [];
		const proc = makeFakeProc((msg, send) => {
			send({ jsonrpc: "2.0", method: "session/update", params: { update: "chunk" } });
			if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: "ok" });
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({
					argv: ["a"],
					spawnImpl: () => proc,
					onNotification: (method, params) => seen.push([method, params]),
				});
				return yield* rpc.request("m");
			}),
		);
		expect(out).toBe("ok");
		expect(seen).toEqual([["session/update", { update: "chunk" }]]);
	});

	it("ignores agent notifications when no onNotification is registered", async () => {
		const proc = makeFakeProc((msg, send) => {
			send({ jsonrpc: "2.0", method: "session/update", params: {} });
			if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: "ok" });
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* rpc.request("m");
			}),
		);
		expect(out).toBe("ok");
	});

	it("fails fast on an empty argv and wraps spawn throws", async () => {
		const e1 = await Effect.runPromise(Effect.flip(Effect.scoped(makeStdioRpc({ argv: [] }))));
		expect(e1.message).toBe("acp transport: empty spawn command");
		expect(e1.port).toBe("llm");
		const e1b = await Effect.runPromise(Effect.flip(Effect.scoped(makeStdioRpc({ argv: [""] }))));
		expect(e1b.message).toBe("acp transport: empty spawn command");
		const e2 = await Effect.runPromise(
			Effect.flip(
				Effect.scoped(
					makeStdioRpc({
						argv: ["boom"],
						spawnImpl: () => {
							throw new Error("no exec");
						},
					}),
				),
			),
		);
		expect(e2.message).toBe("acp transport: spawn boom failed: no exec");
		const e3 = await Effect.runPromise(
			Effect.flip(
				Effect.scoped(
					makeStdioRpc({
						argv: ["boom"],
						spawnImpl: () => {
							throw "raw"; // eslint-disable-line no-throw-literal
						},
					}),
				),
			),
		);
		expect(e3.message).toBe("acp transport: spawn boom failed: raw");
	});

	it("fails typed when stdin rejects a request write", async () => {
		const proc = makeFakeProc();
		(proc.stdin as { write: (chunk: string) => void }).write = () => {
			throw new Error("EPIPE");
		};
		const err = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				return yield* Effect.flip(rpc.request("m"));
			}),
		);
		expect(err.message).toContain("stdin write failed: EPIPE");
	});

	it("swallows notify write failures (dead stdin) and writes them when alive", async () => {
		const proc = echoProc();
		await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				rpc.notify("session/cancel", { sessionId: "s" });
				expect(JSON.parse(proc.written.at(-1)!)).toMatchObject({
					jsonrpc: "2.0",
					method: "session/cancel",
					params: { sessionId: "s" },
				});
				(proc.stdin as { write: (chunk: string) => void }).write = () => {
					throw new Error("EPIPE");
				};
				rpc.notify("session/cancel"); // no params + dead stdin — silent
				return undefined;
			}),
		);
	});

	it("drops the pending entry when the request is interrupted", async () => {
		const proc = makeFakeProc((msg, send) => {
			// Answer only the SECOND call — the first times out; when its
			// late reply lands the dropped pending entry ignores it.
			if (msg.method === "second") send({ jsonrpc: "2.0", id: msg.id, result: "late-ok" });
		});
		const out = await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				const slow = yield* Effect.flip(rpc.request("first").pipe(Effect.timeout("30 millis")));
				expect(slow._tag).toBe("TimeoutError");
				proc.emitOut('{"jsonrpc":"2.0","id":"req-1","result":"too-late"}\n');
				return yield* rpc.request("second");
			}),
		);
		expect(out).toBe("late-ok");
	});

	it("kills the process and closes stdin on scope release", async () => {
		const proc = echoProc();
		let ended = false;
		(proc.stdin as { end?: () => void }).end = () => {
			ended = true;
		};
		await scoped(
			Effect.gen(function* () {
				const rpc = yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
				yield* rpc.request("m");
			}),
		);
		expect(proc.killed()).toBe(true);
		expect(ended).toBe(true);
	});

	it("tolerates a process without stdin.end", async () => {
		const proc = makeFakeProc(undefined, { noEnd: true });
		await scoped(
			Effect.gen(function* () {
				yield* makeStdioRpc({ argv: ["a"], spawnImpl: () => proc });
			}),
		);
		expect(proc.killed()).toBe(true);
	});
});
