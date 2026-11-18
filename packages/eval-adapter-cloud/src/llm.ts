/**
 * llm.ts — LlmPort + EvalPort over the Workers AI REST API (M4).
 *
 * Same transport as asr.ts — POST
 * {endpoint}/client/v4/accounts/{accountId}/ai/run/{model} — but with a
 * JSON chat body (`{messages: [...]}`) for text-generation models
 * (`@cf/...` instruct/chat models; the model id is a required option,
 * never a literal — adapter packages are the exempt edge for provider
 * ids, but pinning stays the caller's job so the benchmarked engine
 * is explicit).
 *
 * Response decoding accepts BOTH Workers AI result shapes seen across
 * model generations:
 *   - `{ result: { response: "..." } }`            (text-generation)
 *   - `{ result: { choices: [{ message: { content } }] } }` (chat)
 * Anything else is a typed PortError — a provider-side payload change
 * is never a silent wrong metric.
 *
 * TWO ports, ONE transport:
 *
 *   makeWorkersAiLlm — LlmPort: `generate` returns the model's text;
 *     `correct` pins outputSchema "EditList" (same contract as the ACP
 *     adapter) and JSON-decodes the reply into a reversible edit list.
 *     A malformed edit list is a typed PortError — the pipeline treats
 *     corrupt lists as an expected adapter failure (pipeline.ts).
 *
 *   makeWorkersAiEval — EvalPort: `judge` renders `state` + the typed
 *     EvalQuestions into ONE prompt and JSON-decodes the verdicts.
 *     This is a GENERATIVE stand-in for a decision model: answers are
 *     self-reported probabilities, not calibrated ones — `probability`
 *     is whatever the model claims (validated to [0,1], never trusted
 *     silently). For calibrated judging prefer a System One
 *     (local-systemone profile); this adapter exists so the cloud
 *     profile can complete a run end-to-end and the WER/entity metrics
 *     still measure a REAL model's output, with the judge's weakness
 *     visible in the record (engine `workers-ai:<model>`).
 *
 * PHI: LlmPort/EvalPort inputs are scrubbed upstream by the pipeline
 * (phi.ts); both ports declare `egress: true` like the remote ACP
 * adapter — the domain policy, not this file, owns the scrub-or-refuse
 * gate.
 */

import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schedule from "effect/Schedule";

import {
	EditList,
	EvalPort,
	PortError,
	type EvalAnswer,
	type EvalQuestion,
	type RunRecord,
	type TaskEnvelope,
} from "@ktb/eval-core";
import { LlmPort, fnvHex } from "@ktb/eval-consultation";

const failLlm = (message: string) => new PortError({ port: "llm", message });
const failEval = (message: string) => new PortError({ port: "eval", message });

export interface WorkersAiLlmOptions {
	readonly accountId: string;
	readonly apiToken: string;
	/** Provider model id (e.g. an instruct/chat `@cf/...` alias) —
	 * required, no hidden default: the caller pins the engine it
	 * benchmarks. One model serves BOTH factories; pick a model whose
	 * license/context fit the workload. */
	readonly model: string;
	/** Defaults to the public Workers AI API base. */
	readonly endpoint?: string;
	readonly fetchImpl?: typeof fetch;
	readonly timeoutMs?: number;
	/** Retry policy for transient 5xx/network failures. Default: none. */
	readonly retry?: Schedule.Schedule<unknown, PortError>;
}

interface ChatMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

/** Workers AI envelope — `success`/`errors`/`messages` are optionalKey
 * tolerant so an error payload still decodes and surfaces its own
 * detail (same contract as asr.ts). `result` accepts both known
 * text-generation response shapes. */
