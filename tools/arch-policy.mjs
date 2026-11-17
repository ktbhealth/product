/**
 * Architecture boundary policy — the single source of truth for where
 * platform/provider APIs are allowed.
 *
 * Consumed by:
 * - vite.config.ts `lint.overrides` — generates the oxlint
 *   no-restricted-imports / no-restricted-globals entries below.
 * - tools/ktb-arch-plugin.js — the `provider-lockin` rule scans string
 *   literals in port/domain files against PROVIDER_LITERAL_PATTERNS.
 *
 * Port/domain code (PORT_GLOBS) must stay runtime- and provider-agnostic:
 * config arrives through ports/layers, never through platform APIs or
 * provider-named literals. Adapters, the composition root (apps/*,
 * infra/*, @ktb/app-host) and tests are the edge and may use them.
 *
 * To grant an exception, add the file to EDGE_FILES or move its package
 * out of PORT_PACKAGE_NAMES — do not weaken a rule inline.
 */

/** Port/domain packages — the same set banned from importing adapters. */
const PORT_PACKAGE_NAMES = [
	"kernel",
	"auth",
	"authz",
	"bot",
	"captcha",
	"email",
	"transcription",
	"anamnesis",
	"export-pdf",
	"interop",
	"db",
	"driver-framework",
	// Tenancy ports/helpers — platform capability, not an adapter.
	"tenant",
	"rbac",
	// The server-fn runtime registry is port infrastructure, not an adapter.
	"server-fns",
	// Eval framework core (P-074): generic suite/runner machinery —
	// domain code held to the same boundary as every other port.
	"eval-core",
	// Host infrastructure below the plugin system (admin gate, console
	// shell, plugin_state) — held to the same boundary it had under
	// plugins/ before the T-088 move to packages/platform.
	"platform",
];

const pkgGlob = (names) => `packages/{${names.join(",")}}/src/**/*.{ts,tsx}`;

/** Files held to the strict boundary: ports, domain packages, plugins,
 * and eval domain packs (evals/<domain>/ — plain packages since P-075,
 * held to the same boundary they had under plugins/). */
export const PORT_GLOBS = [
	pkgGlob(PORT_PACKAGE_NAMES),
	"plugins/**/*.{ts,tsx}",
	"evals/**/*.{ts,tsx}",
];

/** Test files inside the strict boundary — relaxed by the test override
 * in vite.config.ts (Node APIs and impl mocks are fine in tests). */
export const PORT_TEST_GLOBS = [
	`packages/{${PORT_PACKAGE_NAMES.join(",")}}/src/**/*.test.{ts,tsx}`,
	"plugins/**/*.test.{ts,tsx}",
	"evals/**/*.test.{ts,tsx}",
];

/**
 * Source trees scanned by ktb-arch/package-boundary: a relative import
 * (`../…`) may not resolve outside the importing package's root —
 * cross-package references must go through the dependency's export map
 * (`@ktb/<pkg>/<subpath>`). Exemptions live inside the rule itself:
 * `schema.ts` (drizzle-kit CJS resolver, T-143), `*.gen.*` (generated
 * aggregations) and `*.test.*` (tests may wire internals directly).
 */
export const PACKAGE_BOUNDARY_GLOBS = [
	"plugins/**/*.{ts,tsx}",
	"packages/**/*.{ts,tsx}",
	"apps/**/*.{ts,tsx}",
	"evals/**/*.{ts,tsx}",
];

/** Import specifiers that tie code to a runtime or cloud platform. */
export const PLATFORM_IMPORT_PATTERNS = ["node:*", "bun:*", "deno:*", "cloudflare:*", "workerd:*"];

/** Globals that only exist on specific runtimes. */
export const PLATFORM_GLOBALS = ["process", "Bun", "Deno"];

/**
 * String literals that name a provider — model ids, endpoints, product
 * prefixes. Domain code must not hardcode these; they belong in adapters
 * or deploy config. Extend this list when a new provider leaks in.
 */
export const PROVIDER_LITERAL_PATTERNS = [
	/^@cf\//, // Cloudflare Workers AI model ids
	/\bapi\.anthropic\.com\b/,
	/\bapi\.openai\.com\b/,
	/\bgoogleapis\.com\b/, // fonts.googleapis.com css2 + generativelanguage.googleapis.com LLM endpoint
	/\btypesafe\.ai\b/, // Jev decision-model endpoint (P-066 eval port)
	/\/v1\/systemone\b/, // Jev API path — belongs in adapters
];

/** Adapter packages — implementations of ports, allowed platform APIs
 * and provider literals by definition. Banned from *importing* each
 * other and from being imported by ports/plugins (IMPL_IMPORT_PATTERNS
 * below). Listed here so the boundary is explicit. */
const ADAPTER_PACKAGE_NAMES = [
	"auth-better",
	"bot-recall",
	"captcha-stub",
	"captcha-turnstile",
	"email-cloudflare",
	"email-smtp",
	"email-stub",
	"anamnesis-llm",
	"interop-fhir",
	"interop-openehr",
	"transcription-whisper",
	"transcription-webspeech",
	"db-sqlite",
	// Eval platform adapters — the exempt edge for the eval ports
	// (deterministic stub, on-box local services, cloud providers).
	"eval-adapter-stub",
	"eval-adapter-local",
	"eval-adapter-cloud",
	// Generative-endpoint adapters (F3a): OpenAI-compat chat, the ACP
	// ws/http transport, and the Node-runtime spawned-agent driver.
	"ai-adapter-openai",
	"ai-adapter-acp",
	"ai-adapter-node",
	// The ACP bridge (F3b): the Durable Object holding the agent's
	// outbound WebSocket and the local byte-pipe CLI.
	"ai-bridge",
];

/**
 * Import specifiers port/domain files may never use: the deploy target,
 * the composition root, infra adapters and every adapter package.
 * Tests keep these bans; only the platform/runtime patterns are relaxed
 * for them (see the test override in vite.config.ts).
 */
export const IMPL_IMPORT_PATTERNS = [
	"**/apps/**",
	"@ktb/web",
	"@ktb/app-host",
	"@ktb/app-host/**",
	"@ktb/infra-cloudflare",
	"@ktb/infra-cloudflare/**",
	"@ktb/infra-oci",
	"@ktb/infra-oci/**",
	"cloudflare:*",
	...ADAPTER_PACKAGE_NAMES.flatMap((name) => [`@ktb/${name}`, `@ktb/${name}/**`]),
];
