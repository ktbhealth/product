import { Option } from "effect";

import type { Anamnesis, AnamnesisExtractor } from "@ktb/anamnesis";
import { decodeAnamnesisOption } from "@ktb/anamnesis/schema";

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

/**
 * An `AnamnesisExtractor` that POSTs the transcript to the clinic's
 * provider. Any failure (HTTP error, malformed response, schema drift)
 * throws — the ZK seam in consultations degrades to the deterministic
 * heuristic exactly like the server-side engine does.
 */
export const makeByokExtractor = (
	config: ByokLlmConfig,
	fetchImpl: typeof fetch = fetch,
): AnamnesisExtractor => ({
	name: "byok",
	async extract(transcript: string): Promise<Anamnesis> {
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
					{ role: "user", content: transcript },
				],
			}),
		});
		if (!res.ok) throw new Error(`byok extraction failed (${res.status})`);
		const body = (await res.json()) as ChatCompletion;
		const content = body.choices?.[0]?.message?.content;
		if (typeof content !== "string") throw new Error("byok extraction returned no content");
		const decoded = decodeAnamnesisOption(JSON.parse(content));
		if (Option.isNone(decoded)) {
			throw new Error("byok extraction returned an invalid anamnesis");
		}
		return decoded.value;
	},
});
