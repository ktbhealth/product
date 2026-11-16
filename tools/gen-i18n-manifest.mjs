#!/usr/bin/env bun
/**
 * gen:i18n-manifest — builds the i18n key/param manifest from baseline
 * sources (PL-008 Phase 1). Baseline app copy: apps/web/messages/*.json under
 * the `app` namespace. Plugin catalogs join as their own adapters land
 * (Phase 4). Output is GENERATED — never hand-edit:
 *
 *   packages/i18n/src/manifest.gen.ts
 *   packages/i18n/src/baseline.gen.ts
 *
 * CI regenerates and diffs (ci:i18n-* tasks). The manifest is the
 * contract: gen-i18n-types turns it into typed t() signatures, the
 * baseline importer turns it into DB rows, the panel uses it for the
 * key tree. baseline.gen.ts is the full seed dataset (every string
 * leaf + every paramMessage template, every locale) mirroring
 * tools/import-i18n-baseline.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { flattenCatalog } from "../packages/i18n/src/catalog.ts";
import { LOCALE_META } from "../packages/i18n/src/locales.ts";
import {
	isParametrizedMessage,
	PSEUDO_LOCALE,
	parseMessage,
} from "../packages/i18n/src/message.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const messagesDir = join(root, "apps/web/messages");
const outPath = join(root, "packages/i18n/src/manifest.gen.ts");
const baselinePath = join(root, "packages/i18n/src/baseline.gen.ts");

const BASE_LOCALE = "en";

const locales = readdirSync(messagesDir)
	.filter((f) => f.endsWith(".json"))
	.map((f) => f.slice(0, -".json".length))
	.sort();

const catalogs = new Map(
	locales.map((locale) => [
		locale,
		JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), "utf8")),
	]),
);

const base = catalogs.get(BASE_LOCALE);
if (!base) {
	console.error(`gen-i18n-manifest: no ${BASE_LOCALE}.json baseline`);
	process.exit(1);
}

const manifest = {
	app: {},
};
const warnings = [];

// Seed dataset — mirrors tools/import-i18n-baseline.mjs row-for-row:
// app catalogs contribute every messages/*.json locale; plugin
// catalogs contribute every LOCALE_META locale except the pseudo one.
const baseline = [];
for (const locale of locales) {
	for (const [key, value] of Object.entries(catalogs.get(locale))) {
		baseline.push({ namespace: "app", key, locale, value });
	}
}

for (const [key, template] of Object.entries(base).sort(([a], [b]) => a.localeCompare(b))) {
	const parsed = parseMessage("text", template);
	if (!parsed.ok) {
		warnings.push(`app.${key}: ${parsed.error}`);
		continue;
	}
	manifest.app[key] = {
		params: parsed.message.params.map((p) => ({
			name: p.name,
			...(p.hint ? { hint: p.hint } : {}),
			...(p.cases ? { cases: p.cases } : {}),
			...(p.plural ? { plural: true } : {}),
		})),
	};
	// Locale parity: every other catalog must carry the key (missing
	// translations are data gaps, not contract gaps — reported, not fatal).
	for (const locale of locales) {
		if (locale === BASE_LOCALE) continue;
		const cat = catalogs.get(locale);
		if (cat && !(key in cat)) {
			warnings.push(`app.${key}: missing in ${locale}`);
		}
	}
}

const toParams = (params) =>
	params.map((p) => ({
		name: p.name,
		...(p.hint ? { hint: p.hint } : {}),
		...(p.cases ? { cases: p.cases } : {}),
		...(p.plural ? { plural: true } : {}),
	}));

// Plugin catalogs (Phase 4): src/i18n.ts exports I18N_NAMESPACE +
// i18nMessagesFor(locale). Nested catalogs flatten to dot paths — the
// same keys the baseline importer writes and sliceMessages reads.
// String leaves and paramMessage leaves (template + params carried as
// metadata) become manifest keys; plain function leaves stay skipped —
// they are call-site code, not t() templates.
const pluginsDir = join(root, "plugins");
// qps is a pseudo-locale — catalogs render it from the default locale
// at slice time, so plugins don't need qps baseline entries.
const pluginLocales = Object.keys(LOCALE_META).filter((l) => l !== PSEUDO_LOCALE);
for (const dir of readdirSync(pluginsDir)) {
	const file = join(pluginsDir, dir, "src/i18n.ts");
	if (!existsSync(file)) continue;
	const mod = await import(pathToFileURL(file).href);
	if (typeof mod.I18N_NAMESPACE !== "string" || typeof mod.i18nMessagesFor !== "function") {
		continue;
	}
	const ns = mod.I18N_NAMESPACE;
	manifest[ns] ??= {};
	const en = mod.i18nMessagesFor(BASE_LOCALE);
	let skipped = 0;
	for (const { path: key, value } of flattenCatalog(en)) {
		const parametrized = isParametrizedMessage(value);
		if (typeof value !== "string" && !parametrized) {
			skipped++;
			continue;
		}
		const template = parametrized ? value.i18nTemplate : value;
		const parsed = parseMessage("text", template);
		if (!parsed.ok) {
			warnings.push(`${ns}.${key}: ${parsed.error}`);
			continue;
		}
		const params = toParams(parsed.message.params);
		if (parametrized) {
			// Positional params declared on the function but absent from
			// the template still belong to the call signature.
			const seen = new Set(params.map((p) => p.name));
			for (const name of value.i18nParams) {
				if (!seen.has(name)) params.push({ name });
			}
			manifest[ns][key] = { params, template };
		} else {
			manifest[ns][key] = { params };
		}
	}
	if (skipped > 0) console.warn(`gen-i18n-manifest: ${ns}: ${skipped} function leaves skipped`);
	for (const locale of pluginLocales) {
		const catalog = mod.i18nMessagesFor(locale);
		for (const { path: key, value } of flattenCatalog(catalog)) {
			if (typeof value === "string") {
				baseline.push({ namespace: ns, key, locale, value });
			} else if (isParametrizedMessage(value)) {
				baseline.push({
					namespace: ns,
					key,
					locale,
					kind: "text",
					value: value.i18nTemplate,
				});
			}
		}
	}
}

const body = `// Generated by tools/gen-i18n-manifest.mjs — do not edit.
// Regenerate: bun run gen:i18n-manifest
export const I18N_MANIFEST = ${JSON.stringify(manifest, null, "\t")} as const;
export const I18N_BASE_LOCALES = ${JSON.stringify(locales)} as const;
export const I18N_BASE_CATALOG = ${JSON.stringify(base, null, "\t")} as const;
`;

writeFileSync(outPath, body);

const baselineBody = `// Generated by tools/gen-i18n-manifest.mjs — do not edit.
// Regenerate: bun run gen:i18n-manifest
// Seed dataset mirroring tools/import-i18n-baseline.mjs: every string
// catalog leaf and every paramMessage template, per locale.
export const I18N_BASELINE = ${JSON.stringify(baseline, null, "\t")} as const;
`;

writeFileSync(baselinePath, baselineBody);
// Keep generated output formatter-clean so ci:i18n drift checks pass.
spawnSync("bunx", ["vp", "fmt", outPath, baselinePath], { stdio: "inherit" });
for (const w of warnings) console.warn(`warn: ${w}`);
const manifestEntries = /** @type {Record<string, Record<string, unknown>>} */ (manifest);
const keyCount = Object.values(manifestEntries).reduce((n, ns) => n + Object.keys(ns).length, 0);
console.log(
	`gen-i18n-manifest: ${keyCount} keys across ${Object.keys(manifest).length} namespaces, ${locales.length} locales, ${baseline.length} baseline rows → ${outPath} + ${baselinePath}`,
);
