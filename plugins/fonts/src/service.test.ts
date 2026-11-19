import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeEventBus, EventBus, type EventBusShape } from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient, type SqlDatabase } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";

import { FontsFamilySynced, FontsProviderChanged } from "./events.ts";
import { FontHooks, type FontHookHandle } from "./hooks.ts";
import { FontProviders } from "./registry.ts";
import {
	countFamiliesByProvider,
	deleteProviderRow,
	findFamilyRow,
	findProviderRow,
	Fonts,
	FontsServicesLive,
	insertFamilyRow,
	insertProviderRow,
	listFamilyRows,
	setProviderEnabledRow,
	summarizeFamily,
	summarizeProvider,
	updateFamilyRow,
	updateProviderRow,
} from "./service.ts";
import type { FontFamilySummary } from "./types.ts";

const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE font_providers (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	kind text NOT NULL,
	name text NOT NULL,
	config text,
	enabled integer DEFAULT true NOT NULL,
	created_at integer NOT NULL,
	updated_at integer
);
CREATE TABLE font_families (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	provider_id integer NOT NULL REFERENCES font_providers(id) ON DELETE CASCADE,
	family text NOT NULL,
	weights text,
	status text DEFAULT 'pending' NOT NULL,
	meta text,
	created_at integer NOT NULL
);
CREATE UNIQUE INDEX font_families_provider_family_idx ON font_families(provider_id, family);
CREATE TABLE theme_definitions (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	scope text NOT NULL,
	scope_id text DEFAULT '' NOT NULL,
	app_name text,
	seeds text NOT NULL,
	tokens text NOT NULL,
	fonts text,
	brand text,
	enabled integer DEFAULT true NOT NULL,
	version integer DEFAULT 1 NOT NULL,
	created_at integer NOT NULL,
	updated_at integer
);
CREATE TABLE theme_assets (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	theme_id integer REFERENCES theme_definitions(id) ON DELETE SET NULL,
	kind text NOT NULL,
	r2_key text,
	status text DEFAULT 'pending' NOT NULL,
	variants text,
	created_at integer NOT NULL
);
`;

const makeTestDb = () => {
	const d1 = makeD1(DDL);
	return { db: makeDb(d1), d1 };
};

const all = async <T>(d1: SqlDatabase, query: string, params: unknown[] = []) =>
	(
		await d1
			.prepare(query)
			.bind(...params)
			.all<T>()
	).results as T[];

const run = (d1: SqlDatabase, query: string, params: unknown[] = []) =>
	d1
		.prepare(query)
		.bind(...params)
		.run();

// ---------- repo helpers ----------

describe("fonts repo helpers", () => {
	it("insert/find/update provider rows round-trip config JSON", async () => {
		const { db } = makeTestDb();
		const created = await insertProviderRow(db, {
			kind: "googlefonts",
			name: "Google",
			config: { subset: "latin" },
		});
		expect(created).toMatchObject({ kind: "googlefonts", name: "Google", enabled: true });
		const found = await findProviderRow(db, created!.id);
		expect(found?.config).toBe(JSON.stringify({ subset: "latin" }));

		const patched = await updateProviderRow(db, created!.id, {
			name: "Google Fonts",
			config: null,
		});
		expect(patched?.name).toBe("Google Fonts");
		expect(patched?.config).toBeNull();
		// undefined config preserves the stored value.
		const again = await updateProviderRow(db, created!.id, { name: "GF" });
		expect(again?.config).toBeNull();
		expect(await updateProviderRow(db, 999, { name: "x" })).toBeNull();
	});

	it("setProviderEnabledRow flips the flag", async () => {
		const { db } = makeTestDb();
		const row = await insertProviderRow(db, { kind: "local", name: "Local", config: null });
		await setProviderEnabledRow(db, row!.id, false);
		expect((await findProviderRow(db, row!.id))?.enabled).toBe(false);
		await setProviderEnabledRow(db, row!.id, true);
		expect((await findProviderRow(db, row!.id))?.enabled).toBe(true);
	});

	it("family rows upsert by (provider, family) helpers and summarize", async () => {
		const { db } = makeTestDb();
		const provider = await insertProviderRow(db, {
			kind: "googlefonts",
			name: "G",
			config: null,
		});
		const fam = await insertFamilyRow(db, {
			providerId: provider!.id,
			family: "Inter",
			weights: [400, 700],
			meta: { source: "googlefonts" },
		});
		expect(fam?.status).toBe("ready");
		const found = await findFamilyRow(db, provider!.id, "Inter");
		expect(found?.id).toBe(fam?.id);
		await updateFamilyRow(db, fam!.id, { weights: [400], meta: null });
		const updated = await findFamilyRow(db, provider!.id, "Inter");
		expect(JSON.parse(updated!.weights!)).toEqual([400]);
		expect(updated!.meta).toBeNull();
		expect(updated!.status).toBe("ready"); // status preserved
		expect((await listFamilyRows(db, provider!.id)).map((f) => f.family)).toEqual(["Inter"]);
		expect(await listFamilyRows(db, 999)).toEqual([]);
	});

	it("countFamiliesByProvider groups counts", async () => {
		const { db } = makeTestDb();
		const p1 = await insertProviderRow(db, { kind: "a", name: "A", config: null });
		const p2 = await insertProviderRow(db, { kind: "b", name: "B", config: null });
		await insertFamilyRow(db, { providerId: p1!.id, family: "X", weights: null, meta: null });
		await insertFamilyRow(db, { providerId: p1!.id, family: "Y", weights: null, meta: null });
		await insertFamilyRow(db, { providerId: p2!.id, family: "Z", weights: null, meta: null });
		const counts = await countFamiliesByProvider(db);
		expect(counts.get(p1!.id)).toBe(2);
		expect(counts.get(p2!.id)).toBe(1);
	});

	it("updateProviderRow serializes a config-only patch; missing enabled rows return null", async () => {
		const { db } = makeTestDb();
		const row = await insertProviderRow(db, { kind: "a", name: "A", config: null });
		const patched = await updateProviderRow(db, row!.id, { config: { b: 2 } });
		expect(JSON.parse(patched!.config!)).toEqual({ b: 2 });
		expect(patched!.name).toBe("A");
		expect(await setProviderEnabledRow(db, 9999, false)).toBeNull();
	});

	it("insert helpers return null when the driver yields no row", async () => {
		const emptyDb = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as DbClient;
		expect(await insertProviderRow(emptyDb, { kind: "a", name: "A", config: null })).toBeNull();
		expect(
			await insertFamilyRow(emptyDb, {
				providerId: 1,
				family: "F",
				weights: null,
				meta: null,
			}),
		).toBeNull();
	});

	it("updateFamilyRow clears weights and stores meta JSON", async () => {
		const { db } = makeTestDb();
		const provider = await insertProviderRow(db, {
			kind: "a",
			name: "A",
			config: null,
		});
		const fam = await insertFamilyRow(db, {
			providerId: provider!.id,
			family: "F",
			weights: [400],
			meta: null,
		});
		await updateFamilyRow(db, fam!.id, { weights: null, meta: { m: 1 } });
		const row = await findFamilyRow(db, provider!.id, "F");
		expect(row!.weights).toBeNull();
		expect(JSON.parse(row!.meta!)).toEqual({ m: 1 });
	});

	it("summarizeProvider reports a null updatedAt", async () => {
		const { db, d1 } = makeTestDb();
		const row = await insertProviderRow(db, { kind: "a", name: "A", config: null });
		await run(d1, `UPDATE font_providers SET updated_at = NULL WHERE id = ?`, [row!.id]);
		const found = await findProviderRow(db, row!.id);
		expect(summarizeProvider(found!, 0).updatedAt).toBeNull();
	});

	it("deleteProviderRow removes the row and cascades families", async () => {
		const { db, d1 } = makeTestDb();
		const provider = await insertProviderRow(db, { kind: "a", name: "A", config: null });
		await insertFamilyRow(db, {
			providerId: provider!.id,
			family: "X",
			weights: null,
			meta: null,
		});
		await deleteProviderRow(db, provider!.id);
		expect(await findProviderRow(db, provider!.id)).toBeNull();
		expect(
			await all(d1, `SELECT * FROM font_families WHERE provider_id = ?`, [provider!.id]),
		).toEqual([]);
	});

	it("summarize helpers decode stored JSON", async () => {
		const { db } = makeTestDb();
		const provider = await insertProviderRow(db, {
			kind: "googlefonts",
			name: "G",
			config: { a: 1 },
		});
		const summary = summarizeProvider(provider!, 3);
		expect(summary).toMatchObject({
			kind: "googlefonts",
			name: "G",
			config: { a: 1 },
			enabled: true,
			familyCount: 3,
		});
		expect(summary.createdAt).toMatch(/T/);
		expect(summary.updatedAt).toMatch(/T/);
		const fam = await insertFamilyRow(db, {
			providerId: provider!.id,
			family: "Inter",
			weights: [400, 700],
			meta: { m: true },
		});
		const famSummary: FontFamilySummary = summarizeFamily(fam!);
		expect(famSummary).toMatchObject({
			providerId: provider!.id,
			family: "Inter",
			weights: [400, 700],
			status: "ready",
			meta: { m: true },
		});
		// Corrupt JSON degrades to empty shapes, never throws.
		const { db: db2, d1: d1_2 } = makeTestDb();
		const raw = await insertProviderRow(db2, { kind: "x", name: "X", config: null });
		await run(d1_2, `UPDATE font_providers SET config = '{bad' WHERE id = ?`, [raw!.id]);
		const corrupt = await findProviderRow(db2, raw!.id);
		expect(summarizeProvider(corrupt!, 0).config).toBeNull();
	});
});

// ---------- FontsLive service ----------

const ADMIN = { userId: "u-admin", email: "admin@x.com" };
const PLAIN = { userId: "u-plain", email: "plain@x.com" };

const withFonts = <A, E>(effect: (fonts: Fonts["Service"]) => Effect.Effect<A, E, never>) =>
	Effect.gen(function* () {
		const fonts = yield* Fonts;
		return yield* effect(fonts);
	});

const asUser = <A, E>(
	user: { userId: string; email: string },
	effect: Effect.Effect<A, E, Fonts>,
) => effect.pipe(Effect.provideService(Principal, user));

describe("FontsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Fonts | EventBus | FontHooks | FontProviders, never>;
	let db: DbClient;
	let d1: SqlDatabase;
	let bus: EventBusShape;
	const hookHandles: FontHookHandle[] = [];
	const busEvents: { tag: string; payload: unknown }[] = [];

	beforeAll(async () => {
		({ db, d1 } = makeTestDb());
		const infra = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			makeEventBus(),
		);
		runtime = ManagedRuntime.make(
			Layer.mergeAll(FontsServicesLive.pipe(Layer.provide(infra)), infra) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				bus = yield* EventBus;
				const hooks = yield* FontHooks;
				hooks.register("capture", (handle) =>
					Effect.sync(() => {
						hookHandles.push(handle);
					}),
				);
				hooks.register("broken", () => Effect.die(new Error("boom")));
				const capture = (event: { _tag: string }) =>
					Effect.sync(() => {
						busEvents.push({ tag: event._tag, payload: event });
					});
				yield* bus.subscribe(FontsProviderChanged, capture);
				yield* bus.subscribe(FontsFamilySynced, capture);
			}),
		);
	});

	afterAll(() => runtime.dispose());

	const admin = <A, E>(effect: (fonts: Fonts["Service"]) => Effect.Effect<A, E, never>) =>
		runtime.runPromise(asUser(ADMIN, withFonts(effect)));

	it("providerKinds returns the built-in adapter kinds sorted", async () => {
		const kinds = await admin((f) => f.providerKinds());
		expect(kinds).toEqual(["googlefonts", "local"]);
	});

	it("denies every method to non-admin principals", async () => {
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withFonts((f) => f.listProviders()),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withFonts((f) => f.createProvider({ kind: "local", name: "x" })),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withFonts((f) => f.listFamilies()),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("createProvider inserts and notifies hooks + bus", async () => {
		hookHandles.length = 0;
		busEvents.length = 0;
		const provider = await admin((f) =>
			f.createProvider({ kind: "googlefonts", name: "Google Fonts" }),
		);
		expect(provider).toMatchObject({
			kind: "googlefonts",
			name: "Google Fonts",
			enabled: true,
			familyCount: 0,
		});
		expect(hookHandles).toContainEqual({
			event: "provider.changed",
			providerId: provider.id,
			kind: "googlefonts",
		});
		expect(busEvents.map((e) => e.tag)).toContain("fonts.provider.changed");
	});

	it("createProvider dies on an unregistered kind", async () => {
		await expect(admin((f) => f.createProvider({ kind: "bogus", name: "nope" }))).rejects.toThrow(
			/unknown font provider kind/,
		);
	});

	it("updateProvider patches name/config and dies when missing", async () => {
		const provider = await admin((f) =>
			f.createProvider({ kind: "local", name: "Local", config: { a: 1 } }),
		);
		const updated = await admin((f) =>
			f.updateProvider(provider.id, { name: "Local fonts", config: null }),
		);
		expect(updated.name).toBe("Local fonts");
		expect(updated.config).toBeNull();
		await expect(admin((f) => f.updateProvider(9999, { name: "x" }))).rejects.toThrow(
			/font provider not found/,
		);
	});

	it("setProviderEnabled toggles and notifies", async () => {
		hookHandles.length = 0;
		const provider = await admin((f) => f.createProvider({ kind: "local", name: "Toggle me" }));
		await admin((f) => f.setProviderEnabled(provider.id, false));
		const listed = await admin((f) => f.listProviders());
		expect(listed.find((p) => p.id === provider.id)?.enabled).toBe(false);
		expect(hookHandles.at(-1)).toMatchObject({
			event: "provider.changed",
			providerId: provider.id,
		});
	});

	it("syncProvider upserts the googlefonts catalog idempotently", async () => {
		const provider = await admin((f) => f.createProvider({ kind: "googlefonts", name: "GF sync" }));
		const families = await admin((f) => f.syncProvider(provider.id));
		expect(families.length).toBeGreaterThan(30);
		expect(families.every((fam) => fam.status === "ready")).toBe(true);
		expect(families.map((fam) => fam.family)).toContain("Inter");
		const inter = families.find((fam) => fam.family === "Inter");
		expect(inter?.weights).toContain(400);

		// Second sync: same row count, weights refreshed, status kept.
		const again = await admin((f) => f.syncProvider(provider.id));
		expect(again.length).toBe(families.length);
		const counts = await countFamiliesByProvider(db);
		expect(counts.get(provider.id)).toBe(families.length);

		// family.synced hook fired with the family names.
		const synced = hookHandles.filter((h) => h.event === "family.synced");
		expect(synced.at(-1)).toMatchObject({
			providerId: provider.id,
			kind: "googlefonts",
		});
		expect(synced.at(-1)?.families).toContain("Inter");
		expect(busEvents.map((e) => e.tag)).toContain("fonts.family.synced");
	});

	it("syncProvider on the local adapter reads theme_assets font rows", async () => {
		// Seed a theme + a ready font asset whose variants carry a family.
		const themeId = (
			await all<{ id: number }>(
				d1,
				`INSERT INTO theme_definitions (scope, scope_id, seeds, tokens, fonts, created_at)
				 VALUES ('platform', '', '{}', '{}', '{"families":{"sans":"Inter","heading":"Playfair Display"},"weights":[400,700]}', 0)
				 RETURNING id`,
			)
		)[0]!.id;
		await run(
			d1,
			`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
			 VALUES (?, 'font', 'ready', '{"family":"Inter"}', 0)`,
			[themeId],
		);
		await run(
			d1,
			`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
			 VALUES (?, 'font', 'ready', '{"family":"Playfair Display"}', 0)`,
			[themeId],
		);
		// Pending rows must not leak into the catalog.
		await run(
			d1,
			`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
			 VALUES (?, 'font', 'pending', '{"family":"Nope"}', 0)`,
			[themeId],
		);

		const provider = await admin((f) => f.createProvider({ kind: "local", name: "Local fonts" }));
		const families = await admin((f) => f.syncProvider(provider.id));
		const names = families.map((fam) => fam.family).sort();
		expect(names).toEqual(["Inter", "Playfair Display"]);
	});

	it("listFamilies filters by provider and removeProvider cascades", async () => {
		const p1 = await admin((f) => f.createProvider({ kind: "googlefonts", name: "P1" }));
		const p2 = await admin((f) => f.createProvider({ kind: "local", name: "P2" }));
		await admin((f) => f.syncProvider(p1.id));
		const all = await admin((f) => f.listFamilies());
		const scoped = await admin((f) => f.listFamilies(p1.id));
		expect(scoped.length).toBeGreaterThan(0);
		expect(scoped.every((fam) => fam.providerId === p1.id)).toBe(true);
		expect(all.length).toBeGreaterThanOrEqual(scoped.length);

		await admin((f) => f.removeProvider(p1.id));
		const after = await admin((f) => f.listFamilies(p1.id));
		expect(after).toEqual([]);
		// p2 untouched.
		const remaining = await admin((f) => f.listProviders());
		expect(remaining.some((p) => p.id === p2.id)).toBe(true);
		// Missing id is a no-op.
		await admin((f) => f.removeProvider(9999));
	});

	it("syncProvider dies for missing provider", async () => {
		await expect(admin((f) => f.syncProvider(424242))).rejects.toThrow(/font provider not found/);
	});

	it("setProviderEnabled on a missing provider is a quiet no-op", async () => {
		hookHandles.length = 0;
		await admin((f) => f.setProviderEnabled(424242, false));
		expect(hookHandles).toEqual([]);
	});

	it("syncProvider dies when the row's kind has no registered adapter", async () => {
		const row = await insertProviderRow(db, {
			kind: "unregistered",
			name: "X",
			config: null,
		});
		await expect(admin((f) => f.syncProvider(row!.id))).rejects.toThrow(
			/unknown font provider kind/,
		);
	});

	it("syncProvider skips blank family names and nulls absent weights/meta", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const providers = yield* FontProviders;
				providers.register({
					kind: "testkit",
					list: () =>
						Effect.succeed([
							{ family: "   " },
							{ family: "Kit Sans" },
							{ family: "Kit Mono", weights: [400], meta: { hint: "m" } },
						]),
				});
			}),
		);
		const provider = await admin((f) => f.createProvider({ kind: "testkit", name: "Kit" }));
		const families = await admin((f) => f.syncProvider(provider.id));
		expect(families.map((fam) => fam.family).sort()).toEqual(["Kit Mono", "Kit Sans"]);
		const sans = families.find((fam) => fam.family === "Kit Sans");
		expect(sans?.weights).toEqual([]);
		expect(sans?.meta).toBeNull();
		const mono = families.find((fam) => fam.family === "Kit Mono");
		expect(mono?.weights).toEqual([400]);
		expect(mono?.meta).toEqual({ hint: "m" });
	});
});

describe("FontsLive — optional event bus and driver edges", () => {
	const gate = makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"));

	it("mutations are a no-op publish when no EventBus is bound", async () => {
		const { db } = makeTestDb();
		const infra = Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, gate));
		const rt = ManagedRuntime.make(FontsServicesLive.pipe(Layer.provide(infra)));
		try {
			const provider = await rt.runPromise(
				asUser(
					ADMIN,
					withFonts((f) => f.createProvider({ kind: "local", name: "Bus-free" })),
				),
			);
			expect(provider.name).toBe("Bus-free");
			// family.synced publish is also a no-op without a bus.
			const families = await rt.runPromise(
				asUser(
					ADMIN,
					withFonts((f) => f.syncProvider(provider.id)),
				),
			);
			expect(families).toEqual([]);
		} finally {
			await rt.dispose();
		}
	});

	it("a failing dispatch is logged and never fails the write", async () => {
		const { db } = makeTestDb();
		const deadBus = {
			dispatch: () => Effect.die(new Error("bus down")),
		} as unknown as EventBusShape;
		const infra = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, gate),
			Layer.succeed(EventBus, deadBus),
		);
		const rt = ManagedRuntime.make(FontsServicesLive.pipe(Layer.provide(infra)));
		try {
			const provider = await rt.runPromise(
				asUser(
					ADMIN,
					withFonts((f) => f.createProvider({ kind: "local", name: "Dead bus" })),
				),
			);
			expect(provider.name).toBe("Dead bus");
			const families = await rt.runPromise(
				asUser(
					ADMIN,
					withFonts((f) => f.syncProvider(provider.id)),
				),
			);
			expect(families).toEqual([]);
		} finally {
			await rt.dispose();
		}
	});

	it("createProvider dies when the insert returns no row", async () => {
		const emptyDb = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as DbClient;
		const infra = Layer.mergeAll(Layer.succeed(Db, emptyDb), Layer.succeed(PlatformAdmin, gate));
		const rt = ManagedRuntime.make(FontsServicesLive.pipe(Layer.provide(infra)));
		try {
			await expect(
				rt.runPromise(
					asUser(
						ADMIN,
						withFonts((f) => f.createProvider({ kind: "local", name: "X" })),
					),
				),
			).rejects.toThrow(/no row/);
		} finally {
			await rt.dispose();
		}
	});
});
