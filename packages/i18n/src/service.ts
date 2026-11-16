import type { Effect } from "effect";
import { Context } from "effect";
import type { MessageParam } from "./message.ts";
import type { LocaleChain, MessageScope, ScopeChain } from "./resolve.ts";

/**
 * The i18n port (P-083): an Effect service every consumer resolves.
 * `t()` is synchronous over an already-loaded catalog — implementations
 * load published rows once per (scope-chain × locale) into an immutable
 * map behind a version stamp, so lookups never touch the DB.
 */

export interface TParams {
	readonly [name: string]: unknown;
}

export interface I18nShape {
	/**
	 * Translate `namespace.key`. `namespace` defaults to the caller's
	 * plugin namespace when the service was built with one.
	 */
	readonly t: (key: string, params?: TParams) => Effect.Effect<string, never, never>;
	/**
	 * Raw template + source for a key — used by the panel for preview,
	 * diff and param inspection. `t()` is `renderMessage(resolve(...))`.
	 */
	readonly resolve: (
		namespace: string,
		key: string,
	) => Effect.Effect<
		{
			readonly template: string;
			readonly source:
				| { kind: "hit"; scope: MessageScope; locale: string; version: number }
				| { kind: "missing" };
		},
		never,
		never
	>;
	/** Current request scope chain (portal→tenant→global). */
	readonly scopeChain: ScopeChain;
	/** Current locale fallback chain. */
	readonly locales: LocaleChain;
	/** Declared params for a key from the manifest contract (may be empty). */
	readonly paramsFor: (namespace: string, key: string) => readonly MessageParam[];
}

export class I18n extends Context.Service<I18n, I18nShape>()("@ktb/i18n/I18n") {}

/** Bind a namespace so `t("key")` resolves `namespace.key`. */
export const bindNamespace = (
	i18n: I18nShape,
	namespace: string,
): ((key: string, params?: TParams) => Effect.Effect<string>) => {
	return (key, params) => i18n.t(`${namespace}.${key}`, params);
};
