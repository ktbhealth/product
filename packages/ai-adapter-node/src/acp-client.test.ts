import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import { openAcpSession as sharedOpenAcpSession } from "@ktb/ai-adapter-acp";

import { openAcpSession } from "./acp-client.ts";
import { makeStdioRpc, type SpawnedProcess } from "./stdio-rpc.ts";

// Spy on the two delegation boundaries (call-through wrappers) so tests
// can assert which option keys were forwarded — an explicit
// `key: undefined` is observable here even though downstream `??` /
// `!== undefined` guards treat it like an absent key.
vi.mock("@ktb/ai-adapter-acp", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/ai-adapter-acp")>();
	return { ...actual, openAcpSession: vi.fn(actual.openAcpSession) };
});
vi.mock("./stdio-rpc.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./stdio-rpc.ts")>();
	return { ...actual, makeStdioRpc: vi.fn(actual.makeStdioRpc) };
});

interface FakeProc extends SpawnedProcess {
	readonly written: string[];
	readonly frames: Record<string, unknown>[];
}

/** Fake ACP agent on the other end of stdio: parses stdin frames and
 * answers via scripted `onLine` stdout replies. */
const makeFakeProc = (
	onLine?: (msg: Record<string, unknown>, send: (o: unknown) => void) => void,
): FakeProc => {
	const written: string[] = [];
	const frames: Record<string, unknown>[] = [];
	const outHandlers: ((chunk: string | Uint8Array) => void)[] = [];
	const evtHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
	let lineBuf = "";
	const send = (o: unknown) => {
		for (const h of outHandlers) h(`${JSON.stringify(o)}\n`);
	};
	return {
		written,
		frames,
		stdin: {
			write: (chunk) => {
				written.push(chunk);
				lineBuf += chunk;
				const lines = lineBuf.split("\n");
				lineBuf = lines.pop()!;
				for (const line of lines) {
					if (line.trim() === "") continue;
					const msg = JSON.parse(line) as Record<string, unknown>;
					frames.push(msg);
					onLine?.(msg, send);
				}
			},
			end: () => {},
		},
		stdout: {
			on: (_event, listener) => {
				outHandlers.push(listener);
			},
		},
		on: (event, listener) => {
			evtHandlers.set(event, [...(evtHandlers.get(event) ?? []), listener]);
		},
		kill: () => {},
	};
};

type PromptScript = (msg: Record<string, unknown>, send: (o: unknown) => void) => void;

/** Scripted agent: initialize → session/new → session/prompt; per-call
 * `onPrompt` customizes the prompt turn (chunks, errors, silence). */
const agentProc = (
	onPrompt?: PromptScript,
	opts?: { readonly sessionId?: unknown },
): { proc: FakeProc; spawnImpl: () => FakeProc } => {
	const proc = makeFakeProc((msg, send) => {
		if (msg.method === "initialize") {
			send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
		} else if (msg.method === "session/new") {
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result:
					opts?.sessionId === undefined
						? { sessionId: "sess-fake" }
						: { sessionId: opts.sessionId },
			});
		} else if (msg.method === "session/prompt") {
			(onPrompt ?? defaultPrompt)(msg, send);
		}
	});
	return { proc, spawnImpl: () => proc };
};

const defaultPrompt: PromptScript = (msg, send) => {
	send({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "sess-fake",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "real-reply" },
			},
		},
	});
	send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
};

const scoped = <A>(eff: Effect.Effect<A, unknown, import("effect/Scope").Scope>) =>
	Effect.runPromise(Effect.scoped(eff));

