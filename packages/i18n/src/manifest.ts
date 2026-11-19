import { I18N_MANIFEST } from "./manifest.gen.ts";

/**
 * Code-side contract hash for one i18n namespace (PL-008 manifest
 * drift). `i18n_namespaces.manifest_hash` stores the hash captured at
 * baseline (re)import; the i18n admin compares it against
 * `i18nManifestHash(namespace)` to flag namespaces whose key/param
 * contract changed since registration.
 *
 * Canonical form: every manifest key (sorted) mapped to its sorted
 * param names — `[["key",["a","b"]],…]` JSON. Param ORDER is
 * deliberately not part of the contract (paramsFor consumers look
 * params up by name); template text is DB-canonical copy and never
 * feeds this hash.
 *
 * Hash: FNV-1a 32-bit over UTF-16 code units → 8 lowercase hex chars.
 * Same construction as plugins/eval-validator's manifestHash — sync
 * and pure (arch rules ban node:crypto in packages/plugins;
 * crypto.subtle is async). Collision resistance is irrelevant for
 * drift detection; determinism across runtimes is what matters, and
 * charCodeAt is stable everywhere JS strings exist.
 */
const fnv1a = (input: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
};

type ManifestShape = Record<string, Record<string, { params: readonly { name: string }[] }>>;

/**
 * Stable hash of the namespace's I18N_MANIFEST contract, or null when
 * the namespace has no manifest entry (DB-only orphans, tenant/plugin
 * catalogs that never went through gen-i18n-manifest).
 */
export const i18nManifestHash = (namespace: string): string | null => {
	const entry = (I18N_MANIFEST as unknown as ManifestShape)[namespace];
	if (entry === undefined) return null;
	const canonical = Object.keys(entry)
		.sort()
		.map((key) => [key, entry[key].params.map((p) => p.name).sort()]);
	return fnv1a(JSON.stringify(canonical));
};
