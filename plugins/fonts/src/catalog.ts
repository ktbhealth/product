import { asc, eq } from "drizzle-orm";

import type { Json } from "effect/Schema";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Db, type DbClient } from "@ktb/db";
import { fontFamilies, fontProviders } from "@ktb/db/schema";

import type { FontFamilyStatus } from "./types.ts";

/**
 * FontCatalog — the consumer-facing read port over the synced
 * `font_families` catalog. Unlike `Fonts` (the PlatformAdmin-gated
 * admin surface), every method here is OPEN: family names, weights
 * and provider kinds are public branding reference data, and theme
 * resolution needs them on anonymous requests.
 *
 * The catalog is the fonts plugin's source of truth for managed font
 * families; consumers (theme `fonts.sources`) match against it at
 * resolve time — nothing here mutates state.
 */

/** One synced catalog row joined with its provider's adapter kind. */
export interface FontCatalogFamily {
	readonly id: number;
	readonly providerId: number;
	/** Owning provider's display name (`font_providers.name`) — lets
	 * pickers label a family "Provider — Family" unambiguously. */
	readonly providerName: string;
	/** Provider adapter kind ("local", "googlefonts", …) — drives how
	 * a consumer delivers the family (stylesheet link vs self-host). */
	readonly kind: string;
	readonly family: string;
	readonly weights: readonly number[];
	readonly status: FontFamilyStatus;
	readonly meta: Record<string, Json> | null;
}

const parseJson = (raw: string | null): unknown => {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
};

const asRecord = (raw: string | null): Record<string, Json> | null => {
	const value = parseJson(raw);
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, Json>)
		: null;
};

const asWeights = (raw: string | null): readonly number[] => {
	const value = parseJson(raw);
	return Array.isArray(value) ? value.filter((w): w is number => typeof w === "number") : [];
};

const toEntry = (
	row: typeof fontFamilies.$inferSelect,
	kind: string,
	providerName: string,
): FontCatalogFamily => ({
	id: row.id,
	providerId: row.providerId,
	providerName,
	kind,
	family: row.family,
	weights: asWeights(row.weights),
	status: row.status as FontFamilyStatus,
	meta: asRecord(row.meta),
});

/**
 * Every `font_families` row whose provider is ENABLED, ordered by
 * family name — the snapshot consumers cache and match against.
 * Disabled providers drop out entirely (their families stop
 * resolving on the next read); pending/failed rows stay listed so
 * consumers can filter on `status` themselves.
 */
export async function listCatalogRows(db: DbClient): Promise<readonly FontCatalogFamily[]> {
	const rows = await db
		.select({ family: fontFamilies, kind: fontProviders.kind, providerName: fontProviders.name })
		.from(fontFamilies)
		.innerJoin(fontProviders, eq(fontFamilies.providerId, fontProviders.id))
		.where(eq(fontProviders.enabled, true))
		.orderBy(asc(fontFamilies.family));
	return rows.map((r) => toEntry(r.family, r.kind, r.providerName));
}

export class FontCatalog extends Context.Service<
	FontCatalog,
	{
		/** All catalog rows on enabled providers (see {@link listCatalogRows}). */
		readonly list: () => Effect.Effect<readonly FontCatalogFamily[]>;
	}
>()("@ktb/fonts/FontCatalog") {}

export const FontCatalogLive = Layer.effect(
	FontCatalog,
	Effect.gen(function* () {
		const db = yield* Db;
		return FontCatalog.of({
			list: Effect.fn("FontCatalog.list")(function* () {
				return yield* Effect.promise(() => listCatalogRows(db));
			}),
		});
	}),
);
