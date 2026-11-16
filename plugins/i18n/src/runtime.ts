import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { Db, type DbClient } from "@ktb/db";
import {
	I18N_BASELINE,
	indexMessages,
	LOCALE_META,
	PSEUDO_LOCALE,
	type LocaleChain,
	type MessageRow,
	type ScopeChain,
} from "@ktb/i18n";

import { syncBaseline, type BaselineEntry } from "./baseline.ts";
import { i18nLocales, i18nNamespaces } from "./schema.ts";
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

/**
 * JSON-tuple cache key — injective for ANY field content (same fix as
 * packages/i18n resolve.ts rowKey). The old "|"/"," join let a
 * scopeId containing separator characters collide with a different
 * scope/locale chain and serve the wrong catalog.
 */
const cacheKey = (scopeChain: ScopeChain, locales: LocaleChain): string =>
	JSON.stringify([...scopeChain.scopes.map((s) => [s.scope, s.scopeId]), ...locales.locales]);

/** Bound the isolate map: few active tenant×locale combos per isolate
 * in practice (getI18n has no prod callers yet — route i18n reads go
 * straight through catalogSlice); 32 leaves generous headroom. Map
 * iterates in insertion order, so eviction drops the oldest entry. */
export const MAX_CACHE_ENTRIES = 32;

const putCache = (
	cache: Map<string, CacheEntry>,
	key: string,
	entry: CacheEntry,
): Map<string, CacheEntry> => {
	const next = new Map(cache);
	next.delete(key); // re-insert → most-recently-used position
	next.set(key, entry);
	while (next.size > MAX_CACHE_ENTRIES) {
		const oldest = next.keys().next().value;
		if (oldest === undefined) break;
		next.delete(oldest);
	}
	return next;
};

/** Code-catalog baseline (global/published rows) shipped by @ktb/i18n. */
const baselineEntries: readonly BaselineEntry[] = I18N_BASELINE;

/** Seed locales from LOCALE_META so `?locale=…` works out of the box
 * on a fresh D1 — EXCEPT the pseudo-locale: qps is a QA opt-in and
 * must not resolve for real users, so it seeds disabled (admins
 * enable it from /platform/i18n). `onConflictDoNothing` leaves
 * admin-edited rows (endonym/fallbacks/enabled) untouched. */
const SEED_LOCALES = Object.entries(LOCALE_META).map(([code, meta]) => ({
	code,
	endonym: meta.endonym,
	fallbacks: [...meta.fallbacks],
	enabled: code !== PSEUDO_LOCALE,
}));

/**
 * One-time runtime defaults at layer build (per isolate): all seed
 * locales plus, on a completely empty namespaces table, the
 * code-catalog baseline as global/published rows. Never per-request —
 * `catalogFor` stays read-only after this.
 */
const seedRuntimeDefaults = async (db: DbClient): Promise<void> => {
	await db.insert(i18nLocales).values(SEED_LOCALES).onConflictDoNothing();
	if (baselineEntries.length === 0) return;
	const rows = await db
		.select({ namespace: i18nNamespaces.namespace })
		.from(i18nNamespaces)
		.limit(1);
	if (rows.length > 0) return;
	// Layer build runs once per isolate, so concurrent seeds only come
	// from racing isolates on a shared D1 — the namespaces-empty gate
	// above plus onConflictDoNothing inside syncBaseline keep that safe
	// (worst case: duplicate no-op work, never duplicate rows).
	await syncBaseline(db, baselineEntries);
};

export const I18nRuntimeLive = Layer.effect(
	I18nRuntime,
	Effect.gen(function* () {
		const db = yield* Db;
		// Seed once per isolate at layer build. A failure (raced isolate,
		// missing tables in a partial test schema) must not take the
		// runtime down — log and serve the sentinel/fallback path.
		yield* Effect.tryPromise({
			try: () => seedRuntimeDefaults(db),
			catch: (error) => error,
		}).pipe(
			Effect.catch((error) => Effect.logWarning(`i18n runtime seed failed: ${String(error)}`)),
		);
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
				yield* Ref.update(cache, (m) => putCache(m, key, { stamp, index, loadedAt: Date.now() }));
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
							yield* Ref.update(cache, (m) => putCache(m, key, { ...hit, loadedAt: now }));
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
