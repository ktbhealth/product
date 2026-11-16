import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { Db } from "@ktb/db";
import { indexMessages, type LocaleChain, type MessageRow, type ScopeChain } from "@ktb/i18n";

import { catalogStamp, listPublishedRows } from "./store.ts";

/** How often an isolate re-reads the version stamp (PL-008 hardening). */
export const STAMP_TTL_MS = 15_000;

interface CacheEntry {
	readonly stamp: string;
	readonly index: ReadonlyMap<string, MessageRow>;
	readonly loadedAt: number;
}

/**
 * Per-isolate catalog cache (P-083). One entry per
 * (scope-chain × locale-chain) signature; the DB stamp is re-read at
 * most every STAMP_TTL_MS, local writes call `invalidate()` for
 * immediate freshness. `t()` never queries.
 */
export interface I18nRuntimeShape {
	readonly catalogFor: (
		scopeChain: ScopeChain,
		locales: LocaleChain,
	) => Effect.Effect<ReadonlyMap<string, MessageRow>>;
	readonly invalidate: () => Effect.Effect<void>;
}

export class I18nRuntime extends Context.Service<I18nRuntime, I18nRuntimeShape>()(
	"@ktb/i18n-plugin/I18nRuntime",
) {}

const cacheKey = (scopeChain: ScopeChain, locales: LocaleChain): string =>
	`${scopeChain.scopes.map((s) => `${s.scope}:${s.scopeId}`).join("|")}${locales.locales.join(",")}`;

export const I18nRuntimeLive = Layer.effect(
	I18nRuntime,
	Effect.gen(function* () {
		const db = yield* Db;
		const cache = yield* Ref.make(new Map<string, CacheEntry>());

		const load = (
			key: string,
			scopeChain: ScopeChain,
			locales: LocaleChain,
		): Effect.Effect<ReadonlyMap<string, MessageRow>> =>
			Effect.gen(function* () {
				const stamp = yield* Effect.promise(() => catalogStamp(db));
				const rows = yield* Effect.promise(() =>
					listPublishedRows(db, {
						locales: locales.locales,
						scopes: scopeChain.scopes,
					}),
				);
				const index = indexMessages(rows);
				yield* Ref.update(cache, (m) =>
					new Map(m).set(key, { stamp, index, loadedAt: Date.now() }),
				);
				return index;
			});

		return {
			catalogFor: (scopeChain, locales) =>
				Effect.gen(function* () {
					const key = cacheKey(scopeChain, locales);
					const now = Date.now();
					const entries = yield* Ref.get(cache);
					const hit = entries.get(key);
					if (hit && now - hit.loadedAt < STAMP_TTL_MS) {
						// Within TTL: serve cached index without re-reading the stamp.
						return hit.index;
					}
					if (hit) {
						// TTL expired: re-read stamp; reload only if it changed.
						const stamp = yield* Effect.promise(() => catalogStamp(db));
						if (stamp === hit.stamp) {
							yield* Ref.update(cache, (m) => new Map(m).set(key, { ...hit, loadedAt: now }));
							return hit.index;
						}
					}
					return yield* load(key, scopeChain, locales);
				}),
			invalidate: () =>
				Ref.update(cache, (m) => {
					const next = new Map(m);
					next.clear();
					return next;
				}),
		};
	}),
);
