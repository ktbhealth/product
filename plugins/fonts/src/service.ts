/**
 * Fonts domain port + repo: `font_providers` rows (one per configured
 * font source) and their synced `font_families` catalog.
 *
 * Every read/write is PlatformAdmin-gated — the catalog drives admin
 * surfaces today and theme font config later; there is no public read
 * path yet. After each committed mutation the service broadcasts to
 * every registered {@link FontHooks} handler (fire-and-forget — a
 * broken consumer logs and never fails the write) and dispatches the
 * matching event on the app `EventBus` when one is bound.
 */

import { Event, EventBus } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Json } from "effect/Schema";

import type { Forbidden } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { fontFamilies, fontProviders } from "@ktb/db/schema";
import { PlatformAdmin } from "@ktb/platform";

import { localFontProviderAdapter } from "./adapters/local.ts";
import { googleFontsAdapter } from "./adapters/googlefonts.ts";
import { FontsFamilySynced, FontsProviderChanged } from "./events.ts";
import { FontHooks, FontHooksLive, type FontHookHandle } from "./hooks.ts";
import { FontProviders, FontProvidersLive } from "./registry.ts";
import type {
	FontFamilyStatus,
	FontFamilySummary,
	FontProviderConfig,
	FontProviderSummary,
} from "./types.ts";

export type FontProviderRow = typeof fontProviders.$inferSelect;
export type FontFamilyRow = typeof fontFamilies.$inferSelect;

// ---------- repo (plain async fns; authz lives in the service) ----------

/** All provider rows, oldest first — admin list order. */
export async function listProviderRows(db: DbClient): Promise<FontProviderRow[]> {
	return db.select().from(fontProviders).orderBy(asc(fontProviders.id));
}

export async function findProviderRow(db: DbClient, id: number): Promise<FontProviderRow | null> {
	const rows = await db.select().from(fontProviders).where(eq(fontProviders.id, id)).limit(1);
	return rows[0] ?? null;
}

/** familyCount per provider id — one grouped query for the admin list. */
export async function countFamiliesByProvider(db: DbClient): Promise<Map<number, number>> {
	const rows = await db
		.select({ providerId: fontFamilies.providerId, n: sql<number>`count(*)` })
		.from(fontFamilies)
		.groupBy(fontFamilies.providerId);
	return new Map(rows.map((r) => [r.providerId, Number(r.n)]));
}

