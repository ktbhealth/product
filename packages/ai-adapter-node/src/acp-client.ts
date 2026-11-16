/**
 * acp-client.ts — minimal Agent Client Protocol session over the
 * stdio JSON-RPC plumbing: `initialize` → `session/new` →
 * `session/prompt` (the reply text accumulates from
 * `agent_message_chunk` `session/update` notifications until the
 * prompt call returns) → `session/cancel` on abort.
 *
 * Deliberately lean (F3a): no auth, no tool-call streaming, no MCP
 * servers — the full client lands in F3b. Agent→client requests
 * (fs/permissions/terminals) are refused by the transport layer.
 */

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { PortError } from "@ktb/eval-core";

import { makeStdioRpc, type SpawnImpl } from "./stdio-rpc.ts";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60_000;

const fail = (message: string, cause?: unknown) => new PortError({ port: "llm", message, cause });

export interface AcpSessionOptions {
	readonly argv: readonly string[];
	/** Working directory reported in `session/new` — agents resolve
	 * relative file paths against it. */
	readonly cwd?: string;
	/** Per-request timeout (initialize, session/new, session/prompt). */
	readonly timeoutMs?: number;
	readonly spawnImpl?: SpawnImpl;
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

/** Spawn the agent, run the ACP handshake and return a session client.
 * Scoped — releasing the scope kills the agent process. */
export const openAcpSession = (
	opts: AcpSessionOptions,
): Effect.Effect<AcpClient, PortError, Scope.Scope> =>
	Effect.gen(function* () {
		const chunks: string[] = [];
		const rpc = yield* makeStdioRpc({
			argv: opts.argv,
			...(opts.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
			onNotification: (method, params) => {
				if (method !== "session/update") return;
				const update = (params as SessionUpdateParams | undefined)?.update;
				if (
					update?.sessionUpdate === "agent_message_chunk" &&
					update.content?.type === "text" &&
					typeof update.content.text === "string"
				) {
					chunks.push(update.content.text);
				}
			},
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
					: /* v8 ignore next -- workerd never reaches spawn (spawnImpl gate) */ "/"),
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
						// (best-effort; the process may already be dead).
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
