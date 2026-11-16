import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { openAcpSession } from "./acp-client.ts";
import type { SpawnedProcess } from "./stdio-rpc.ts";

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