export async function insertProviderRow(
	db: DbClient,
	input: { kind: string; name: string; config: FontProviderConfig | null },
): Promise<FontProviderRow | null> {
	const now = new Date();
	const rows = await db
		.insert(fontProviders)
		.values({
			kind: input.kind,
			name: input.name,
			config: input.config === null ? null : JSON.stringify(input.config),
			enabled: true,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return rows[0] ?? null;
}

/** Patch a provider; `config` undefined preserves, null clears. */
export async function updateProviderRow(
	db: DbClient,
	id: number,
	patch: { name?: string; config?: FontProviderConfig | null },
): Promise<FontProviderRow | null> {
	const rows = await db
		.update(fontProviders)
		.set({
			...(patch.name !== undefined ? { name: patch.name } : {}),
			...(patch.config !== undefined
				? { config: patch.config === null ? null : JSON.stringify(patch.config) }
				: {}),
			updatedAt: new Date(),
		})
		.where(eq(fontProviders.id, id))
		.returning();
	return rows[0] ?? null;
}

export async function setProviderEnabledRow(
	db: DbClient,
	id: number,
	enabled: boolean,
): Promise<FontProviderRow | null> {
	const rows = await db
		.update(fontProviders)
		.set({ enabled, updatedAt: new Date() })
		.where(eq(fontProviders.id, id))
		.returning();
	return rows[0] ?? null;
}

/** Hard-delete — font_families rows cascade via the FK. */
export async function deleteProviderRow(db: DbClient, id: number): Promise<void> {
	await db.delete(fontProviders).where(eq(fontProviders.id, id));
}

export async function listFamilyRows(db: DbClient, providerId?: number): Promise<FontFamilyRow[]> {
	const base = db.select().from(fontFamilies);
	const rows =
		providerId === undefined
			? await base.orderBy(asc(fontFamilies.family))
			: await base.where(eq(fontFamilies.providerId, providerId)).orderBy(asc(fontFamilies.family));
	return rows;
}

export async function findFamilyRow(
	db: DbClient,
	providerId: number,
	family: string,
): Promise<FontFamilyRow | null> {
	const rows = await db
		.select()
		.from(fontFamilies)
		.where(and(eq(fontFamilies.providerId, providerId), eq(fontFamilies.family, family)))
		.limit(1);
	return rows[0] ?? null;
}

export async function insertFamilyRow(
	db: DbClient,
	input: {
		providerId: number;
		family: string;
		weights: readonly number[] | null;
		meta: Record<string, Json> | null;
	},
): Promise<FontFamilyRow | null> {
	const rows = await db
		.insert(fontFamilies)
		.values({
			providerId: input.providerId,
			family: input.family,
			weights: input.weights === null ? null : JSON.stringify(input.weights),
			status: "ready",
			meta: input.meta === null ? null : JSON.stringify(input.meta),
			createdAt: new Date(),
		})
		.returning();
	return rows[0] ?? null;
}

/** Sync update: refresh weights/meta, keep the stored status. */
export async function updateFamilyRow(
	db: DbClient,
	id: number,
	input: { weights: readonly number[] | null; meta: Record<string, Json> | null },
): Promise<void> {
	await db
		.update(fontFamilies)
		.set({
			weights: input.weights === null ? null : JSON.stringify(input.weights),
			meta: input.meta === null ? null : JSON.stringify(input.meta),
		})
		.where(eq(fontFamilies.id, id));
}

// ---------- DTO mapping ----------

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

export const summarizeProvider = (
	row: FontProviderRow,
	familyCount: number,
): FontProviderSummary => ({
	id: row.id,
	kind: row.kind,
	name: row.name,
	config: asRecord(row.config),
	enabled: row.enabled,
	familyCount,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt === null ? null : row.updatedAt.toISOString(),
});

export const summarizeFamily = (row: FontFamilyRow): FontFamilySummary => ({
	id: row.id,
	providerId: row.providerId,
	family: row.family,
	weights: asWeights(row.weights),
	status: row.status as FontFamilyStatus,
	meta: asRecord(row.meta),
});

// ---------- service ----------

export interface CreateFontProviderInput {
	readonly kind: string;
	readonly name: string;
	readonly config?: FontProviderConfig | null;
}

export interface UpdateFontProviderInput {
	readonly name?: string;
	readonly config?: FontProviderConfig | null;
}

export class Fonts extends Context.Service<
	Fonts,
	{
		/** All providers with synced family counts — admin list. */
		readonly listProviders: () => Effect.Effect<readonly FontProviderSummary[], Forbidden>;
		/** Registered adapter kinds — feeds the add-provider picker. */
		readonly providerKinds: () => Effect.Effect<readonly string[], Forbidden>;
		/** Insert a provider row; `kind` must name a registered adapter. */
		readonly createProvider: (
			input: CreateFontProviderInput,
		) => Effect.Effect<FontProviderSummary, Forbidden>;
		/** Patch name/config; dies when the provider is missing. */
		readonly updateProvider: (
			id: number,
			patch: UpdateFontProviderInput,
		) => Effect.Effect<FontProviderSummary, Forbidden>;
		readonly setProviderEnabled: (id: number, enabled: boolean) => Effect.Effect<void, Forbidden>;
		/** Hard-delete — families cascade via the FK; missing ids are
		 * a no-op (same contract as theme.remove). */
		readonly removeProvider: (id: number) => Effect.Effect<void, Forbidden>;
		/** Synced catalog rows, optionally scoped to one provider. */
		readonly listFamilies: (
			providerId?: number,
		) => Effect.Effect<readonly FontFamilySummary[], Forbidden>;
		/** Re-sync one provider's catalog from its adapter; returns the
		 * provider's family rows after the upsert. */
		readonly syncProvider: (id: number) => Effect.Effect<readonly FontFamilySummary[], Forbidden>;
	}
>()("@ktb/fonts/Fonts") {}

export const FontsLive = Layer.effect(
	Fonts,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		const providers = yield* FontProviders;
		const hooks = yield* FontHooks;
		// Optional like document-store: tests/embedded runtimes may run
		// without the bus — mutations then only notify hooks.
		const eventBus = yield* Effect.serviceOption(EventBus);

		// Built-in adapters register at layer build — the composition-time
		// act the registry contract documents. Other plugins register
		// additional kinds from their own services layers.
		providers.register(localFontProviderAdapter);
		providers.register(googleFontsAdapter);

		/** Broadcast one committed mutation to every registered hook —
		 * handler failures log and are swallowed so a broken consumer
		 * can never fail an admin write. */
		const notifyHooks = (handle: FontHookHandle) =>
			Effect.gen(function* () {
				for (const id of hooks.ids()) {
					yield* hooks
						.invoke(id, handle)
						.pipe(
							Effect.catchCause((cause) => Effect.logWarning(`font hook "${id}" failed`, cause)),
						);
				}
			});

		/** Publish on the app EventBus — a no-op when none is bound. */
		const publish = (event: Event.Base) =>
			Option.isNone(eventBus)
				? Effect.void
				: eventBus.value
						.dispatch([event])
						.pipe(
							Effect.catchCause((cause) => Effect.logWarning("fonts event dispatch failed", cause)),
						);

		/** provider.changed fan-out: hooks first, then the bus event. */
		const notifyProviderChanged = (row: FontProviderRow) =>
			Effect.all([
				notifyHooks({ event: "provider.changed", providerId: row.id, kind: row.kind }),
				publish(FontsProviderChanged.make({ providerId: row.id, kind: row.kind })),
			]);

		const providerSummary = (row: FontProviderRow) =>
			Effect.gen(function* () {
				const counts = yield* Effect.promise(() => countFamiliesByProvider(db));
				return summarizeProvider(row, counts.get(row.id) ?? 0);
			});

		return Fonts.of({
			listProviders: Effect.fn("Fonts.listProviders")(function* () {
				yield* platformAdmin.requireAdmin();
				const rows = yield* Effect.promise(() => listProviderRows(db));
				const counts = yield* Effect.promise(() => countFamiliesByProvider(db));
				return rows.map((row) => summarizeProvider(row, counts.get(row.id) ?? 0));
			}),
			providerKinds: Effect.fn("Fonts.providerKinds")(function* () {
				yield* platformAdmin.requireAdmin();
				return providers.kinds();
			}),
			createProvider: Effect.fn("Fonts.createProvider")(function* (input: CreateFontProviderInput) {
				yield* platformAdmin.requireAdmin();
				if (providers.get(input.kind) === undefined) {
					return yield* Effect.die(new Error(`unknown font provider kind: ${input.kind}`));
				}
				const row = yield* Effect.promise(() =>
					insertProviderRow(db, {
						kind: input.kind,
						name: input.name,
						config: input.config ?? null,
					}),
				);
				if (row === null) {
					return yield* Effect.die(new Error("font provider insert returned no row"));
				}
				yield* notifyProviderChanged(row);
				return summarizeProvider(row, 0);
			}),
			updateProvider: Effect.fn("Fonts.updateProvider")(function* (
				id: number,
				patch: UpdateFontProviderInput,
			) {
				yield* platformAdmin.requireAdmin();
				const row = yield* Effect.promise(() => updateProviderRow(db, id, patch));
				if (row === null) {
					return yield* Effect.die(new Error("font provider not found"));
				}
				yield* notifyProviderChanged(row);
				return yield* providerSummary(row);
			}),
			setProviderEnabled: Effect.fn("Fonts.setProviderEnabled")(function* (
				id: number,
				enabled: boolean,
			) {
				yield* platformAdmin.requireAdmin();
				const row = yield* Effect.promise(() => setProviderEnabledRow(db, id, enabled));
				if (row !== null) {
					yield* notifyProviderChanged(row);
				}
			}),
			removeProvider: Effect.fn("Fonts.removeProvider")(function* (id: number) {
				yield* platformAdmin.requireAdmin();
				const row = yield* Effect.promise(() => findProviderRow(db, id));
				yield* Effect.promise(() => deleteProviderRow(db, id));
				if (row !== null) {
					yield* notifyProviderChanged(row);
				}
			}),
			listFamilies: Effect.fn("Fonts.listFamilies")(function* (providerId?: number) {
				yield* platformAdmin.requireAdmin();
				const rows = yield* Effect.promise(() => listFamilyRows(db, providerId));
				return rows.map(summarizeFamily);
			}),
			syncProvider: Effect.fn("Fonts.syncProvider")(function* (id: number) {
				yield* platformAdmin.requireAdmin();
				const row = yield* Effect.promise(() => findProviderRow(db, id));
				if (row === null) {
					return yield* Effect.die(new Error("font provider not found"));
				}
				const adapter = providers.get(row.kind);
				if (adapter === undefined) {
					return yield* Effect.die(new Error(`unknown font provider kind: ${row.kind}`));
				}
				const entries = yield* adapter.list().pipe(Effect.provideService(Db, db), Effect.orDie);

				const synced: string[] = [];
				for (const entry of entries) {
					const family = entry.family.trim();
					if (family === "") continue;
					const weights = entry.weights === undefined ? null : [...entry.weights];
					const meta = entry.meta === undefined ? null : { ...entry.meta };
					const existing = yield* Effect.promise(() => findFamilyRow(db, row.id, family));
					if (existing === null) {
						yield* Effect.promise(() =>
							insertFamilyRow(db, {
								providerId: row.id,
								family,
								weights,
								meta,
							}),
						);
					} else {
						yield* Effect.promise(() => updateFamilyRow(db, existing.id, { weights, meta }));
					}
					synced.push(family);
				}

				yield* Effect.all([
					notifyHooks({
						event: "family.synced",
						providerId: row.id,
						kind: row.kind,
						families: synced,
					}),
					publish(FontsFamilySynced.make({ providerId: row.id, kind: row.kind })),
				]);

				const rows = yield* Effect.promise(() => listFamilyRows(db, row.id));
				return rows.map(summarizeFamily);
			}),
		});
	}),
);

/** The services-layer export: the Fonts runtime plus the
 * FontProviders/FontHooks registries other plugins consume (the
 * provideMerge chain wires them into FontsLive and re-exports them —
 * same shape as `TriggersServicesLive`/`WizardsServicesLive`). */
export const FontsServicesLive = FontsLive.pipe(
	Layer.provideMerge(FontProvidersLive),
	Layer.provideMerge(FontHooksLive),
);
