/**
 * acp-client.ts — spawn-flavored entry to the shared ACP session
 * client (moved to @ktb/ai-adapter-acp in F3b): this wrapper builds
 * the stdio JSON-RPC transport for `argv` and delegates the
 * `initialize` → `session/new` → `session/prompt` handshake to the
 * shared `openAcpSession`. Kept so existing callers/tests keep one
 * import path — the ACP semantics themselves are transport-agnostic.
 */

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { openAcpSession as openAcpSessionOver, type AcpClient } from "@ktb/ai-adapter-acp";
import { PortError } from "@ktb/eval-core";

import { makeStdioRpc, type SpawnImpl } from "./stdio-rpc.ts";

export type { AcpClient } from "@ktb/ai-adapter-acp";

export interface AcpSessionOptions {
	readonly argv: readonly string[];
	/** Working directory reported in `session/new` — agents resolve
	 * relative file paths against it. */
	readonly cwd?: string;
	/** Per-request timeout (initialize, session/new, session/prompt). */
	readonly timeoutMs?: number;
	readonly spawnImpl?: SpawnImpl;
}

/** Spawn the agent, run the ACP handshake and return a session client.
 * Scoped — releasing the scope kills the agent process. */
export const openAcpSession = (
	opts: AcpSessionOptions,
): Effect.Effect<AcpClient, PortError, Scope.Scope> =>
	openAcpSessionOver({
		connect: (onNotification) =>
			makeStdioRpc({
				argv: opts.argv,
				...(opts.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
				onNotification,
			}),
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
	});
