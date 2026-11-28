import * as Effect from "effect/Effect";

/**
 * Minimal Workers AI binding surface — structurally typed so the host
 * stays runtime-agnostic (workerd `env.AI` satisfies this).
 */
export interface WorkersAiBinding {
	run(model: string, inputs: unknown): Promise<unknown>;
}

export const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Extract text from the various Workers AI response shapes. */
export const responseText = (raw: unknown): string => {
	if (typeof raw === "string") return raw;
	// Stryker disable next-line ConditionalExpression: for truthy non-object primitives every property read below yields undefined, so entering the block changes nothing.
	if (raw && typeof raw === "object") {
		const r = raw as Record<string, unknown>;
		if (typeof r.response === "string") return r.response;
		if (typeof r.result === "string") return r.result;
		// Stryker disable next-line ConditionalExpression: for a truthy non-object r.response the inner read yields undefined and falls through to the same throw.
		if (r.response && typeof r.response === "object") {
			const inner = r.response as Record<string, unknown>;
			if (typeof inner.response === "string") return inner.response;
		}
	}
	throw new Error("Workers AI returned an unrecognized response shape");
};

export const runChat = (
	ai: WorkersAiBinding,
	model: string,
	system: string,
	user: string,
): Effect.Effect<string, unknown> =>
	Effect.tryPromise({
		try: () =>
			ai.run(model, {
				messages: [
					// Empty system is omitted — LlmPort callers carry the
					// full prompt inside the user input (TaskEnvelope is
					// text-in/text-out).
					...(system === "" ? [] : [{ role: "system", content: system }]),
					{ role: "user", content: user },
				],
				max_tokens: 4096,
			}),
		catch: (e) => e,
	})
		// Transport-boundary span around the binding call; the model id is
		// deploy config (bounded), never request data.
		.pipe(
			Effect.withSpan("ai.workers-ai", { attributes: { "ai.model": model } }),
			Effect.flatMap((raw) => Effect.try({ try: () => responseText(raw), catch: (e) => e })),
		);
