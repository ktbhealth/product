import * as Effect from "effect/Effect";
import { Option } from "effect";

import type { Anamnesis, AnamnesisExtractor } from "@ktb/anamnesis";
import { decodeAnamnesisOption } from "@ktb/anamnesis/schema";
import { fnvHex, LlmPort, PortError, type RunRecord, type TaskEnvelope } from "@ktb/eval-core";

import { buildPrompt } from "./prompt.ts";

/**
 * Browser-side BYOK extractor (PL-007 F3, T-146): the ZK consult
 * pipeline calls the clinic's own LLM provider directly — the key is
 * sealed in the device keyring (@ktb/crypto/keyring putSecret), the
 * transcript and the key never touch a KTB server. The wire protocol
 * is the OpenAI-compatible chat-completions shape, which every major
 * provider (OpenAI, OpenRouter, LiteLLM gateways, most local
 * inference servers) speaks.
 *
 * The generative call itself goes through the canonical
 * {@link LlmPort} contract (@ktb/eval-core): `makeByokLlmPort` is the
 * provider adapter (chat-completions transport + the anamnesis system
 * prompt + `json_object` response format — the same "adapter owns the
 * wire" precedent as eval-adapter-cloud's GENERATE_SYSTEM), and
 * `makeByokExtractor` only orchestrates envelope → parse → decode.
 * `correct()` is an honest PortError: this endpoint exists for
 * extraction only.
 *
 * Platform-safe by construction: `fetch` + `JSON` only — no node:*,
 * no process.env. `fetchImpl` is injectable for tests.
 */

export interface ByokLlmConfig {
	readonly apiKey: string;
	readonly model: string;
	/** OpenAI-compatible endpoint root. */
	readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** `choices[0].message.content` — the only field the extractor reads. */
interface ChatCompletion {
	readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
}

const causeMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const byokRecord = (model: string, envelope: TaskEnvelope, started: number): RunRecord => ({
	runId: "byok",
	taskId: envelope.taskId,
	stage: "generate",
	engine: "byok",
	model,
	inputHash: fnvHex(
		`${envelope.taskId}:${envelope.outputSchema}:${envelope.input}:${envelope.seed ?? 0}`,
	),
	...(envelope.seed !== undefined ? { seed: envelope.seed } : {}),
	startedAt: started,
	latencyMs: Date.now() - started,
});

/**
 * LlmPort over the clinic's OpenAI-compatible endpoint. `generate`
 * sends the anamnesis system prompt plus the envelope input as the
 * user message and requests `json_object` output — the extraction
 * contract this port exists for. Transport, HTTP and shape failures
 * collapse into typed PortErrors; the extractor's schema decode stays
 * consumer-side.
 */
export const makeByokLlmPort = (
	config: ByokLlmConfig,
	fetchImpl: typeof fetch = fetch,
): LlmPort["Service"] =>
	LlmPort.of({
		egress: true,
		generate: (envelope: TaskEnvelope) => {
			const started = Date.now();
			return Effect.tryPromise({
				try: async () => {
					const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
					const res = await fetchImpl(`${baseUrl}/chat/completions`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${config.apiKey}`,
						},
						body: JSON.stringify({
							model: config.model,
							response_format: { type: "json_object" },
							messages: [
								{ role: "system", content: buildPrompt() },
								{ role: "user", content: envelope.input },
							],
						}),
					});
					if (!res.ok) throw new Error(`byok extraction failed (${res.status})`);
					const body = (await res.json()) as ChatCompletion;
					const content = body.choices?.[0]?.message?.content;
					if (typeof content !== "string") {
						throw new Error("byok extraction returned no content");
					}
					return content;
				},
				catch: (cause) =>
					new PortError({
						port: "llm",
						message: `byok: ${causeMessage(cause)}`,
						cause,
					}),
			}).pipe(
				Effect.map((text) => ({ text, record: byokRecord(config.model, envelope, started) })),
			);
		},
		correct: () =>
			Effect.fail(
				new PortError({
					port: "llm",
					message: "byok endpoint does not support correct()",
				}),
			),
	});

/**
 * An `AnamnesisExtractor` over {@link makeByokLlmPort}. Any failure
 * (HTTP error, malformed response, schema drift) throws — the ZK seam
 * in consultations degrades to the deterministic heuristic exactly
 * like the server-side engine does.
 */
export const makeByokExtractor = (
	config: ByokLlmConfig,
	fetchImpl: typeof fetch = fetch,
): AnamnesisExtractor => {
	const llm = makeByokLlmPort(config, fetchImpl);
	return {
		name: "byok",
		async extract(transcript: string): Promise<Anamnesis> {
			const res = await Effect.runPromise(
				llm.generate({
					taskId: "byok-anamnesis",
					role: "generator",
					input: transcript,
					outputSchema: "Anamnesis",
				}),
			);
			const decoded = decodeAnamnesisOption(JSON.parse(res.text));
			if (Option.isNone(decoded)) {
				throw new Error("byok extraction returned an invalid anamnesis");
			}
			return decoded.value;
		},
	};
};
