import * as Effect from "effect/Effect";

import {
	I18N_MANIFEST,
	PSEUDO_LOCALE,
	pseudoLocalize,
	resolveRow,
	type I18nShape,
	type LocaleChain,
	type MessageParam,
	type ScopeChain,
} from "@ktb/i18n";
import { renderMessage, resolveMessage } from "@ktb/i18n";

import type { I18nRuntimeShape } from "./runtime.ts";

/**
 * Missing-key telemetry (P-M5): `ResolvedMessage.source.kind ===
 * "missing"` used to be discarded. One log line per isolate per
 * (namespace, key, locale) — a capped Set keeps hostile key floods
 * from growing memory or spamming logs.
 */
const MISSING_LOG_LIMIT = 1024;
/** Once the dedup Set is full, emit a throttled saturation counter
 * every Nth suppressed miss instead of going silent. */
const MISSING_SATURATION_EVERY = 256;
const MISSING_FIELD_MAX = 120;
const missingLogged = new Set<string>();
let missingSuppressed = 0;

/** Keys/namespaces are code-side but still attacker-influenceable via
 * dynamic key construction — strip control chars and cap length before
 * they reach the log pipeline. (Char-code filter instead of a regex:
 * no-control-regex lint.) */
const sanitizeTelemetryField = (value: string): string => {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0)!; // for-of yields non-empty strings
		if (code > 0x1f && code !== 0x7f) out += ch;
		if (out.length >= MISSING_FIELD_MAX) break;
	}
	return out.slice(0, MISSING_FIELD_MAX);
};

const logMissingKey = (namespace: string, key: string, locale: string): Effect.Effect<void> => {
	const id = JSON.stringify([namespace, key, locale]);
	if (missingLogged.has(id)) {
		return Effect.void;
	}
	if (missingLogged.size >= MISSING_LOG_LIMIT) {
		missingSuppressed += 1;
		if (missingSuppressed % MISSING_SATURATION_EVERY === 1) {
			return Effect.logWarning("i18n.missing.suppressed", {
				suppressed: missingSuppressed,
			});
		}
		return Effect.void;
	}
	missingLogged.add(id);
	return Effect.logInfo("i18n.missing", {
		namespace: sanitizeTelemetryField(namespace),
		key: sanitizeTelemetryField(key),
		locale: sanitizeTelemetryField(locale),
	});
};

/**
 * Build the per-request `I18n` service value. The runtime owns the
 * isolate cache; this binds one request's scope chain + locale chain.
 * `t()` accepts `namespace.key` where BOTH segments may be dotted
 * (`eval.credentials.panel.title`) — the namespace is resolved as the
 * LONGEST registered prefix present in the loaded catalog, so dotted
 * namespaces and dot-pathed keys both work. A miss renders the input
 * verbatim (the `namespace.key` sentinel policy).
 */
export const requestI18n = (
	runtime: I18nRuntimeShape,
	scopeChain: ScopeChain,
	locales: LocaleChain,
): I18nShape => {
	const catalog = () => runtime.catalogFor(scopeChain, locales);

	// Namespaces observed in the loaded index, longest first — cached
	// per index identity (the isolate cache hands back the same Map).
	const namespaceCache = new WeakMap<ReadonlyMap<string, unknown>, readonly string[]>();
	const namespacesIn = (index: ReadonlyMap<string, { namespace: string }>) => {
		let ns = namespaceCache.get(index);
		if (ns === undefined) {
			const set = new Set<string>();
			for (const row of index.values()) set.add(row.namespace);
			ns = [...set].sort((a, b) => b.length - a.length);
			namespaceCache.set(index, ns);
		}
		return ns;
	};

	const splitKey = (
		full: string,
		namespaces: readonly string[],
	): { namespace: string; key: string } => {
		for (const ns of namespaces) {
			if (full.startsWith(`${ns}.`)) {
				return { namespace: ns, key: full.slice(ns.length + 1) };
			}
		}
		// No registered namespace prefixes the key (empty catalog or a
		// typo'd namespace): first-dot split preserves the old behavior —
		// the sentinel renders the input verbatim either way.
		const dot = full.indexOf(".");
		return dot === -1
			? { namespace: "", key: full }
			: { namespace: full.slice(0, dot), key: full.slice(dot + 1) };
	};

	return {
		scopeChain,
		locales,
		// qps QA pseudo-locale: same transform catalogSlice applies —
		// resolve the default-locale template, then accent/pad it.
		t: (key, params) =>
			Effect.gen(function* () {
				const index = yield* catalog();
				const { namespace, key: k } = splitKey(key, namespacesIn(index));
				const resolved = resolveMessage(index, {
					namespace,
					key: k,
					scopeChain,
					locales,
				});
				if (resolved.source.kind === "missing") {
					yield* logMissingKey(namespace, k, locales.locales[0] ?? "en");
				}
				const template =
					locales.locales[0] === PSEUDO_LOCALE
						? pseudoLocalize(resolved.template)
						: resolved.template;
				return renderMessage(template, params ?? {}, locales.locales[0] ?? "en");
			}),
		resolve: (namespace, key) =>
			Effect.gen(function* () {
				const index = yield* catalog();
				const resolved = resolveMessage(index, { namespace, key, scopeChain, locales });
				if (resolved.source.kind === "missing") {
					yield* logMissingKey(namespace, key, locales.locales[0] ?? "en");
				}
				return resolved;
			}),
		paramsFor: (namespace, key) =>
			Effect.map(catalog(), (index) => {
				const row = resolveRow(index, { namespace, key, scopeChain, locales });
				if (row !== undefined) return row.params;
				// Manifest contract covers code-side baselines (app.* and
				// migrated plugin string catalogs) even before rows exist.
				const manifestNs = (
					I18N_MANIFEST as unknown as Record<
						string,
						Record<string, { params: readonly MessageParam[] }>
					>
				)[namespace];
				return manifestNs?.[key]?.params ?? [];
			}),
	};
};

/** Provide `I18n` for a request: `Layer.succeed(I18n, requestI18n(...))`. */
export const i18nLayerFor = (
	runtime: I18nRuntimeShape,
	scopeChain: ScopeChain,
	locales: LocaleChain,
) => requestI18n(runtime, scopeChain, locales);
