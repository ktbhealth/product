/**
 * chat.ts — LlmPort over OpenAI-compatible chat completions.
 *
 * One transport covers the whole "chat LLM" family the eval lab's
 * endpoint CRUD exposes: Ollama/LM Studio (local), OpenAI, Gemini's
 * OpenAI-compat endpoint, and any compatible gateway. The request is
 * a single user message carrying the TaskEnvelope's `input`; the
 * response maps `choices[0].message.content` onto the port's
 * `{ text, record }` contract.
 *
 * `correct()` sends CORRECTOR_INSTRUCTIONS as a system message and
 * parses the reply as an EditList — the same contract the ACP
 * adapter honors, minus the agent layer. Local models (Ollama, LM
 * Studio) need three accommodations to honor it at all, measured on
 * consult-ptbr-synthetic with 4–14B models:
 *
 * - `response_format: json_schema` (on by default) — without it they
 *   answer in prose or wrap the JSON in a ``` fence;
 * - a tolerant reply parser — strips `<think>` blocks and fences and
 *   accepts a bare op array;
 * - `anchorEdits` — they quote `remove` correctly but almost never
 *   get `at` right, so ops are re-anchored onto the transcript and
 *   unverifiable ones dropped instead of failing the whole sample.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { anchorEdits, PortError, type RunRecord, type TaskEnvelope } from "@ktb/eval-core";
import { CORRECTOR_INSTRUCTIONS, fnvHex, LlmPort, outputValidators } from "@ktb/eval-consultation";
import type { EditList } from "@ktb/eval-consultation";

export interface ChatLlmOptions {
	readonly baseUrl: string;
	readonly model: string;
	/** Resolved API key — the caller reads it from the env var named
	 * by the endpoint row's `secretRef`; keys never touch tables. */
	readonly apiKey?: string;
	readonly sessionId?: string;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	/** Stable engineVersion for run records — fnvHex(url+model) by
	 * default so the same endpoint maps to the same engine id. */
	readonly engineVersion?: string;
	/** Send `response_format: json_schema` (EDITLIST_JSON_SCHEMA) on
	 * `correct()`. Default true — OpenAI, Ollama, LM Studio and vLLM
	 * honor it; set false for gateways that reject the field. */
	readonly structuredOutput?: boolean;
}

/** JSON Schema of the EditList reply, for structured-output backends.
 * Mirrors `EditOp` minus the optional `flagged` (strict mode requires
 * every property to be listed as required). */
export const EDITLIST_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["ops"],
	properties: {
		ops: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["at", "remove", "insert", "kind"],
				properties: {
					at: { type: "integer" },
					remove: { type: "string" },
					insert: { type: "string" },
					kind: { type: "string", enum: ["fix", "punct", "entity", "format"] },
				},
			},
		},
	},
} as const;

/** Extract the JSON payload from a chat reply: drops `<think>…</think>`
 * reasoning, unwraps a ``` fence, trims surrounding prose to the
 * outermost object/array, and wraps a bare op array as `{ ops }`.
 * Throws on anything that still isn't JSON. */
