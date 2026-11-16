/**
 * llm.ts — LlmPort over an ACP session (T-104).
 *
 * The adapter serializes `TaskEnvelope`s to the frozen wire format and
 * validates every response against the envelope's DECLARED
 * `outputSchema` via the validator registry — a misbehaving agent
 * produces typed PortErrors, never silent garbage. `generate()` trusts
 * the declared contract (any registered string-producing schema works)
 * and only requires the validated payload to be a string; `correct()`
 * pins `EditList` because the port must return a typed edit list.
 *
 * `transport` is the ONLY edge: inject the JSON-RPC send (stdio,
 * socket, in-process Devin ACP session). Session id is fixed per
 * layer — multi-session routing is a caller concern.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Driver } from "@ktb/driver-framework";

import { PortError, type RunRecord, type TaskEnvelope } from "@ktb/eval-core";
import {
	decodeTaskResult,
	encodeTask,
	fnvHex,
	LlmPort,
	type AcpRequest,
	type EditList,
} from "@ktb/eval-consultation";

import { makeHttpAcpTransport } from "./acp-transport.ts";

export type AcpTransport = (request: AcpRequest) => Effect.Effect<unknown, PortError>;

export interface AcpLlmOptions {
	readonly transport: AcpTransport;
	readonly sessionId?: string;
	/** Per-call timeout in ms. Default 60_000 — matches the local ASR
	 * adapter; agent sessions can be slow. */
	readonly timeoutMs?: number;
	/** PHI egress declaration — ACP sessions are typically remote
	 * agents, so default `true`. Set `false` for an in-process
	 * transport. The pipeline only sends scrubbed text regardless. */
	readonly egress?: boolean;
	/** Engine-version signal recorded on every RunRecord (P-076) —
	 * the composition root passes an opaque endpoint hash (e.g.
	 * fnvHex(EVAL_ACP_URL)) since the transport hides the endpoint. */
	readonly engineVersion?: string;
}

const call = (
	opts: AcpLlmOptions,
	envelope: TaskEnvelope,
	stage: string,
	expectedSchema?: string,
): Effect.Effect<{ payload: unknown; record: RunRecord }, PortError> => {
	const started = Date.now();
	// Methods with a typed return pin the contract up front: correct()
	// speaks EditList. generate() is schema-agnostic — the envelope's
	// declared outputSchema selects the validator dynamically.
	if (expectedSchema !== undefined && envelope.outputSchema !== expectedSchema) {
		return Effect.fail(
			new PortError({
				port: "llm",
				message: `${stage} requires outputSchema=${expectedSchema}, got ${envelope.outputSchema}`,
			}),
		);
	}
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const guarded = opts.transport(encodeTask(envelope, opts.sessionId)).pipe(
		Effect.timeout(`${timeoutMs} millis`),
		Effect.mapError((e) =>
			e instanceof PortError
				? e
				: new PortError({
						port: "llm",
						message: `timeout after ${timeoutMs}ms`,
						cause: e,
					}),
		),
	);
	return guarded.pipe(
		Effect.flatMap((response) =>
			Effect.try({
				try: () => decodeTaskResult({ response, envelope }),
				// decodeTaskResult only throws PortError by construction
				catch: (e) => e as PortError,
			}),
		),
		Effect.map((payload) => ({
			payload,
			record: {
				runId: opts.sessionId ?? "acp",
				taskId: envelope.taskId,
				stage,
				engine: "acp",
				model: envelope.modelHint,
				...(opts.engineVersion !== undefined ? { engineVersion: opts.engineVersion } : {}),
				// Content hash of the actual task input — dedupes reruns of
				// identical work without pretending taskId+seed is the
				// payload.
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

/**
 * Driver providing `LlmPort` for the eval validator (P-081): eligible
 * only when the workspace env wires an ACP endpoint —
 * `EVAL_ACP_URL`. Absent → no LlmPort bound → generation falls back
 * to the deterministic template renderer.
 */
export interface EvalLlmEnv {
	readonly EVAL_ACP_URL?: string;
	readonly EVAL_ACP_SESSION_ID?: string;
	readonly EVAL_LLM_TIMEOUT_MS?: string;
}

export const evalLlmAcpDriver: Driver<EvalLlmEnv> = {
	id: "eval-llm-acp",
	port: LlmPort.key,
	when: (env) => Boolean(env.EVAL_ACP_URL),
	provides: (env) => {
		const url = env.EVAL_ACP_URL!;
		const parsedTimeout = Number(env.EVAL_LLM_TIMEOUT_MS);
		const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 60_000;
		return makeAcpLlm({
			transport: makeHttpAcpTransport(url, fetch, timeoutMs),
			sessionId: env.EVAL_ACP_SESSION_ID,
			timeoutMs,
			engineVersion: fnvHex(url),
		});
	},
};

export const makeAcpLlm = (opts: AcpLlmOptions): Layer.Layer<LlmPort> =>
	Layer.succeed(
		LlmPort,
		LlmPort.of({
			egress: opts.egress ?? true,
			generate: (envelope) =>
				call(opts, envelope, "script_gen").pipe(
					Effect.flatMap(({ payload, record }) => {
						// The port returns text: whatever schema the envelope
						// declared validated the payload, but it must still
						// be a string — never cast an object into a lie.
						if (typeof payload !== "string") {
							return Effect.fail(
								new PortError({
									port: "llm",
									message: `generate requires a string payload, ${envelope.outputSchema} produced ${typeof payload}`,
								}),
							);
						}
						return Effect.succeed({ text: payload, record });
					}),
				),
			correct: (envelope) =>
				call(opts, envelope, "cleanup", "EditList").pipe(
					Effect.map(({ payload, record }) => ({ edits: payload as EditList, record })),
				),
		}),
	);