const WorkersAiChatResult = Schema.Struct({
	result: Schema.optionalKey(
		Schema.Union([
			Schema.Struct({ response: Schema.String }),
			Schema.Struct({
				choices: Schema.Array(
					Schema.Struct({
						message: Schema.Struct({ content: Schema.String }),
					}),
				),
			}),
		]),
	),
	success: Schema.Boolean,
	errors: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	messages: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

type ChatEnvelope = typeof WorkersAiChatResult.Type;

const decodeEnvelope = Schema.decodeUnknownSync(WorkersAiChatResult);
const decodeEditList = Schema.decodeUnknownSync(EditList);

const envelopeErrorDetail = (body: ChatEnvelope): string => {
	const detail = [...(body.errors ?? []), ...(body.messages ?? [])]
		.map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
		.filter((s) => s.length > 0)
		.join("; ")
		.slice(0, 300);
	return `workers-ai returned success=false${detail !== "" ? `: ${detail}` : ""}`;
};

const extractText = (result: NonNullable<ChatEnvelope["result"]>): string => {
	if ("response" in result) return result.response;
	const first = result.choices[0];
	if (first === undefined) {
		throw new Error("malformed response: success=true with empty choices");
	}
	return first.message.content;
};

/** One chat completion. Returns the assistant text or a PortError —
 * transport, envelope and extraction failures all collapse into the
 * caller's port name so `Effect.retry` policies see one error type. */
const chat = (
	opts: WorkersAiLlmOptions,
	port: "llm" | "eval",
	messages: readonly ChatMessage[],
): Effect.Effect<string, PortError> => {
	const fail = port === "llm" ? failLlm : failEval;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const endpoint = opts.endpoint ?? "https://api.cloudflare.com";
	const url = `${endpoint}/client/v4/accounts/${opts.accountId}/ai/run/${opts.model}`;

	const request = Effect.tryPromise({
		try: async () => {
			const res = await fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${opts.apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ messages }),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				throw new Error(`workers-ai ${res.status}: ${await res.text()}`);
			}
			return res.json() as Promise<unknown>;
		},
		catch: (e) => fail(e instanceof Error ? e.message : String(e)),
	}).pipe(
		Effect.withSpan("llm.chat", {
			attributes: { "llm.model": opts.model },
		}),
		Effect.timeout(`${timeoutMs} millis`),
		Effect.mapError((e) => (e instanceof PortError ? e : fail(`timeout after ${timeoutMs}ms`))),
		Effect.flatMap((body) =>
			Effect.try({
				try: () => decodeEnvelope(body),
				catch: (e) => fail(`malformed response: ${String(e).slice(0, 200)}`),
			}),
		),
		Effect.flatMap((body) => {
			if (!body.success) {
				return Effect.fail(fail(envelopeErrorDetail(body)));
			}
			if (body.result === undefined) {
				return Effect.fail(fail("malformed response: success=true without result"));
			}
			return Effect.try({
				try: () => extractText(body.result as NonNullable<ChatEnvelope["result"]>),
				catch: (e) =>
					fail(
						e instanceof Error
							? e.message
							: /* v8 ignore next -- extractText only throws Error */ String(e),
					),
			});
		}),
	);

	return (
		opts.retry !== undefined ? request.pipe(Effect.retry({ schedule: opts.retry })) : request
	).pipe(Effect.mapError((e) => (port === "llm" ? failLlm(e.message) : failEval(e.message))));
};

const recordFor = (
	opts: WorkersAiLlmOptions,
	stage: string,
	taskId: string,
	inputHash: string,
	started: number,
): RunRecord => ({
	runId: stage === "judge" ? "eval" : "llm",
	taskId,
	stage,
	engine: `workers-ai:${opts.model}`,
	model: opts.model,
	inputHash,
	startedAt: started,
	latencyMs: Date.now() - started,
});

/** Extract a JSON payload from a chat reply — tolerates ```json fences
 * and surrounding prose by taking the outermost bracket span;
 * anything unparseable is the caller's typed PortError. */
