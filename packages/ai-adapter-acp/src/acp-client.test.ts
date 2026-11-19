import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { PortError } from "@ktb/eval-core";

import { openAcpSession, type AcpRpc } from "./acp-client.ts";

type OnNotification = (method: string, params: unknown) => void;

/** A scripted transport: records calls, replies per method and can
 * emit notifications at controlled points. */
const scriptedRpc = (opts: {
	readonly results?: Record<string, unknown>;
	readonly onRequest?: (method: string, params: unknown, notify: OnNotification) => void;
	readonly connectError?: PortError;
}) => {
	const calls: { method: string; params: unknown }[] = [];
	const notifications: { method: string; params: unknown }[] = [];
	let sink: OnNotification = () => {};
	const self: {
		rpc_override_request?: (m: string, p?: unknown) => Effect.Effect<unknown, PortError>;
	} = {};
	const rpc: AcpRpc = {
		request: (method, params) => {
			calls.push({ method, params });
			opts.onRequest?.(method, params, sink);
			if (self.rpc_override_request) return self.rpc_override_request(method, params);
			return Effect.succeed(opts.results?.[method]);
		},
		notify: (method, params) => {
			notifications.push({ method, params });
		},
	};
	return {
		calls,
		notifications,
		get rpc_override_request() {
			return self.rpc_override_request;
		},
		set rpc_override_request(v) {
			self.rpc_override_request = v;
		},
		connect: (onNotification: OnNotification) => {
			sink = onNotification;
			return opts.connectError === undefined ? Effect.succeed(rpc) : Effect.fail(opts.connectError);
		},
	};
};

const fail = (m: string) => new PortError({ port: "llm", message: m });

const open = (rpc: ReturnType<typeof scriptedRpc>, opts: Record<string, unknown> = {}) =>
	Effect.runPromise(
		Effect.scoped(
			openAcpSession({
				connect: rpc.connect,
				cwd: "/w",
				...opts,
			}),
		),
	);

describe("openAcpSession", () => {
	it("runs initialize → session/new and returns a session client", async () => {
		const rpc = scriptedRpc({ results: { "session/new": { sessionId: "s-1" } } });
		const client = await open(rpc);
		expect(client.sessionId).toBe("s-1");
		expect(rpc.calls.map((c) => c.method)).toEqual(["initialize", "session/new"]);
		expect(rpc.calls[0]!.params).toMatchObject({
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
		});
		expect(rpc.calls[1]!.params).toMatchObject({ cwd: "/w", mcpServers: [] });
	});

	it("fails when session/new resolves without a result object", async () => {
		const rpc = scriptedRpc({ results: {} });
		await expect(open(rpc)).rejects.toMatchObject({
			_tag: "PortError",
			port: "llm",
			message: expect.stringContaining("sessionId"),
		});
	});

	it("fails when session/new carries no sessionId", async () => {
		const rpc = scriptedRpc({ results: { "session/new": {} } });
		await expect(open(rpc)).rejects.toMatchObject({
			_tag: "PortError",
			port: "llm",
			message: expect.stringContaining("sessionId"),
		});
	});

	it("fails when connect fails", async () => {
		const rpc = scriptedRpc({ connectError: fail("spawn died") });
		await expect(open(rpc)).rejects.toMatchObject({
			port: "llm",
			message: "spawn died",
		});
	});

	it("accumulates agent_message_chunk text during prompt", async () => {
		const rpc = scriptedRpc({
			results: { "session/new": { sessionId: "s-1" }, "session/prompt": {} },
			onRequest: (method, _params, notify) => {
				if (method !== "session/prompt") return;
				notify("session/update", {
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "hello " },
					},
				});
				notify("session/update", {
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "world" },
					},
				});
				// Non-text and unrelated notifications are ignored.
				notify("session/update", {
					update: { sessionUpdate: "agent_message_chunk", content: { type: "image" } },
				});
				notify("session/other", { update: { sessionUpdate: "agent_message_chunk" } });
				// Every malformed shape must be skipped, not crash or leak:
				// another method carrying a full chunk payload, a missing
				// update, a missing content, a non-string text and no params.
				notify("session/other", {
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "BAD" },
					},
				});
				notify("session/update", {});
				notify("session/update");
				notify("session/update", {
					update: { sessionUpdate: "agent_message_chunk" },
				});
				notify("session/update", {
					update: { sessionUpdate: "agent_message_chunk", content: null },
				});
				notify("session/update", {
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: 42 },
					},
				});
				notify("session/update", {
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: "think" },
					},
				});
			},
		});
		const client = await open(rpc);
		const text = await Effect.runPromise(client.prompt("hi"));
		expect(text).toBe("hello world");
		expect(rpc.calls[2]!.params).toMatchObject({
			sessionId: "s-1",
			prompt: [{ type: "text", text: "hi" }],
		});
	});

	it("sends session/cancel when the prompt fails", async () => {
		const rpc = scriptedRpc({});
		rpc.rpc_override_request = (m: string, p?: unknown) =>
			m === "session/prompt"
				? Effect.fail(fail("turn died"))
				: Effect.succeed(m === "session/new" ? { sessionId: "s-2" } : undefined);
		const client = await open(rpc);
		await expect(Effect.runPromise(client.prompt("x"))).rejects.toMatchObject({
			message: "turn died",
		});
		expect(rpc.notifications).toContainEqual({
			method: "session/cancel",
			params: { sessionId: "s-2" },
		});
	});

	it("times out a hung request as a PortError", async () => {
		const hanging = (onNotification: OnNotification) =>
			Effect.succeed({
				request: (method: string) =>
					method === "session/new" ? Effect.succeed({ sessionId: "s-3" }) : Effect.never,
				notify: () => {},
			} as AcpRpc);
		await expect(
			Effect.runPromise(Effect.scoped(openAcpSession({ connect: hanging, timeoutMs: 5 }))),
		).rejects.toMatchObject({ _tag: "PortError", message: expect.stringContaining("timeout") });
	});
});
