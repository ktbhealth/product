import type { AnamnesisExtractor } from "@ktb/anamnesis";
import type { KeyringService } from "@ktb/crypto/keyring";
import { loadByokConfig, type ByokConfig } from "@ktb/vault/byok";

/**
 * The ZK extraction port resolver (T-146): the clinic-configured BYOK
 * extractor when this device holds a sealed provider key, null
 * otherwise — `extractAnamnesisZk` then stays on the deterministic
 * heuristic (the zero-config fallback). The config lives in the vault
 * plugin: it is clinic key material, so the vault settings page owns
 * the UI and the device keyring owns the bytes.
 *
 * The extractor factory is injected (`make`): the concrete provider
 * client is an adapter (@ktb/anamnesis-llm) that only the documented
 * client-side composition point (routes/new.tsx) may import — the
 * boundary rule that already covers the transcription backends.
 */
export async function resolveByokExtractor(
	keyring: KeyringService,
	make: (config: ByokConfig) => AnamnesisExtractor,
): Promise<AnamnesisExtractor | null> {
	const config = await loadByokConfig(keyring);
	return config === null ? null : make(config);
}
