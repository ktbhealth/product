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
 * `correct()` is intentionally unimplemented — surface correction is
 * an ACP/EditList concern; chat endpoints serve script generation.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PortError, type RunRecord, type TaskEnvelope } from "@ktb/eval-core";
import { fnvHex, LlmPort } from "@ktb/eval-consultation";

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
}

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
						messages: [{ role: "user", content: envelope.input }],
						// Generation benefits from variety; `seed` is forwarded
						// when the backend honors it (Ollama/OpenAI do).
						temperature: 0.8,
						// Stryker disable next-line ConditionalExpression: `seed: undefined` is dropped by JSON.stringify, so spreading it unconditionally serializes identically
						...(envelope.seed !== undefined ? { seed: envelope.seed } : {}),
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
			correct: () =>
				Effect.fail(
					new PortError({
						port: "llm",
						message: "chat endpoints implement generate only — correct is an ACP concern",
					}),
				),
		}),
	);
};
