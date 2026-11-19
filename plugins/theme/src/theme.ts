/**
 * Theme domain port + repo (P-082): `theme_definitions` rows resolved
 * per request scope with the fallback chain
 * portal-instance → tenant → platform → main row → null (PL-006
 * phase 7 — the ui token defaults in globals.css are the final CSS
 * fallback; the KTB brand ships as a seeded main row on empty
 * databases, so fresh deploys still resolve real theme data).
 *
 * Reads are open — branding is public information and anonymous app
 * pages need it — while every write/list path requires the
 * PlatformAdmin gate (tenant-admin self-serve is a later phase).
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Forbidden } from "@ktb/authz";
import { Db, tx, type DbClient } from "@ktb/db";
import { themeDefinitions } from "@ktb/db/schema";
import { FontCatalog, type FontCatalogFamily } from "@ktb/fonts/catalog";
import { FontHooks } from "@ktb/fonts/hooks";
import { PlatformAdmin } from "@ktb/platform";
import { Tenant, tenantScopeId } from "@ktb/tenant";

import { KTB_DEFAULT_THEME } from "./default-theme.ts";
import { loadManagedFontAssets, matchManagedFonts } from "./managed-fonts.ts";
import { deriveThemeTokens } from "./palette.ts";
import { listThemeAssets } from "./assets.ts";
import {
	parseThemeBrand,
	parseThemeFontConfig,
	presentTheme,
	type ThemeDefinitionRow,
} from "./present.ts";
import type {
	ResolvedTheme,
	ThemeBrand,
	ThemeFontConfig,
	ThemeResolveRequest,
	ThemeAssetSummary,
	ThemeSeeds,
	ThemeSummary,
} from "./types.ts";

export type ThemeRow = typeof themeDefinitions.$inferSelect;

// ---------- repo (plain async fns; authz lives in the service) ----------

/** First ENABLED theme row matching (scope, scopeId), or null. */
export async function findTheme(
	db: DbClient,
	scope: string,
	scopeId: string,
): Promise<ThemeRow | null> {
	const rows = await db
		.select()
		.from(themeDefinitions)
		.where(
			and(
				eq(themeDefinitions.scope, scope),
				eq(themeDefinitions.scopeId, scopeId),
				eq(themeDefinitions.enabled, true),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

/** Row by id regardless of enabled — admin preview/inspection. */
export async function getThemeById(db: DbClient, id: number): Promise<ThemeRow | null> {
	const rows = await db.select().from(themeDefinitions).where(eq(themeDefinitions.id, id)).limit(1);
	return rows[0] ?? null;
}

/** All definitions for the admin list — enabled flag included. */
export async function listThemes(db: DbClient): Promise<ThemeRow[]> {
	return db
		.select()
		.from(themeDefinitions)
		.orderBy(asc(themeDefinitions.scope), asc(themeDefinitions.scopeId));
}

/** First ENABLED row flagged is_main — resolve()'s last fallback
 * before giving up (lowest id wins if the invariant is ever broken). */
export async function findMainTheme(db: DbClient): Promise<ThemeRow | null> {
	const rows = await db
		.select()
		.from(themeDefinitions)
		.where(and(eq(themeDefinitions.isMain, true), eq(themeDefinitions.enabled, true)))
		.orderBy(asc(themeDefinitions.id))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Swap the main flag to `id` atomically — clears is_main on every row,
 * then sets it on the target. `tx()` batches atomically on every
 * dialect (D1 batch / better-sqlite3 transaction).
 */
export async function setThemeMain(db: DbClient, id: number): Promise<void> {
	const now = new Date();
	await tx(db, [
		db
			.update(themeDefinitions)
			.set({ isMain: false, updatedAt: now })
			.where(eq(themeDefinitions.isMain, true)),
		db
			.update(themeDefinitions)
			.set({ isMain: true, updatedAt: now })
			.where(eq(themeDefinitions.id, id)),
	]);
}

export interface ThemePublishInput {
	readonly id?: number;
	readonly scope: string;
	readonly scopeId: string;
	readonly appName?: string | null;
	readonly seeds: ThemeSeeds;
	readonly fonts?: ThemeFontConfig | null;
	readonly brand?: ThemeBrand | null;
}

const tokensJson = (seeds: ThemeSeeds): string => JSON.stringify(deriveThemeTokens(seeds));

/**
 * Insert or update the (scope, scopeId) row — publish is an upsert so
 * re-publishing bumps `version` instead of duplicating. `tokens` is
 * derived here for inspection; readers re-derive from seeds anyway.
 * `is_main` is never touched: new rows default to false, updates keep
 * the stored flag — only setThemeMain may move it.
 */
export async function upsertTheme(
	db: DbClient,
	input: ThemePublishInput,
	existingId?: number,
): Promise<ThemeRow | null> {
	const now = new Date();
	const base = {
		scope: input.scope,
		scopeId: input.scopeId,
		seeds: JSON.stringify(input.seeds),
		tokens: tokensJson(input.seeds),
		updatedAt: now,
	};
	if (existingId !== undefined) {
		const rows = await db
			.update(themeDefinitions)
			// version bumps on every publish — informational, never a
			// concurrency token (upsert is keyed by natural scope). Undefined
			// optional columns preserve the stored value; explicit null clears.
			.set({
				...base,
				...(input.appName !== undefined ? { appName: input.appName } : {}),
				...(input.fonts !== undefined
					? { fonts: input.fonts === null ? null : JSON.stringify(input.fonts) }
					: {}),
				...(input.brand !== undefined
					? { brand: input.brand === null ? null : JSON.stringify(input.brand) }
					: {}),
				version: sql`${themeDefinitions.version} + 1`,
			})
			.where(eq(themeDefinitions.id, existingId))
			.returning();
		return rows[0] ?? null;
	}
	const rows = await db
		.insert(themeDefinitions)
		// New themes publish enabled; updates keep the stored flag —
		// re-publishing a disabled theme must not silently re-enable it.
		.values({
			...base,
			appName: input.appName ?? null,
			fonts: input.fonts === undefined || input.fonts === null ? null : JSON.stringify(input.fonts),
			brand: input.brand === undefined || input.brand === null ? null : JSON.stringify(input.brand),
			enabled: true,
			createdAt: now,
		})
		.returning();
	return rows[0] ?? null;
}

export async function setThemeEnabled(db: DbClient, id: number, enabled: boolean) {
	await db
		.update(themeDefinitions)
		.set({ enabled, updatedAt: new Date() })
		.where(eq(themeDefinitions.id, id));
}

/** Hard-delete a definition row — theme_assets.theme_id goes null via
 * its ON DELETE SET NULL foreign key. The service guards the main row
 * before calling this. */
export async function deleteTheme(db: DbClient, id: number): Promise<void> {
	await db.delete(themeDefinitions).where(eq(themeDefinitions.id, id));
}

/**
 * Create-only seed (rbac seed.ts precedent): when the table is EMPTY,
 * insert the KTB default as a real platform row flagged is_main —
 * the resolve() fallback that replaced the old runtime constant.
 * Returns true when a row was inserted. onConflictDoNothing covers a
 * concurrent boot racing the same seed; the caller logs-and-swallows
 * any failure so seeding never breaks boot.
 */
export async function seedDefaultTheme(db: DbClient): Promise<boolean> {
	const existing = await db.select({ id: themeDefinitions.id }).from(themeDefinitions).limit(1);
	if (existing.length > 0) return false;
	const now = new Date();
	await db
		.insert(themeDefinitions)
		.values({
			scope: "platform",
			scopeId: "",
			appName: KTB_DEFAULT_THEME.appName,
			seeds: JSON.stringify(KTB_DEFAULT_THEME.seeds),
			tokens: tokensJson(KTB_DEFAULT_THEME.seeds),
			fonts: KTB_DEFAULT_THEME.fonts === null ? null : JSON.stringify(KTB_DEFAULT_THEME.fonts),
			brand: KTB_DEFAULT_THEME.brand === null ? null : JSON.stringify(KTB_DEFAULT_THEME.brand),
			enabled: true,
			isMain: true,
			createdAt: now,
		})
		.onConflictDoNothing();
	return true;
}

// ---------- scope → candidate chain ----------

export interface ThemeCandidate {
	readonly scope: string;
	readonly scopeId: string;
}

/** Ordered fallback chain for a resolve request. The bound `Tenant`
 * contributes the tenant candidate when present (personal scope skips
 * it). Exported for tests — the chain is the contract. */
export const themeCandidates = (
	request: ThemeResolveRequest,
	tenantId: number | null,
): readonly ThemeCandidate[] => {
	const tenantCandidate: ThemeCandidate[] =
		tenantId === null ? [] : [{ scope: "tenant", scopeId: String(tenantId) }];
	const platform: ThemeCandidate = { scope: "platform", scopeId: "" };
	switch (request.scope) {
		case "platform":
			return [platform];
		case "tenant":
		case "session":
			return [...tenantCandidate, platform];
		case "portal-instance":
			return [{ scope: "portal-instance", scopeId: request.id }, ...tenantCandidate, platform];
	}
};

// ---------- domain port ----------

/**
 * Theme port — Effect service, swappable in tests.
 *
 * - `resolve` never fails on missing themes — an unmatched chain
 *   falls back to the enabled `is_main` row, then returns null so the
 *   ui token defaults in globals.css apply — and tolerates per-scope
 *   read failures by falling through the chain: branding must never
 *   take a page down.
 * - `list`/`get`/`publish`/`setEnabled`/`setMain`/`remove` are
 *   PlatformAdmin-gated (defense in depth; the /platform/theme page
 *   guard 404s first).
 */
export class Theme extends Context.Service<
	Theme,
	{
		readonly resolve: (request?: ThemeResolveRequest) => Effect.Effect<ResolvedTheme | null>;
		readonly list: () => Effect.Effect<ThemeSummary[], Forbidden>;
		/** Full presented theme by id — the admin editor loads seeds,
		 * fonts and brand through this. Admin-gated. */
		readonly get: (id: number) => Effect.Effect<ResolvedTheme | null, Forbidden>;
		readonly publish: (input: ThemePublishInput) => Effect.Effect<ThemeSummary, Forbidden>;
		readonly setEnabled: (id: number, enabled: boolean) => Effect.Effect<void, Forbidden>;
		/** Move the is_main flag to `id` — exactly one row stays main.
		 * Admin-gated. */
		readonly setMain: (id: number) => Effect.Effect<void, Forbidden>;
		/** Hard-delete a theme definition (e.g. an untouched auto-created
		 * editor draft). Admin-gated; the main row cannot be deleted. */
		readonly remove: (id: number) => Effect.Effect<void, Forbidden>;
		/** Upload/processing rows for one theme — admin editor asset tab. */
		readonly listAssets: (themeId: number) => Effect.Effect<ThemeAssetSummary[], Forbidden>;
		/** Raw row for the admin preview path — ignores `enabled` so a
		 * draft/disabled theme can be previewed; admin-gated. */
		readonly previewRow: (id: number) => Effect.Effect<ThemeRow | null, Forbidden>;
	}
>()("@ktb/theme/Theme") {}

const summarize = (row: ThemeRow): ThemeSummary => ({
	id: row.id,
	scope: row.scope as ThemeSummary["scope"],
	scopeId: row.scopeId,
	appName: row.appName,
	enabled: row.enabled,
	isMain: row.isMain,
	version: row.version,
	brand: parseThemeBrand(row.brand),
});

const summarizeAsset = (row: {
	id: number;
	themeId: number | null;
	kind: string;
	status: string;
	r2Key: string | null;
	variants: string | null;
	createdAt: Date;
}): ThemeAssetSummary => {
	let variants: ThemeAssetSummary["variants"] = null;
	if (row.variants !== null) {
		try {
			variants = JSON.parse(row.variants) as ThemeAssetSummary["variants"];
		} catch {
			variants = null;
		}
	}
	return {
		id: row.id,
		themeId: row.themeId,
		kind: row.kind as ThemeAssetSummary["kind"],
		status: row.status,
		r2Key: row.r2Key,
		variants,
		createdAt: row.createdAt.toISOString(),
	};
};

export const ThemeLive = Layer.effect(
	Theme,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;

		// Optional edge (fonts.services dep): the fonts plugin's open
		// catalog port — absent it, `fonts.sources` managed references
		// simply never resolve and free-form families keep working.
		const fontCatalog = yield* Effect.serviceOption(FontCatalog);
		// Same optional edge for the change-notification registry: every
		// committed provider/family mutation clears the cached catalog
		// snapshot so the next resolve re-reads font_families (the
		// FontHooks broadcast contract — see plugins/fonts/src/hooks.ts).
		const fontHooks = yield* Effect.serviceOption(FontHooks);
		const catalogCache = yield* Ref.make<readonly FontCatalogFamily[] | null>(null);
		if (Option.isSome(fontHooks)) {
			fontHooks.value.register("theme.font-catalog", () =>
				Ref.set(catalogCache, null).pipe(Effect.asVoid),
			);
		}

		/** Cached catalog snapshot — branding must never take a page
		 * down, so read failures degrade to an empty catalog (managed
		 * sources fall back) and are NOT cached: the next resolve
		 * retries the read. */
		const catalogSnapshot = Effect.gen(function* () {
			if (Option.isNone(fontCatalog)) return [] as readonly FontCatalogFamily[];
			const hit = yield* Ref.get(catalogCache);
			if (hit !== null) return hit;
			const entries = yield* fontCatalog.value
				.list()
				.pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("font catalog read failed", cause).pipe(Effect.as(null)),
					),
				);
			if (entries === null) return [] as readonly FontCatalogFamily[];
			yield* Ref.set(catalogCache, entries);
			return entries;
		});

		/** Present a row with the managed-font cascade applied: match
		 * `fonts.sources` against the catalog snapshot, resolve self-host
		 * assets, then hand the resolutions to presentTheme. Rows without
		 * sources skip the catalog read entirely. */
		const presentRow = (row: ThemeRow) =>
			Effect.gen(function* () {
				const fonts = parseThemeFontConfig(row.fonts);
				if (fonts?.sources === undefined) {
					return presentTheme(row as ThemeDefinitionRow);
				}
				const matched = matchManagedFonts(fonts, yield* catalogSnapshot);
				if (matched.length === 0) {
					return presentTheme(row as ThemeDefinitionRow);
				}
				const managed = yield* Effect.promise(() => loadManagedFontAssets(db, matched)).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("managed font asset read failed", cause).pipe(Effect.as(matched)),
					),
				);
				return presentTheme(row as ThemeDefinitionRow, { managed });
			});

		// Create-only seed: an empty theme_definitions table gets the KTB
		// default as the main row so resolve() always has brand data on
		// fresh deploys. Failure is logged, never fatal — branding must
		// not take boot down (rbac seed.ts precedent).
		yield* Effect.promise(() => seedDefaultTheme(db)).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("theme default seed failed", cause).pipe(Effect.as(false)),
			),
		);

		const resolve = Effect.fn("Theme.resolve")(function* (
			request: ThemeResolveRequest = { scope: "session" },
		) {
			const tenant = yield* Tenant;
			const candidates = themeCandidates(request, tenantScopeId(tenant));
			for (const candidate of candidates) {
				const row = yield* Effect.promise(() =>
					findTheme(db, candidate.scope, candidate.scopeId),
				).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("theme resolve read failed", cause).pipe(
							Effect.as(null as ThemeRow | null),
						),
					),
				);
				if (row !== null) return yield* presentRow(row);
			}
			// Chain missed → the enabled is_main row is the fallback.
			const main = yield* Effect.promise(() => findMainTheme(db)).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("theme main read failed", cause).pipe(
						Effect.as(null as ThemeRow | null),
					),
				),
			);
			// No main row either → null; the ui token defaults in
			// globals.css are the final CSS fallback.
			return main === null ? null : yield* presentRow(main);
		});

		return Theme.of({
			resolve,
			list: Effect.fn("Theme.list")(function* () {
				yield* platformAdmin.requireAdmin();
				const rows = yield* Effect.promise(() => listThemes(db));
				return rows.map(summarize);
			}),
			get: Effect.fn("Theme.get")(function* (id: number) {
				yield* platformAdmin.requireAdmin();
				const row = yield* Effect.promise(() => getThemeById(db, id));
				return row === null ? null : yield* presentRow(row);
			}),
			publish: Effect.fn("Theme.publish")(function* (input: ThemePublishInput) {
				yield* platformAdmin.requireAdmin();
				// Editor publishes carry the row id — update that row
				// directly so scope moves are allowed; missing rows die.
				if (input.id !== undefined) {
					const existing = yield* Effect.promise(() => getThemeById(db, input.id!));
					if (existing === null) {
						return yield* Effect.die(new Error("theme not found"));
					}
					const row = yield* Effect.promise(() => upsertTheme(db, input, input.id));
					if (row === null) {
						return yield* Effect.die(new Error("theme upsert returned no row"));
					}
					return summarize(row);
				}
				// Existing row for this scope wins the update path — upsert
				// by natural key, not by client-supplied id.
				const existing = yield* Effect.promise(() => findThemeAny(db, input.scope, input.scopeId));
				const row = yield* Effect.promise(() => upsertTheme(db, input, existing?.id));
				if (row === null) {
					return yield* Effect.die(new Error("theme upsert returned no row"));
				}
				return summarize(row);
			}),
			setEnabled: Effect.fn("Theme.setEnabled")(function* (id: number, enabled: boolean) {
				yield* platformAdmin.requireAdmin();
				yield* Effect.promise(() => setThemeEnabled(db, id, enabled));
			}),
			setMain: Effect.fn("Theme.setMain")(function* (id: number) {
				yield* platformAdmin.requireAdmin();
				const existing = yield* Effect.promise(() => getThemeById(db, id));
				if (existing === null) {
					return yield* Effect.die(new Error("theme not found"));
				}
				yield* Effect.promise(() => setThemeMain(db, id));
			}),
			remove: Effect.fn("Theme.remove")(function* (id: number) {
				yield* platformAdmin.requireAdmin();
				const row = yield* Effect.promise(() => getThemeById(db, id));
				if (row?.isMain === true) {
					return yield* Effect.die(new Error("cannot delete the main theme"));
				}
				yield* Effect.promise(() => deleteTheme(db, id));
			}),
			listAssets: Effect.fn("Theme.listAssets")(function* (themeId: number) {
				yield* platformAdmin.requireAdmin();
				const rows = yield* Effect.promise(() => listThemeAssets(db, themeId));
				return rows.map(summarizeAsset);
			}),
			previewRow: Effect.fn("Theme.previewRow")(function* (id: number) {
				yield* platformAdmin.requireAdmin();
				return yield* Effect.promise(() => getThemeById(db, id));
			}),
		});
	}),
);

/** Like findTheme but ignores the enabled flag — publish updates
 * disabled rows too. */
async function findThemeAny(
	db: DbClient,
	scope: string,
	scopeId: string,
): Promise<ThemeRow | null> {
	const rows = await db
		.select()
		.from(themeDefinitions)
		.where(and(eq(themeDefinitions.scope, scope), eq(themeDefinitions.scopeId, scopeId)))
		.limit(1);
	return rows[0] ?? null;
}
