/**
 * Theme domain port + repo (P-082): `theme_definitions` rows resolved
 * per request scope with the fallback chain
 * portal-instance → tenant → platform → built-in KTB default (PL-006
 * phase 7 — brand lives in theme data even with zero rows; the ui
 * token defaults in globals.css remain the final CSS fallback).
 *
 * Reads are open — branding is public information and anonymous app
 * pages need it — while every write/list path requires the
 * PlatformAdmin gate (tenant-admin self-serve is a later phase).
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Forbidden } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { themeDefinitions } from "@ktb/db/schema";
import { PlatformAdmin } from "@ktb/platform";
import { Tenant, tenantScopeId } from "@ktb/tenant";

import { KTB_DEFAULT_THEME } from "./default-theme.ts";
import { deriveThemeTokens } from "./palette.ts";
import { presentTheme, type ThemeDefinitionRow } from "./present.ts";
import type {
	ResolvedTheme,
	ThemeBrand,
	ThemeFontConfig,
	ThemeResolveRequest,
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

export interface ThemePublishInput {
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
 */
export async function upsertTheme(
	db: DbClient,
	input: ThemePublishInput,
	existingId?: number,
): Promise<ThemeRow | null> {
	const now = new Date();
	const values = {
		scope: input.scope,
		scopeId: input.scopeId,
		appName: input.appName ?? null,
		seeds: JSON.stringify(input.seeds),
		tokens: tokensJson(input.seeds),
		fonts: input.fonts === undefined || input.fonts === null ? null : JSON.stringify(input.fonts),
		brand: input.brand === undefined || input.brand === null ? null : JSON.stringify(input.brand),
		updatedAt: now,
	};
	if (existingId !== undefined) {
		const rows = await db
			.update(themeDefinitions)
			// version bumps on every publish — informational, never a
			// concurrency token (upsert is keyed by natural scope).
			.set({ ...values, version: sql`${themeDefinitions.version} + 1` })
			.where(eq(themeDefinitions.id, existingId))
			.returning();
		return rows[0] ?? null;
	}
	const rows = await db
		.insert(themeDefinitions)
		// New themes publish enabled; updates keep the stored flag —
		// re-publishing a disabled theme must not silently re-enable it.
		.values({ ...values, enabled: true, createdAt: now })
		.returning();
	return rows[0] ?? null;
}

export async function setThemeEnabled(db: DbClient, id: number, enabled: boolean) {
	await db
		.update(themeDefinitions)
		.set({ enabled, updatedAt: new Date() })
		.where(eq(themeDefinitions.id, id));
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
 *   returns the built-in KTB default (`KTB_DEFAULT_THEME`, id 0) so
 *   every shell always has brand/tokens/fonts — and tolerates
 *   per-scope read failures by falling through the chain: branding
 *   must never take a page down.
 * - `list`/`get`/`publish`/`setEnabled` are PlatformAdmin-gated
 *   (defense in depth; the /platform/theme page guard 404s first).
 */
export class Theme extends Context.Service<
	Theme,
	{
		readonly resolve: (request?: ThemeResolveRequest) => Effect.Effect<ResolvedTheme>;
		readonly list: () => Effect.Effect<ThemeSummary[], Forbidden>;
		/** Full presented theme by id — the admin editor loads seeds,
		 * fonts and brand through this. Admin-gated. */
		readonly get: (id: number) => Effect.Effect<ResolvedTheme | null, Forbidden>;
		readonly publish: (input: ThemePublishInput) => Effect.Effect<ThemeSummary, Forbidden>;
		readonly setEnabled: (id: number, enabled: boolean) => Effect.Effect<void, Forbidden>;
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
	version: row.version,
});

export const ThemeLive = Layer.effect(
	Theme,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;

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
				if (row !== null) return presentTheme(row as ThemeDefinitionRow);
			}
			// No row anywhere in the chain → the built-in KTB default.
			// Returning a theme (never null) keeps brand/favicon/title
			// theme-driven on fresh deploys and when the theme plugin is
			// disabled (service layers always compose — P-058).
			return KTB_DEFAULT_THEME;
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
				return row === null ? null : presentTheme(row);
			}),
			publish: Effect.fn("Theme.publish")(function* (input: ThemePublishInput) {
				yield* platformAdmin.requireAdmin();
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