describe("openAcpSession", () => {
	it("handshakes initialize + session/new and returns the session id", async () => {
		const { proc, spawnImpl } = agentProc();
		const sessionId = await scoped(
			Effect.map(openAcpSession({ argv: ["agent"], cwd: "/work", spawnImpl }), (c) => c.sessionId),
		);
		expect(sessionId).toBe("sess-fake");
		const init = proc.frames.find((f) => f.method === "initialize");
		expect(init).toMatchObject({
			params: {
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			},
		});
		const newSession = proc.frames.find((f) => f.method === "session/new");
		expect(newSession).toMatchObject({ params: { cwd: "/work", mcpServers: [] } });
	});

	it("defaults cwd to process.cwd() and concatenates message chunks", async () => {
		const { proc, spawnImpl } = agentProc((msg, send) => {
			for (const text of ["one-", "two"]) {
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: "sess-fake",
						update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
					},
				});
			}
			send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
		});
		const text = await scoped(
			Effect.flatMap(openAcpSession({ argv: ["agent"], spawnImpl }), (c) => c.prompt("hi")),
		);
		expect(text).toBe("one-two");
		const newSession = proc.frames.find((f) => f.method === "session/new");
		expect(newSession).toMatchObject({ params: { cwd: process.cwd() } });
	});

	it("ignores non-text updates and unrelated notifications", async () => {
		const { spawnImpl } = agentProc((msg, send) => {
			const noisy: unknown[] = [
				// thought chunks are not the reply
				{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
				// non-text content
				{ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x" } },
				// text content carrying no text field
				{ sessionUpdate: "agent_message_chunk", content: { type: "text" } },
				// an update of another kind entirely
				{ sessionUpdate: "plan" },
			];
			for (const update of noisy) {
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: { sessionId: "sess-fake", update },
				});
			}
			// A notification that isn't session/update at all.
			send({ jsonrpc: "2.0", method: "agent/status", params: { busy: true } });
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: "sess-fake",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "answer" },
					},
				},
			});
			send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
		});
		const text = await scoped(
			Effect.flatMap(openAcpSession({ argv: ["agent"], spawnImpl }), (c) => c.prompt("hi")),
		);
		expect(text).toBe("answer");
	});

	it("fails when session/new returns no sessionId", async () => {
		const { spawnImpl } = agentProc(undefined, { sessionId: 42 });
		const err = await scoped(Effect.flip(openAcpSession({ argv: ["agent"], spawnImpl })));
		expect(err.message).toContain("session/new");
	});

	it("sends session/cancel when the prompt turn fails", async () => {
		const { proc, spawnImpl } = agentProc((msg, send) => {
			send({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "overloaded" } });
		});
		const err = await scoped(
			Effect.flip(
				Effect.flatMap(openAcpSession({ argv: ["agent"], spawnImpl }), (c) => c.prompt("hi")),
			),
		);
		expect(err.message).toContain("overloaded");
		expect(proc.frames.some((f) => f.method === "session/cancel")).toBe(true);
	});

	it("omits unset options when delegating to the shared session and transport", async () => {
		// No spawnImpl/cwd/timeoutMs — the empty argv fails inside
		// makeStdioRpc, but both delegation boundaries are still invoked
		// and their option objects recorded.
		await scoped(
			Effect.gen(function* () {
				yield* Effect.flip(openAcpSession({ argv: [] }));
			}),
		);
		const sessionOpts = vi.mocked(sharedOpenAcpSession).mock.calls.at(-1)![0];
		expect("cwd" in sessionOpts).toBe(false);
		expect("timeoutMs" in sessionOpts).toBe(false);
		const rpcOpts = vi.mocked(makeStdioRpc).mock.calls.at(-1)![0];
		expect("spawnImpl" in rpcOpts).toBe(false);
	});

	it("fails typed on an empty argv without a spawnImpl override", async () => {
		// No spawnImpl → the wrapper delegates to the real lazy
		// node:child_process import; the empty-command guard trips
		// before anything actually spawns.
		const err = await scoped(Effect.flip(openAcpSession({ argv: [] })));
		expect(err.message).toContain("empty spawn command");
	});

	it("times out a hanging prompt and cancels the turn", async () => {
		// The agent never replies to session/prompt.
		const { proc, spawnImpl } = agentProc(() => {});
		const err = await scoped(
			Effect.flip(
				Effect.flatMap(openAcpSession({ argv: ["agent"], spawnImpl, timeoutMs: 30 }), (c) =>
					c.prompt("hi"),
				),
			),
		);
		expect(err.message).toContain("session/prompt");
		expect(err.message).toContain("timeout");
		expect(proc.frames.some((f) => f.method === "session/cancel")).toBe(true);
	});
});
