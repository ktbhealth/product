/**
 * Seed locale metadata (PL-008): endonyms + fallback chains written to
 * `i18n_locales` by tools/import-i18n-baseline.mjs; the manifest
 * generator uses the same list for plugin baseline coverage (every
 * locale except the pseudo-locale, which catalogs never carry).
 */
export const LOCALE_META = {
	en: { endonym: "English", fallbacks: [] },
	"pt-BR": { endonym: "Português (Brasil)", fallbacks: ["en"] },
	es: { endonym: "Español", fallbacks: ["en"] },
	// QA pseudo-locale (PL-008 Phase 6): renders default-locale copy
	// accented/bracketed/padded — opt-in per environment.
	qps: { endonym: "Pseudo (QA)", fallbacks: ["en"] },
} as const;
