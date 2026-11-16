/**
 * acp-client.ts — minimal Agent Client Protocol session, transport-
 * agnostic (F3b extraction from @ktb/ai-adapter-node): `initialize` →
 * `session/new` → `session/prompt` (the reply text accumulates from
 * `agent_message_chunk` `session/update` notifications until the
 * prompt call returns) → `session/cancel` on abort.
 *
 * The transport is the caller's problem: `connect` builds an `AcpRpc`
 * (spawned stdio, held WebSocket through AcpBridge, anything that
 * moves JSON-RPC frames) and hands it the session's notification sink
 * so `session/update` chunks land in the prompt buffer regardless of
 * how the frames arrived. Scope/timeout semantics belong to the
 * transport — the session only speaks methods.
 *
 * Deliberately lean: no auth, no tool-call streaming, no MCP servers.
 * Agent→client requests (fs/permissions/terminals) are refused by the
 * transport layer (-32601).
 */

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { PortError } from "@ktb/eval-core";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60_000;

const fail = (message: string, cause?: unknown) => new PortError({ port: "llm", message, cause });

/** The narrow JSON-RPC surface an ACP transport provides: correlated
 * requests and best-effort notifications. `request` resolves to the
 * wire `result` and fails with PortError on transport death or agent
 * errors. */
export interface AcpRpc {
	readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, PortError>;
	/** Notifications are best-effort — a dead transport drops them
	 * silently (the session is already gone). */
	readonly notify: (method: string, params?: unknown) => void;
}

export interface AcpSessionOptions {
	/** Build the transport. Receives the session's notification sink —
	 * the transport MUST call it for every agent→client notification
	 * (`session/update` chunks land there), however they arrive
	 * (live frames, or flushed with a response over request/response
	 * links like the bridge DO). Scoped so spawned transports acquire
	 * their process here — a scope-free connect (bridge socket) just
	 * returns `Effect.succeed`. */
	readonly connect: (
		onNotification: (method: string, params: unknown) => void,
	) => Effect.Effect<AcpRpc, PortError, Scope.Scope>;
	/** Working directory reported in `session/new` — agents resolve
	 * relative file paths against it. */
	readonly cwd?: string;
	/** Per-request timeout (initialize, session/new, session/prompt). */
	readonly timeoutMs?: number;
}

export interface AcpClient {
	readonly sessionId: string;
	/** Send a text prompt; resolves to the concatenated
	 * `agent_message_chunk` text streamed while the turn ran. */
	readonly prompt: (text: string) => Effect.Effect<string, PortError>;
}

interface SessionUpdateParams {
	readonly update?: {
		readonly sessionUpdate?: string;
		readonly content?: { readonly type?: string; readonly text?: string };
	};
}

/** Connect the transport, run the ACP handshake and return a session
 * client. Scoped — releasing the scope tears down whatever `connect`
 * acquired (a spawned process; the bridge holds nothing). */
export const openAcpSession = (
	opts: AcpSessionOptions,
): Effect.Effect<AcpClient, PortError, Scope.Scope> =>
	Effect.gen(function* () {
		const chunks: string[] = [];
		const rpc = yield* opts.connect((method, params) => {
			if (method !== "session/update") return;
			const update = (params as SessionUpdateParams | undefined)?.update;
			if (
				update?.sessionUpdate === "agent_message_chunk" &&
				update.content?.type === "text" &&
				typeof update.content.text === "string"
			) {
				chunks.push(update.content.text);
			}
		});
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const call = (method: string, params?: unknown) =>
			rpc.request(method, params).pipe(
				Effect.timeout(`${timeoutMs} millis`),
				Effect.mapError((e) =>
					e instanceof PortError ? e : fail(`acp ${method}: timeout after ${timeoutMs}ms`, e),
				),
			);

		yield* call("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			// No client capabilities: the agent's fs/terminal requests get
			// -32601 from the transport and it must cope without them.
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
		});
		const created = (yield* call("session/new", {
			cwd:
				opts.cwd ??
				(typeof process !== "undefined"
					? process.cwd()
					: /* v8 ignore next -- workerd has no cwd; the agent resolves its own */ "/"),
			mcpServers: [],
		})) as { readonly sessionId?: unknown } | undefined;
		if (typeof created?.sessionId !== "string") {
			return yield* fail("acp session/new: response carried no sessionId");
		}
		const sessionId = created.sessionId;

		return {
			sessionId,
			prompt: (text) =>
				Effect.suspend(() => {
					chunks.length = 0;
					return call("session/prompt", {
						sessionId,
						prompt: [{ type: "text", text }],
					}).pipe(
						Effect.map(() => chunks.join("")),
						// A failed/timed-out turn must not leave the agent
						// running it in the background — tell it to stop
						// (best-effort; the transport may already be dead).
						Effect.catch((e) =>
							Effect.gen(function* () {
								rpc.notify("session/cancel", { sessionId });
								return yield* Effect.fail(e);
							}),
						),
					);
				}),
		};
	});
