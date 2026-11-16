import * as Effect from "effect/Effect";

import type { DbClient } from "@ktb/db";
import {
	resolveRequestLocales,
	type I18nShape,
	type LocaleChain,
	type ScopeChain,
} from "@ktb/i18n";

import type { I18nRuntimeShape } from "./runtime.ts";
import { requestI18n } from "./service.ts";
import { listEnabledLocales } from "./store.ts";

export const DEFAULT_LOCALE = "en";

/**
 * Resolve the request's i18n context (PL-008 Phase 2): enabled locales
 * from `i18n_locales` → cookie/portal-requested locale → fallback chain
 * → bound `I18n` shape over the runtime's isolate cache. One small
 * locales read per request; message rows themselves never hit the DB
 * after warm.
 */
export const resolveRequestI18n = (
	runtime: I18nRuntimeShape,
	db: DbClient,
	input: {
		readonly requestedLocale?: string;
		readonly scopeChain: ScopeChain;
		readonly defaultLocale?: string;
	},
): Effect.Effect<{ readonly i18n: I18nShape; readonly locales: LocaleChain }> =>
	Effect.gen(function* () {
		const enabled = yield* Effect.promise(() => listEnabledLocales(db));
		const defaultLocale = input.defaultLocale ?? DEFAULT_LOCALE;
		const locales = resolveRequestLocales(input.requestedLocale, enabled, defaultLocale);
		return { i18n: requestI18n(runtime, input.scopeChain, locales), locales };
	});
