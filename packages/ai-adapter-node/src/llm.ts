/**
 * llm.ts — `LlmPort` over a real ACP agent process (F3a).
 *
 * `child` spawns the endpoint's `agentCmd` locally; `ssh` runs the same
 * command on `sshHost` through `ssh <host> <cmd>`. Each generate/correct
 * call opens a fresh session — spawn → initialize → session/new →
 * session/prompt — and the scope teardown kills the process, so a hung
 * or crashed agent can't leak between calls. The `ws` HTTP transport
 * and the `task.submit` wire format belong to @ktb/ai-adapter-acp.
 *
 * Runtime gate: this package is an adapter — platform APIs are allowed —
 * but it can only spawn under Node/Bun. Under workerd `process` is
 * absent (or `node:child_process` unusable) and resolution fails as a
 * typed PortError, same contract as before the split.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PortError, type RunRecord, type TaskEnvelope } from "@ktb/eval-core";
import {
	fnvHex,
	LlmPort,
	outputValidators,
	type EditList,
	type LlmEndpointDescriptor,
} from "@ktb/eval-consultation";

import { openAcpSession } from "./acp-client.ts";
import type { SpawnImpl } from "./stdio-rpc.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

const causeMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

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
}

/** Spawn a session, run one prompt turn, return the agent's text. */
const promptText = (
	opts: NodeAcpLlmOptions,
	envelope: TaskEnvelope,
	stage: string,
): Effect.Effect<{ text: string; record: RunRecord }, PortError> => {
	const started = Date.now();
	return Effect.scoped(
		Effect.gen(function* () {
			const client = yield* openAcpSession({
				argv: opts.argv,
				...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
				...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
				...(opts.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
			});
			return yield* client.prompt(envelope.input);
		}),
	).pipe(
		Effect.map((text) => ({
			text,
			record: {
				runId: opts.sessionId ?? "acp-node",
				taskId: envelope.taskId,
				stage,
				engine: "acp-node",
				model: envelope.modelHint,
				...(opts.engineVersion !== undefined ? { engineVersion: opts.engineVersion } : {}),
				inputHash: fnvHex(
					`${envelope.taskId}:${envelope.outputSchema}:${envelope.input}:${envelope.seed ?? 0}`,
				),
				seed: envelope.seed,
				startedAt: started,
				latencyMs: Date.now() - started,
			},
		})),
	);
};

/** LlmPort over a spawned ACP agent. `generate` validates the agent's
 * text against the envelope's declared `outputSchema` through the same
 * validator registry the ws adapter uses; `correct` pins `EditList`
 * and parses the agent's reply as JSON before decoding. */
export const makeNodeAcpLlm = (opts: NodeAcpLlmOptions): Layer.Layer<LlmPort> =>
	Layer.succeed(
		LlmPort,
		LlmPort.of({
			egress: opts.egress ?? true,
			generate: (envelope) =>
				promptText(opts, envelope, "script_gen").pipe(
					Effect.flatMap(({ text, record }) => {
						const validator = outputValidators[envelope.outputSchema];
						if (validator === undefined) {
							return Effect.fail(fail(`unknown outputSchema: ${envelope.outputSchema}`));
						}
						return Effect.try({
							try: () => validator(text),
							catch: (e) =>
								fail(`payload failed ${envelope.outputSchema} validation: ${causeMessage(e)}`, e),
						}).pipe(
							Effect.flatMap((payload) => {
								// Whatever schema the envelope declared validated
								// the payload, but it must still be a string —
								// never cast an object into a lie.
								if (typeof payload !== "string") {
									return Effect.fail(
										fail(
											`generate requires a string payload, ${envelope.outputSchema} produced ${typeof payload}`,
										),
									);
								}
								return Effect.succeed({ text: payload, record });
							}),
						);
					}),
				),
			correct: (envelope) => {
				if (envelope.outputSchema !== "EditList") {
					return Effect.fail(
						fail(`cleanup requires outputSchema=EditList, got ${envelope.outputSchema}`),
					);
				}
				return promptText(opts, envelope, "cleanup").pipe(
					Effect.flatMap(({ text, record }) =>
						Effect.try({
							// The agent's reply text is the EditList JSON —
							// parse then schema-decode; either failure is one
							// typed PortError.
							try: () => outputValidators.EditList(JSON.parse(text)) as EditList,
							catch: (e) => fail(`payload failed EditList validation: ${causeMessage(e)}`, e),
						}).pipe(Effect.map((edits) => ({ edits, record }))),
					),
				);
			},
		}),
	);

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
			fail(`acp ${transport} endpoints require agentCmd (e.g. "claude agent acp")`),
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
			...(d.sessionId !== undefined ? { sessionId: d.sessionId } : {}),
			timeoutMs: d.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			engineVersion: fnvHex(`child:${agentCmd}`),
			...(opts?.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
		}),
	);
};
