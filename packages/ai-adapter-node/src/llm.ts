/**
 * llm.ts — `LlmPort` over a real ACP agent process (F3a).
 *
 * `child` spawns the endpoint's `agentCmd` locally; `ssh` runs the same
 * command on `sshHost` through `ssh <host> <cmd>`. Each generate/correct
 * call opens a fresh session — spawn → initialize → session/new →
 * session/prompt — and the scope teardown kills the process, so a hung
 * or crashed agent can't leak between calls. The `ws` HTTP transport
 * and the `task.submit` wire format belong to @ktb/ai-adapter-acp; the
 * session-level LlmPort logic moved there in F3b
 * (`makeAcpSessionLlm`), this file only supplies the spawned
 * transport and the descriptor dispatch.
 *
 * Runtime gate: this package is an adapter — platform APIs are allowed —
 * but it can only spawn under Node/Bun. Under workerd `process` is
 * absent (or `node:child_process` unusable) and resolution fails as a
 * typed PortError, same contract as before the split.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeAcpSessionLlm } from "@ktb/ai-adapter-acp";
import { PortError } from "@ktb/eval-core";
import { fnvHex, LlmPort, type LlmEndpointDescriptor } from "@ktb/eval-consultation";

import type { SpawnImpl } from "./stdio-rpc.ts";
import { makeStdioRpc } from "./stdio-rpc.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

const fail = (message: string, cause?: unknown) => new PortError({ port: "llm", message, cause });

export interface NodeAcpLlmOptions {
	/** Spawn argv — already resolved by the caller (child: the parsed
	 * `agentCmd`; ssh: `["ssh", host, agentCmd]`). */
	readonly argv: readonly string[];
	readonly cwd?: string;
	readonly sessionId?: string;
	/** Per-request timeout inside the ACP session (default 60_000). */
	readonly timeoutMs?: number;
	/** PHI egress declaration — a spawned agent still calls its provider
	 * API, so default `true`; set `false` only for a fully on-box agent. */
	readonly egress?: boolean;
	readonly engineVersion?: string;
	readonly spawnImpl?: SpawnImpl;
	/** ACP `session/request_permission` policy for the spawned agent
	 * (see StdioRpcOptions). Default "refuse". */
	readonly permissionPolicy?: "allow" | "reject" | "refuse";
}

/** LlmPort over a spawned ACP agent — the stdio transport plugged
 * into the shared session port. */
export const makeNodeAcpLlm = (opts: NodeAcpLlmOptions): Layer.Layer<LlmPort> =>
	makeAcpSessionLlm({
		connect: (onNotification) =>
			makeStdioRpc({
				argv: opts.argv,
				...(opts.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
				...(opts.permissionPolicy !== undefined
					? { permissionPolicy: opts.permissionPolicy }
					: {}),
				onNotification,
			}),
		engine: "acp-node",
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
		...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		...(opts.egress !== undefined ? { egress: opts.egress } : {}),
		...(opts.engineVersion !== undefined ? { engineVersion: opts.engineVersion } : {}),
	});

const nodeOnly = (transport: string) =>
	fail(
		`acp transport ${transport} requires a Node/Bun runtime — @ktb/ai-adapter-node cannot spawn under workerd`,
	);

/** Resolve an `acp` endpoint descriptor to a bound LlmPort layer —
 * the child/ssh half of the factory's dispatch. `ws` descriptors are
 * @ktb/ai-adapter-acp's job and fail loudly if they land here. */
export const resolveNodeAcp = (
	d: LlmEndpointDescriptor,
	opts?: { readonly spawnImpl?: SpawnImpl },
): Effect.Effect<Layer.Layer<LlmPort>, PortError> => {
	const transport = d.transport ?? "ws";
	if (transport === "ws") {
		return Effect.fail(
			fail("acp transport ws is served by @ktb/ai-adapter-acp (http), not a spawned agent"),
		);
	}
	if (typeof process === "undefined") {
		return Effect.fail(nodeOnly(transport));
	}
	const agentCmd = d.agentCmd?.trim();
	if (agentCmd === undefined || agentCmd === "") {
		return Effect.fail(
			fail(`acp ${transport} endpoints require agentCmd (e.g. "claude-agent-acp")`),
		);
	}
	if (transport === "ssh") {
		const host = d.sshHost?.trim();
		if (host === undefined || host === "") {
			return Effect.fail(fail("acp ssh endpoints require sshHost (user@host)"));
		}
		return Effect.succeed(
			makeNodeAcpLlm({
				argv: ["ssh", host, agentCmd],
				// Stryker disable next-line ConditionalExpression: `{sessionId: undefined}` hits `opts.sessionId ?? opts.engine` downstream — identical to omitting the key
				...(d.sessionId !== undefined ? { sessionId: d.sessionId } : {}),
				timeoutMs: d.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				engineVersion: fnvHex(`ssh:${host}:${agentCmd}`),
				...(opts?.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
			}),
		);
	}
	return Effect.succeed(
		makeNodeAcpLlm({
			// Command lines split on whitespace — quote-quoted arguments
			// need the ssh form or a wrapper script on PATH.
			argv: agentCmd.split(/\s+/),
			// Stryker disable next-line ConditionalExpression: `{sessionId: undefined}` hits `opts.sessionId ?? opts.engine` downstream — identical to omitting the key
			...(d.sessionId !== undefined ? { sessionId: d.sessionId } : {}),
			timeoutMs: d.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			engineVersion: fnvHex(`child:${agentCmd}`),
			...(opts?.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
		}),
	);
};
