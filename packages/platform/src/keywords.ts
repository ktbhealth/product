/**
 * Product-controlled vocabulary for `PluginMeta.keywords` (P-082).
 *
 * Moved out of @ktb/kernel: the kernel contract types `keywords` as
 * open strings — the vocabulary is product data, owned here next to
 * the plugin-management surfaces that consume it (the plugins map's
 * "Domains" view groups by the FIRST keyword — the domain lane).
 *
 * Enforcement is the host registry test (apps/web plugins.test.ts
 * asserts every declared keyword is in {@link PLUGIN_KEYWORD_SET}),
 * not the type system. Adding a word is a one-line change here.
 * Convention: the FIRST keyword is the plugin's domain lane; remaining
 * keywords describe role and audience.
 */
export const PLUGIN_KEYWORDS = [
	// domains — the lanes of the Domains view; one per plugin namespace
	"agenda",
	"ai",
	"api",
	"audience",
	"audit",
	"auth",
	"clinician",
	"consultations",
	"cron",
	"dashboard",
	"doctors",
	"documents",
	"eval",
	"flows",
	"fonts",
	"forms",
	"groups",
	"integrity",
	"invites",
	"i18n",
	"image",
	"jobs",
	"kv",
	"layouts",
	"machines",
	"manager",
	"notifications",
	"pages",
	"patient-access",
	"patient-portal",
	"patients",
	"platform",
	"portal",
	"pubsub",
	"queue",
	"rbac",
	"rich-text",
	"schemas",
	"secretaries",
	"site",
	"tenant",
	"templates",
	"theme",
	"transcription",
	"triggers",
	"users",
	"vault",
	"views",
	"wizards",
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
	"cqrs",
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