export const parseEditListReply = (content: string): unknown => {
	const visible = content.replace(/<think>[\s\S]*?<\/think>/g, "");
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(visible);
	const body = fenced?.[1] ?? visible;
	const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
	// Prose may contain brackets before the payload ("[note] {...}") —
	// try each candidate start until one parses.
	for (const m of body.matchAll(/[[{]/g)) {
		// v8 ignore next -- matchAll always reports an index
		if (m.index === undefined) continue;
		try {
			const parsed: unknown = JSON.parse(body.slice(m.index, end + 1));
			return Array.isArray(parsed) ? { ops: parsed } : parsed;
		} catch {
			// not the payload start — try the next bracket
		}
	}
	// No bracketed payload at all — surface a SyntaxError like before.
	return JSON.parse(body) as unknown;
};

interface ChatCompletionBody {
	readonly choices?: readonly {
		readonly message?: { readonly content?: unknown };
	}[];
}

const causeMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const postChat = (
	url: string,
	opts: ChatLlmOptions,
	envelope: TaskEnvelope,
	timeoutMs: number,
	fetchImpl: typeof fetch,
	system?: string,
	temperature = 0.8,
	extra: Readonly<Record<string, unknown>> = {},
) =>
	Effect.gen(function* () {
		const res = yield* Effect.tryPromise({
			try: () =>
				fetchImpl(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(opts.apiKey !== undefined ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
					},
					signal: AbortSignal.timeout(timeoutMs),
					body: JSON.stringify({
						model: opts.model,
						messages: [
							...(system !== undefined ? [{ role: "system", content: system }] : []),
							{ role: "user", content: envelope.input },
						],
						// Generation benefits from variety; `seed` is forwarded
						// when the backend honors it (Ollama/OpenAI do).
						temperature,
						// Stryker disable next-line ConditionalExpression: `seed: undefined` is dropped by JSON.stringify, so spreading it unconditionally serializes identically
						...(envelope.seed !== undefined ? { seed: envelope.seed } : {}),
						...extra,
					}),
				}),
			catch: (cause) =>
				new PortError({
					port: "llm",
					message: `chat transport: ${causeMessage(cause)}`,
					cause,
				}),
		});
		if (!res.ok) {
			// Provider error bodies are attacker-influenced — a hostile or
			// broken endpoint can echo our Authorization header back into
			// the message, and PortError text reaches the wire via the
			// endpoint test/detail fns. Status code only on the wire; the
			// body stays in server logs.
			// Stryker disable next-line StringLiteral: `""` and `` both produce the same empty string
			const body = yield* Effect.promise(() => res.text().catch(() => ""));
			yield* Effect.logWarning(`chat endpoint ${res.status} response body`).pipe(
				Effect.annotateLogs({ body: body.slice(0, 300) }),
			);
			return yield* new PortError({ port: "llm", message: `chat ${res.status}` });
		}
		return (yield* Effect.tryPromise({
			try: () => res.json(),
			catch: (cause) =>
				new PortError({
					port: "llm",
					message: `chat response: ${causeMessage(cause)}`,
					cause,
				}),
		})) as ChatCompletionBody;
	});

export const makeChatLlm = (opts: ChatLlmOptions): Layer.Layer<LlmPort> => {
	const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const engineVersion = opts.engineVersion ?? fnvHex(`${url}:${opts.model}`);
	return Layer.succeed(
		LlmPort,
		LlmPort.of({
			egress: true,
			generate: (envelope) => {
				const started = Date.now();
				return postChat(url, opts, envelope, timeoutMs, fetchImpl).pipe(
					// Transport-boundary span; the model id is deploy config
					// (bounded), never prompt or completion content.
					Effect.withSpan("llm.chat", { attributes: { "llm.model": opts.model } }),
					Effect.timeout(`${timeoutMs} millis`),
					/* v8 ignore next 4 -- else arm only fires on raw timeout defects */
					Effect.mapError((e) =>
						e instanceof PortError
							? e
							: new PortError({ port: "llm", message: `timeout after ${timeoutMs}ms`, cause: e }),
					),
					Effect.flatMap((body) => {
						const content = body.choices?.[0]?.message?.content;
						return typeof content === "string" && content.trim().length > 0
							? Effect.succeed(content)
							: Effect.fail(
									new PortError({ port: "llm", message: "chat response: empty content" }),
								);
					}),
					Effect.map((text) => ({
						text,
						record: {
							runId: opts.sessionId ?? "chat",
							taskId: envelope.taskId,
							stage: "script_gen",
							engine: "openai-compat",
							model: opts.model,
							engineVersion,
							inputHash: fnvHex(
								`${envelope.taskId}:${envelope.outputSchema}:${envelope.input}:${envelope.seed ?? /* v8 ignore next -- seedless envelope */ 0}`,
							),
							seed: envelope.seed,
							startedAt: started,
							latencyMs: Date.now() - started,
						} satisfies RunRecord,
					})),
				);
			},
			correct: (envelope) => {
				if (envelope.outputSchema !== "EditList") {
					return Effect.fail(
						new PortError({
							port: "llm",
							message: `cleanup requires outputSchema=EditList, got ${envelope.outputSchema}`,
						}),
					);
				}
				const started = Date.now();
				return postChat(
					url,
					opts,
					envelope,
					timeoutMs,
					fetchImpl,
					CORRECTOR_INSTRUCTIONS,
					0.2,
					opts.structuredOutput === false
						? {}
						: {
								response_format: {
									type: "json_schema",
									json_schema: { name: "EditList", schema: EDITLIST_JSON_SCHEMA, strict: true },
								},
							},
				).pipe(
					Effect.withSpan("llm.chat.correct", { attributes: { "llm.model": opts.model } }),
					Effect.timeout(`${timeoutMs} millis`),
					/* v8 ignore next 4 -- else arm only fires on raw timeout defects */
					Effect.mapError((e) =>
						e instanceof PortError
							? e
							: new PortError({ port: "llm", message: `timeout after ${timeoutMs}ms`, cause: e }),
					),
					Effect.flatMap((body) => {
						const content = body.choices?.[0]?.message?.content;
						if (typeof content !== "string" || content.trim().length === 0) {
							return Effect.fail(
								new PortError({ port: "llm", message: "chat response: empty content" }),
							);
						}
						return Effect.try({
							// The reply text is the EditList JSON — parse then
							// schema-decode; either failure is one typed
							// PortError (same contract as the ACP adapter).
							try: () => outputValidators.EditList(parseEditListReply(content)) as EditList,
							catch: (e) =>
								new PortError({
									port: "llm",
									message: `payload failed EditList validation: ${causeMessage(e)}`,
									cause: e,
								}),
						});
					}),
					// Offsets from chat models are hints, not facts — re-anchor
					// onto the transcript so a single miscounted `at` never
					// fails the whole cleanup stage (see anchorEdits).
					Effect.map((decoded) => anchorEdits(envelope.input, decoded.ops)),
					Effect.tap(({ stats }) =>
						Effect.logDebug("chat correct: edit ops anchored").pipe(
							Effect.annotateLogs({ ...stats, model: opts.model }),
						),
					),
					Effect.map(({ ops }) => ({
						edits: { ops } satisfies EditList,
						record: {
							runId: opts.sessionId ?? "chat",
							taskId: envelope.taskId,
							stage: "cleanup",
							engine: "openai-compat",
							model: opts.model,
							engineVersion,
							inputHash: fnvHex(
								`${envelope.taskId}:${envelope.outputSchema}:${envelope.input}:${envelope.seed ?? 0}`,
							),
							seed: envelope.seed,
							startedAt: started,
							latencyMs: Date.now() - started,
						} satisfies RunRecord,
					})),
				);
			},
		}),
	);
};
