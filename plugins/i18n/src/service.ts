import * as Effect from "effect/Effect";

import type { I18nShape, LocaleChain, ScopeChain } from "@ktb/i18n";
import { renderMessage, resolveMessage } from "@ktb/i18n";

import type { I18nRuntimeShape } from "./runtime.ts";

/**
 * Build the per-request `I18n` service value. The runtime owns the
 * isolate cache; this binds one request's scope chain + locale chain.
 * `t()` splits the dotted key at the FIRST dot: `ns.rest` →
 * namespace `ns`, key `rest` — namespaces are single-segment ids.
 */
export const requestI18n = (
	runtime: I18nRuntimeShape,
	scopeChain: ScopeChain,
	locales: LocaleChain,
): I18nShape => {
	const catalog = () => runtime.catalogFor(scopeChain, locales);
	const splitKey = (full: string): { namespace: string; key: string } => {
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
				const { namespace, key: k } = splitKey(key);
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
		paramsFor: () => [],
	};
};

/** Provide `I18n` for a request: `Layer.succeed(I18n, requestI18n(...))`. */
export const i18nLayerFor = (
	runtime: I18nRuntimeShape,
	scopeChain: ScopeChain,
	locales: LocaleChain,
) => requestI18n(runtime, scopeChain, locales);
