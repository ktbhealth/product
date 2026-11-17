/**
 * Controlled vocabulary for `PluginMeta.keywords` (P-082).
 *
 * Every plugin manifest declares keywords; the `PluginKeyword` union
 * rejects unknown strings at compile time, so adding a word is a
 * one-line change here. Convention: the FIRST keyword is the plugin's
 * domain lane — it drives the "Domains" view in the plugins map;
 * remaining keywords describe role and audience.
 */
export const PLUGIN_KEYWORDS = [
	// domains — the lanes of the Domains view; one per plugin namespace
	"ai",
	"audience",
	"audit",
	"auth",
	"clinician",
	"consultations",
	"dashboard",
	"doctors",
	"eval",
	"groups",
	"integrity",
	"invites",
	"jobs",
	"manager",
	"notifications",
	"pages",
	"patient-access",
	"patient-portal",
	"patients",
	"platform",
	"portal",
	"rbac",
	"secretaries",
	"site",
	"tenant",
	"theme",
	"transcription",
	"users",
	"vault",
	// eval/transcription sub-domains
	"asr",
	"credentials",
	"dataset",
	"llm",
	"persona",
	"tts",
	"validator",
	// roles
	"admin",
	"marker",
	"routes",
	"services",
	"shell",
	"tables",
	"ui",
	// audiences
	"doctor",
	"patient",
	"secretary",
] as const;

export type PluginKeyword = (typeof PLUGIN_KEYWORDS)[number];

export const PLUGIN_KEYWORD_SET: ReadonlySet<string> = new Set(PLUGIN_KEYWORDS);
