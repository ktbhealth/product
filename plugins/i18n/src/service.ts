import * as Effect from "effect/Effect";

import { I18N_MANIFEST, resolveRow, type I18nShape, type LocaleChain, type MessageParam, type ScopeChain } from "@ktb/i18n";
import { renderMessage, resolveMessage } from "@ktb/i18n";

import type { I18nRuntimeShape } from "./runtime.ts";

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
		t: (key, params) =>
			Effect.map(catalog(), (index) => {
				const { namespace, key: k } = splitKey(key, namespacesIn(index));
				const resolved = resolveMessage(index, {
					namespace,
					key: k,
					scopeChain,
					locales,
				});
				return renderMessage(resolved.template, params ?? {}, locales.locales[0] ?? "en");
			}),
		resolve: (namespace, key) =>
			Effect.map(catalog(), (index) =>
				resolveMessage(index, { namespace, key, scopeChain, locales }),
			),
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
