import type { KeyringService } from "@ktb/crypto/keyring";

/**
 * Clinic BYOK extraction config (PL-007 F3, T-146): under a ZK tenant
 * the server never sees the transcript, so anamnesis extraction runs
 * in the browser — either the zero-config heuristic or the clinic's
 * own LLM provider key (BYOK). The key is "held in the clinic
 * keyring": sealed to this device by `KeyringService.putSecret` — the
 * plaintext never leaves the browser, the store only ever holds the
 * `w1.`/`v1.` envelopes.
 *
 * The config is deliberately per-device: a clinic that uses BYOK sets
 * the provider key on each device that should call the provider. The
 * browser calls the provider endpoint directly — no KTB server hop.
 */

/** Secret-store slot the consultations extractor resolves from. */
export const BYOK_SECRET_NAME = "clinic.anamnesis-byok";

export interface ByokConfig {
	/** Provider API key — sealed, never rendered back to the UI. */
	readonly apiKey: string;
	/** Model id sent to the provider (e.g. "gpt-4o-mini"). */
	readonly model: string;
	/** OpenAI-compatible endpoint root — defaults to the provider's
	 * canonical URL inside the extractor. */
	readonly baseUrl?: string;
}

/** The stored shape is a JSON string — guard every field before use. */
const isByokConfig = (value: unknown): value is ByokConfig =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as ByokConfig).apiKey === "string" &&
	(value as ByokConfig).apiKey !== "" &&
	typeof (value as ByokConfig).model === "string" &&
	(value as ByokConfig).model !== "" &&
	((value as ByokConfig).baseUrl === undefined ||
		typeof (value as ByokConfig).baseUrl === "string");

/** Stored BYOK config for this device — null when absent or drifted. */
export async function loadByokConfig(keyring: KeyringService): Promise<ByokConfig | null> {
	const raw = await keyring.getSecret(BYOK_SECRET_NAME);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return isByokConfig(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Seal the BYOK config to this device — overwrites any previous one. */
export async function saveByokConfig(keyring: KeyringService, config: ByokConfig): Promise<void> {
	const stored: ByokConfig = {
		apiKey: config.apiKey,
		model: config.model,
		...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
	};
	await keyring.putSecret(BYOK_SECRET_NAME, JSON.stringify(stored));
}

/** Remove the BYOK config — the extractor falls back to the heuristic. */
export async function clearByokConfig(keyring: KeyringService): Promise<void> {
	await keyring.deleteSecret(BYOK_SECRET_NAME);
}