const parseJsonPayload = <A>(
	text: string,
	decode: (u: unknown) => A,
	fail: (m: string) => PortError,
	what: string,
): Effect.Effect<A, PortError> =>
	Effect.try({
		try: () => {
			let s = text.trim();
			const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
			if (fence?.[1] !== undefined) s = fence[1].trim();
			// Strip prose around the payload: first '[' or '{' to the
			// matching last closer.
			const start = s.search(/[[{]/);
			if (start > 0) s = s.slice(start);
			const end = Math.max(s.lastIndexOf("]"), s.lastIndexOf("}"));
			if (end >= 0 && end < s.length - 1) s = s.slice(0, end + 1);
			return decode(JSON.parse(s));
		},
		catch: (e) => fail(`malformed ${what} payload: ${String(e).slice(0, 200)}`),
	});

const GENERATE_SYSTEM =
	"You are a text-generation backend for an evaluation pipeline. " +
	"Answer the user request directly and output ONLY the requested content — " +
	"no preamble, no markdown fences unless the contract asks for them.";

const CORRECT_SYSTEM =
	"You are a transcript-correction backend for an evaluation pipeline. " +
	"Given the raw ASR transcript in the user message, return ONLY a JSON object " +
	'{"ops":[{"at":<number>,"remove":"<exact substring>","insert":"<replacement>","kind":"fix|punct|entity|format"}]} ' +
	"describing minimal reversible edits (fix ASR errors, punctuation, entities). " +
	"`at`/`remove` must match the input EXACTLY — offsets are character positions. " +
	'Return {"ops":[]} when the transcript needs no edits. No prose, no fences.';

const JUDGE_SYSTEM =
	"You are an evaluation judge for a transcription-quality pipeline. " +
	"Answer EVERY question about the provided state and return ONLY a JSON array " +
	'[{"id":"<question id>","value":<answer>,"probability":<0..1>}]. ' +
	"Kinds: noul → value is a JSON boolean; choice → value is one of the listed " +
	"options; score → value is a number within 0..maxScore. probability is your " +
	"confidence in the answer. No prose, no fences.";

/**
 * LlmPort over Workers AI — `generate` returns raw text;
 * `correct` pins `outputSchema: "EditList"` and decodes the reply as a
 * reversible EditList (same contract as the ACP adapter; a mismatched
 * envelope is a PortError, never a silent string).
 */
export const makeWorkersAiLlm = (opts: WorkersAiLlmOptions): Layer.Layer<LlmPort> =>
	Layer.succeed(
		LlmPort,
		LlmPort.of({
			// Text leaves the process for Cloudflare — same egress class
			// as the remote ACP agent; the pipeline only ever sends
			// scrubbed text (phi.ts).
			egress: true,
			generate: (envelope: TaskEnvelope) => {
				const started = Date.now();
				const messages: ChatMessage[] = [
					{
						role: "system",
						content: `${GENERATE_SYSTEM} Declared output contract: ${envelope.outputSchema}.`,
					},
					{ role: "user", content: envelope.input },
				];
				return chat(opts, "llm", messages).pipe(
					Effect.map((text) => ({
						text,
						record: recordFor(opts, "script_gen", envelope.taskId, fnvHex(envelope.input), started),
					})),
				);
			},
			correct: (envelope: TaskEnvelope) => {
				const started = Date.now();
				if (envelope.outputSchema !== "EditList") {
					return Effect.fail(
						failLlm(`correct() requires outputSchema=EditList, got "${envelope.outputSchema}"`),
					);
				}
				const messages: ChatMessage[] = [
					{ role: "system", content: CORRECT_SYSTEM },
					{ role: "user", content: envelope.input },
				];
				return chat(opts, "llm", messages).pipe(
					Effect.flatMap((text) =>
						parseJsonPayload(text, (u) => decodeEditList(u), failLlm, "EditList"),
					),
					Effect.map((edits) => ({
						edits,
						record: recordFor(opts, "cleanup", envelope.taskId, fnvHex(envelope.input), started),
					})),
				);
			},
		}),
	);

/** Raw judge reply entry — `value` stays unknown until validated
 * against its question's kind/options below. */
const RawAnswer = Schema.Struct({
	id: Schema.String,
	value: Schema.Unknown,
	probability: Schema.Number,
});
const decodeRawAnswers = Schema.decodeUnknownSync(Schema.Array(RawAnswer));

const describeQuestion = (q: EvalQuestion): string => {
	const base = `- id="${q.id}" kind=${q.kind} text=${JSON.stringify(q.text)}`;
	if (q.kind === "choice" && q.options !== undefined) {
		return `${base} options=${JSON.stringify(q.options)}`;
	}
	if (q.kind === "score") {
		return `${base} maxScore=${q.maxScore ?? "(unbounded)"}`;
	}
	return base;
};

/**
 * EvalPort over Workers AI — a generative judge. See the module header:
 * self-reported probabilities are NOT calibrated; prefer a System One
 * endpoint for gate-grade judging. Every declared question must get
 * exactly one well-formed answer — missing/extra/malformed verdicts
 * are typed PortErrors, never silent defaults.
 */
export const makeWorkersAiEval = (opts: WorkersAiLlmOptions): Layer.Layer<EvalPort> =>
	Layer.succeed(
		EvalPort,
		EvalPort.of({
			egress: true,
			judge: (input) => {
				const started = Date.now();
				const questions = input.questions;
				if (questions.length === 0) {
					return Effect.succeed({
						answers: [],
						record: recordFor(opts, "judge", "eval", fnvHex(JSON.stringify(input.state)), started),
					});
				}
				const user = [
					"STATE:",
					JSON.stringify(input.state),
					"",
					"QUESTIONS:",
					...questions.map(describeQuestion),
				].join("\n");
				const messages: ChatMessage[] = [
					{ role: "system", content: JUDGE_SYSTEM },
					{ role: "user", content: user },
				];
				return chat(opts, "eval", messages).pipe(
					Effect.flatMap((text) =>
						parseJsonPayload(text, (u) => decodeRawAnswers(u), failEval, "judge answers"),
					),
					Effect.flatMap((raw) => {
						// Index by id — duplicates are a contract violation.
						const byId = new Map<string, (typeof raw)[number]>();
						for (const a of raw) {
							if (byId.has(a.id)) {
								return Effect.fail(failEval(`duplicate judge answer for question "${a.id}"`));
							}
							byId.set(a.id, a);
						}
						const answers: EvalAnswer[] = [];
						for (const q of questions) {
							const a = byId.get(q.id);
							if (a === undefined) {
								return Effect.fail(failEval(`judge returned no answer for question "${q.id}"`));
							}
							const p = a.probability;
							if (!Number.isFinite(p) || p < 0 || p > 1) {
								return Effect.fail(
									failEval(`judge answer "${q.id}" probability ${p} outside [0,1]`),
								);
							}
							const value = a.value;
							let ok = false;
							if (q.kind === "noul") {
								ok = typeof value === "boolean";
							} else if (q.kind === "choice") {
								ok =
									typeof value === "string" &&
									(q.options === undefined || q.options.includes(value));
							} else {
								ok =
									typeof value === "number" &&
									Number.isFinite(value) &&
									value >= 0 &&
									(q.maxScore === undefined || value <= q.maxScore);
							}
							if (!ok) {
								return Effect.fail(
									failEval(
										`judge answer "${q.id}" value ${JSON.stringify(value)} ` +
											`does not satisfy kind=${q.kind}`,
									),
								);
							}
							answers.push({
								id: q.id,
								kind: q.kind,
								value: value as EvalAnswer["value"],
								probability: p,
							});
						}
						return Effect.succeed({
							answers,
							record: recordFor(
								opts,
								"judge",
								"eval",
								fnvHex(JSON.stringify(input.state)),
								started,
							),
						});
					}),
				);
			},
		}),
	);
