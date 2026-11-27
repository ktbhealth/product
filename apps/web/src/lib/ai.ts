/**
 * AI binding resolution for local dev — precedence:
 * AI_STUB > AI_BASE_URL > env.AI (the Workers AI binding).
 *
 * The `ai` binding has no local simulator, so wrangler dev routes it
 * through a remote session that requires Cloudflare auth. Dev uses
 * wrangler.dev.jsonc (no `ai` binding); this module supplies stand-ins:
 *
 * - AI_STUB=1: canned responses — no server needed, deterministic.
 * - AI_BASE_URL=http://localhost:8080/v1: OpenAI-compatible server
 *   (whisper.cpp, llama.cpp, LM Studio…) — same convention as
 *   LLM_BASE_URL. Audio inputs POST to <base>/audio/transcriptions.
 *   Chat-shaped inputs still POST to <base>/chat/completions for
 *   binding consumers, but generative calls prefer the canonical
 *   LlmPort env route: app-host maps AI_BASE_URL onto the keyless
 *   OpenAI env endpoint (see createApp's llmConfig), so LLM traffic
 *   flows through effect/ai → LlmPort rather than this shim.
 * - otherwise the real env.AI binding (prod, or `wrangler dev` with
 *   the full wrangler.jsonc).
 */

export interface AiBinding {
	run(model: string, inputs: unknown): Promise<unknown>;
}

export interface AiEnv {
	readonly AI?: AiBinding;
	readonly AI_STUB?: unknown;
	readonly AI_BASE_URL?: unknown;
}

const enabled = (value: unknown): boolean => value === true || value === "1" || value === "true";

/**
 * Canned pt-BR consult transcript returned for every audio input under
 * AI_STUB. It is deliberately realistic — the deterministic heuristic
 * anamnesis extractor (@ktb/anamnesis) turns it into a populated
 * 8-section note with verbatim evidence, so `bun run dev` shows the
 * full golden path with zero external services (hackathon judges run
 * the repo locally; regulamento requires it to be real).
 */
export const STUB_TRANSCRIPT = [
	"Paciente refere cefaleia há três dias, de intensidade progressiva, associada a náusea e tontura.",
	"Refere também insônia e ansiedade desde a semana passada.",
	"Nega alergias medicamentosas.",
	"Toma losartana 50mg e metformina 850mg duas vezes ao dia.",
	"Refere histórico de hipertensão e mãe diabética.",
	"Fez cirurgia de vesícula há dois anos.",
	"Nega febre e falta de ar.",
	"Relata uso eventual de dipirona para a dor.",
	"Refere que os sintomas pioram ao esforço.",
	"Paciente nega tabagismo e etilismo.",
].join(" ");

const stubAi: AiBinding = {
	run: async (_model, inputs) => {
		const i = inputs as Record<string, unknown> | null;
		if (i !== null && typeof i === "object" && "audio" in i) {
			return { text: STUB_TRANSCRIPT };
		}
		// Chat-shaped inputs (anamnesis extraction/cleanup) get an empty
		// JSON object — downstream drivers fall back to heuristics.
		return { response: "{}" };
	},
};

/** Accepts base64 string (queue + /api/transcribe path), number[] (legacy), bytes. */
const audioToBytes = (audio: unknown): Uint8Array<ArrayBuffer> => {
	if (typeof audio === "string") {
		const binary = atob(audio);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}
	// Copy so the result is always backed by a plain ArrayBuffer (BlobPart).
	if (audio instanceof Uint8Array) return new Uint8Array(audio);
	if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
	if (Array.isArray(audio)) return Uint8Array.from(audio as number[]);
	throw new Error("local AI: unsupported audio payload");
};

/** OpenAI-compatible HTTP backend (whisper.cpp, llama.cpp, LM Studio). */
export const createLocalAi = (baseUrl: string, fetchImpl: typeof fetch = fetch): AiBinding => ({
	run: async (model, inputs) => {
		const i = (inputs ?? {}) as Record<string, unknown>;
		// Accept the base with or without the /v1 suffix (LLM_BASE_URL
		// convention includes it; bare host roots are common too).
		const base = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
		if ("audio" in i) {
			const form = new FormData();
			form.set("model", model);
			form.set("file", new Blob([audioToBytes(i.audio)]), "audio.wav");
			if (typeof i.language === "string") form.set("language", i.language);
			// Workers AI calls it initial_prompt; the OpenAI-compatible
			// field is prompt (whisper.cpp accepts the same).
			if (typeof i.initial_prompt === "string") form.set("prompt", i.initial_prompt);
			const res = await fetchImpl(`${base}/audio/transcriptions`, {
				method: "POST",
				body: form,
			});
			if (!res.ok) throw new Error(`local AI transcription failed: HTTP ${res.status}`);
			return res.json();
		}
		if (Array.isArray(i.messages)) {
			const res = await fetchImpl(`${base}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model,
					messages: i.messages,
					...(typeof i.max_tokens === "number" ? { max_tokens: i.max_tokens } : {}),
				}),
			});
			if (!res.ok) throw new Error(`local AI chat failed: HTTP ${res.status}`);
			const json = (await res.json()) as {
				choices?: { message?: { content?: string } }[];
			};
			return { response: json.choices?.[0]?.message?.content ?? "" };
		}
		throw new Error("local AI: unsupported inputs");
	},
});

export const resolveAi = (env: AiEnv, fetchImpl: typeof fetch = fetch): AiBinding | undefined => {
	if (enabled(env.AI_STUB)) return stubAi;
	const baseUrl = env.AI_BASE_URL;
	if (typeof baseUrl === "string" && baseUrl !== "") {
		return createLocalAi(baseUrl, fetchImpl);
	}
	return env.AI;
};
