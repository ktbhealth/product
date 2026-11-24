/**
 * acp-llm.ts — `LlmPort` over an ACP session transport (F3b extraction
 * from @ktb/ai-adapter-node's llm.ts). Shared by the spawned-agent
 * driver (stdio over child/ssh) and the bridge driver (held WebSocket
 * through the AcpBridge durable object).
 *
 * Each generate/correct call opens a fresh session — connect →
 * initialize → session/new → session/prompt — inside `Effect.scoped`,
 * so scoped transports (a spawned process) are released per call and a
 * hung or crashed agent can't leak between calls. The agent's reply
 * text validates against the envelope's declared `outputSchema`
 * through the same validator registry the ws (task.submit) adapter
 * uses; `correct` pins `EditList` and parses the reply as JSON before
 * decoding.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { PortError, type RunRecord, type TaskEnvelope } from "@ktb/eval-core";
import {
	CORRECTOR_INSTRUCTIONS,
	fnvHex,
	LlmPort,
	outputValidators,
	type EditList,
} from "@ktb/eval-consultation";

import { openAcpSession, type AcpClient, type AcpRpc } from "./acp-client.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

const causeMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const fail = (message: string, cause?: unknown) => new PortError({ port: "llm", message, cause });

export interface AcpSessionLlmOptions {
	/** Transport factory — receives the session's notification sink
	 * (see `openAcpSession`). Scoped transports (spawned processes)
	 * release on call teardown; scope-free ones (bridge) just succeed. */
	readonly connect: (
		onNotification: (method: string, params: unknown) => void,
	) => Effect.Effect<AcpRpc, PortError, Scope.Scope>;
	readonly cwd?: string;
	readonly sessionId?: string;
	/** Per-request timeout inside the ACP session (default 60_000). */
	readonly timeoutMs?: number;
	/** PHI egress declaration — a spawned agent still calls its provider
	 * API, so default `true`; set `false` only for a fully on-box agent. */
	readonly egress?: boolean;
	/** Engine label recorded on every RunRecord (e.g. "acp-node",
	 * "acp-bridge") — also the default `runId` when sessionId is unset. */
	readonly engine: string;
	readonly engineVersion?: string;
}

/** Open a session, run one prompt turn, return the agent's text. */
const promptText = (
	opts: AcpSessionLlmOptions,
	envelope: TaskEnvelope,
	stage: string,
): Effect.Effect<{ text: string; record: RunRecord }, PortError> => {
	const started = Date.now();
	return Effect.scoped(
		Effect.gen(function* () {
			const client: AcpClient = yield* openAcpSession({
				connect: opts.connect,
				...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
				...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
			});
			return yield* client.prompt(envelope.input);
		}),
	).pipe(
		Effect.map((text) => ({
			text,
			record: {
				runId: opts.sessionId ?? opts.engine,
				taskId: envelope.taskId,
				stage,
				engine: opts.engine,
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

/** LlmPort over an ACP session transport. `generate` validates the
 * agent's text against the envelope's declared `outputSchema` through
 * the validator registry; `correct` pins `EditList` and parses the
 * reply as JSON before decoding. */
export const makeAcpSessionLlm = (opts: AcpSessionLlmOptions): Layer.Layer<LlmPort> =>
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
				return promptText(
					opts,
					{ ...envelope, input: `${CORRECTOR_INSTRUCTIONS}\n\n${envelope.input}` },
					"cleanup",
				).pipe(
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
