import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A mutable stand-in lets one seed test exercise the null fonts/brand
// arms of seedDefaultTheme without disturbing the real KTB default
// every other test relies on.
const defaultThemeOverride = vi.hoisted(() => ({
	current: undefined as import("./types.ts").ResolvedTheme | undefined,
}));

vi.mock("./default-theme.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("./default-theme.ts")>();
	return {
		...original,
		get KTB_DEFAULT_THEME() {
			return defaultThemeOverride.current ?? original.KTB_DEFAULT_THEME;
		},
	};
});

// Same stand-in pattern for the managed-font asset loader: one test
// forces the promise to reject so ThemeLive's catchCause fallback is
// exercised; every other test calls through to the real implementation.
const managedAssetsOverride = vi.hoisted(() => ({
	current: undefined as
		| ((
				db: DbClient,
				managed: readonly import("./types.ts").ThemeManagedFont[],
		  ) => Promise<readonly import("./types.ts").ThemeManagedFont[]>)
		| undefined,
}));

vi.mock("./managed-fonts.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("./managed-fonts.ts")>();
	return {
		...original,
		loadManagedFontAssets: (
			db: DbClient,
			managed: readonly import("./types.ts").ThemeManagedFont[],
		) => (managedAssetsOverride.current ?? original.loadManagedFontAssets)(db, managed),
	};
});

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient, type SqlDatabase } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant } from "@ktb/tenant";

import {
	deleteTheme,
	findMainTheme,
	findTheme,
	getThemeById,
	listThemes,
	seedDefaultTheme,
	setThemeEnabled,
	setThemeMain,
	Theme,
	ThemeLive,
	upsertTheme,
	type ThemePublishInput,
	type ThemeRow,
} from "./theme.ts";
import { KTB_DEFAULT_THEME } from "./default-theme.ts";
import type { ThemeSeeds, ThemeSummary } from "./types.ts";

const DDL = `
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
	is_main integer DEFAULT false NOT NULL,
	version integer DEFAULT 1 NOT NULL,
	created_at integer NOT NULL,
	updated_at integer
);
CREATE TABLE theme_assets (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	theme_id integer,
	kind text NOT NULL,
	r2_key text,
	status text DEFAULT 'pending' NOT NULL,
	variants text,
	created_at integer NOT NULL,
	FOREIGN KEY (theme_id) REFERENCES theme_definitions(id) ON UPDATE no action ON DELETE set null
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

const insertRow = async (
	d1: SqlDatabase,
	row: {
		scope: string;
		scopeId?: string;
		appName?: string | null;
		seeds?: string;
		enabled?: boolean;
		isMain?: boolean;
		version?: number;
		fonts?: string | null;
		brand?: string | null;
	},
): Promise<number> => {
	await run(
		d1,
		`INSERT INTO theme_definitions (scope, scope_id, app_name, seeds, tokens, fonts, brand, enabled, is_main, version, created_at)
		 VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, 0)`,
		[
			row.scope,
			row.scopeId ?? "",
			row.appName ?? null,
			row.seeds ?? "{}",
			row.fonts ?? null,
			row.brand ?? null,
			row.enabled === false ? 0 : 1,
			row.isMain === true ? 1 : 0,
			row.version ?? 1,
		],
	);
	const rows = await all<{ id: number }>(
		d1,
		`SELECT id FROM theme_definitions ORDER BY id DESC LIMIT 1`,
	);
	return rows[0]!.id;
};

const insertAsset = async (
	d1: SqlDatabase,
	row: {
		themeId: number | null;
		kind: string;
		r2Key?: string | null;
		status?: string;
		variants?: string | null;
	},
): Promise<number> => {
	await run(
		d1,
		`INSERT INTO theme_assets (theme_id, kind, r2_key, status, variants, created_at)
		 VALUES (?, ?, ?, ?, ?, 0)`,
		[row.themeId, row.kind, row.r2Key ?? null, row.status ?? "pending", row.variants ?? null],
	);
	const rows = await all<{ id: number }>(
		d1,
		`SELECT id FROM theme_assets ORDER BY id DESC LIMIT 1`,
	);
	return rows[0]!.id;
};

const publishInput = (over: Partial<ThemePublishInput> = {}): ThemePublishInput => ({
	scope: "platform",
	scopeId: "",
	seeds: {},
	...over,
});

describe("theme repo helpers", () => {
	it("findTheme returns only enabled rows for the exact scope", async () => {
		const { db, d1 } = makeTestDb();
		const id = await insertRow(d1, { scope: "platform" });
		await insertRow(d1, { scope: "tenant", scopeId: "7", enabled: false });
		const found = await findTheme(db, "platform", "");
		expect(found?.id).toBe(id);
		expect(await findTheme(db, "tenant", "7")).toBeNull(); // disabled
		expect(await findTheme(db, "platform", "x")).toBeNull();
		expect(await findTheme(db, "bogus", "")).toBeNull();
	});

	it("getThemeById ignores the enabled flag", async () => {
		const { db, d1 } = makeTestDb();
		const id = await insertRow(d1, {
			scope: "tenant",
			scopeId: "3",
			enabled: false,
		});
		expect((await getThemeById(db, id))?.scopeId).toBe("3");
		expect(await getThemeById(db, 999)).toBeNull();
	});

	it("listThemes returns every row ordered by scope then scope id", async () => {
		const { db, d1 } = makeTestDb();
		await insertRow(d1, { scope: "tenant", scopeId: "9" });
		await insertRow(d1, { scope: "platform" });
		await insertRow(d1, { scope: "tenant", scopeId: "2", enabled: false });
		const rows = await listThemes(db);
		expect(rows.map((r) => `${r.scope}:${r.scopeId}`)).toEqual([
			"platform:",
			"tenant:2",
			"tenant:9",
		]);
	});

	it("findMainTheme returns the enabled is_main row only", async () => {
		const { db, d1 } = makeTestDb();
		const mainId = await insertRow(d1, { scope: "platform", scopeId: "m", isMain: true });
		await insertRow(d1, { scope: "tenant", scopeId: "1", isMain: true, enabled: false });
		await insertRow(d1, { scope: "tenant", scopeId: "2" });
		expect((await findMainTheme(db))?.id).toBe(mainId);
		await setThemeEnabled(db, mainId, false);
		expect(await findMainTheme(db)).toBeNull();
	});

	it("setThemeMain moves the flag atomically", async () => {
		const { db, d1 } = makeTestDb();
		const a = await insertRow(d1, { scope: "platform", scopeId: "a", isMain: true });
		const b = await insertRow(d1, { scope: "tenant", scopeId: "b" });
		await setThemeMain(db, b);
		expect((await getThemeById(db, a))?.isMain).toBe(false);
		expect((await getThemeById(db, b))?.isMain).toBe(true);
		// Exactly one main row remains.
		const mains = await all<{ id: number }>(
			d1,
			`SELECT id FROM theme_definitions WHERE is_main = 1`,
		);
		expect(mains.map((r) => r.id)).toEqual([b]);
	});

	it("seedDefaultTheme inserts the KTB main row only on an empty table", async () => {
		const { db } = makeTestDb();
		expect(await seedDefaultTheme(db)).toBe(true);
		expect(await seedDefaultTheme(db)).toBe(false);
		const rows = await listThemes(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			scope: "platform",
			scopeId: "",
			appName: "KTB Health",
			enabled: true,
			isMain: true,
		});
		expect(JSON.parse(rows[0]!.seeds)).toEqual({
			primary: "oklch(0.55 0.11 259.02)",
			dark: { primary: "oklch(0.62 0.19 259.76)" },
		});
		expect(JSON.parse(rows[0]!.fonts!)).toBeDefined();
		expect(JSON.parse(rows[0]!.brand!)).toBeDefined();
	});

	it("stores null fonts/brand when the default theme omits them", async () => {
		defaultThemeOverride.current = { ...KTB_DEFAULT_THEME, fonts: null, brand: null };
		try {
			const { db } = makeTestDb();
			expect(await seedDefaultTheme(db)).toBe(true);
			const rows = await listThemes(db);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.fonts).toBeNull();
			expect(rows[0]!.brand).toBeNull();
		} finally {
			defaultThemeOverride.current = undefined;
		}
	});

	it("upsertTheme inserts enabled rows and bumps version on update", async () => {
		const { db } = makeTestDb();
		const seeds: ThemeSeeds = { primary: "#2563eb", radius: "0.6rem" };
		const fonts = {
			delivery: "self-host" as const,
			families: { sans: "Inter" },
		};
		const brand = { appName: "Acme", favicon: "/f.ico" };
		const created = await upsertTheme(db, publishInput({ appName: "Acme", seeds, fonts, brand }));
		expect(created).toMatchObject({
			scope: "platform",
			enabled: true,
			isMain: false,
			version: 1,
		});
		expect(JSON.parse(created!.seeds)).toEqual(seeds);
		expect(JSON.parse(created!.tokens)["light"]).toBeDefined();
		expect(JSON.parse(created!.fonts!)).toEqual(fonts);
		expect(JSON.parse(created!.brand!)).toEqual(brand);

		// Undefined optional columns preserve stored fonts/brand on update.
		const preserved = await upsertTheme(db, publishInput({ seeds: {} }), created!.id);
		expect(preserved?.version).toBe(2);
		expect(JSON.parse(preserved!.fonts!)).toEqual(fonts);
		expect(JSON.parse(preserved!.brand!)).toEqual(brand);
		// Explicit null clears them.
		const updated = await upsertTheme(
			db,
			publishInput({ seeds: {}, fonts: null, brand: null }),
			created!.id,
		);
		expect(updated?.version).toBe(3);
		expect(updated!.fonts).toBeNull();
		expect(updated!.brand).toBeNull();
	});

	it("upsertTheme serializes defined fonts/brand on the update path", async () => {
		const { db } = makeTestDb();
		const created = await upsertTheme(db, publishInput({ seeds: {} }));
		const fonts = { delivery: "google-fonts" as const, families: { sans: "Inter" } };
		const brand = { appName: "Acme", wordmark: "/w.svg" };
		const updated = await upsertTheme(db, publishInput({ seeds: {}, fonts, brand }), created!.id);
		expect(JSON.parse(updated!.fonts!)).toEqual(fonts);
		expect(JSON.parse(updated!.brand!)).toEqual(brand);
	});

	it("upsertTheme returns null when the write yields no row", async () => {
		const emptyDb = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
			update: () => ({
				set: () => ({
					where: () => ({ returning: async () => [] }),
				}),
			}),
		} as unknown as DbClient;
		expect(await upsertTheme(emptyDb, publishInput())).toBeNull();
		expect(await upsertTheme(emptyDb, publishInput(), 4)).toBeNull();
	});

	it("setThemeEnabled flips the flag", async () => {
		const { db, d1 } = makeTestDb();
		const id = await insertRow(d1, { scope: "platform" });
		await setThemeEnabled(db, id, false);
		expect((await getThemeById(db, id))?.enabled).toBe(false);
		await setThemeEnabled(db, id, true);
		expect((await getThemeById(db, id))?.enabled).toBe(true);
	});

	it("deleteTheme removes the row", async () => {
		const { db, d1 } = makeTestDb();
		const id = await insertRow(d1, { scope: "platform" });
		await deleteTheme(db, id);
		expect(await getThemeById(db, id)).toBeNull();
		// Deleting a missing id is a no-op.
		await deleteTheme(db, 999);
	});
});

// ---------- ThemeLive service ----------

const ADMIN = { userId: "u-admin", email: "admin@x.com" };
const PLAIN = { userId: "u-plain", email: "plain@x.com" };

const asUser = <A, E>(
	user: { userId: string; email: string },
	effect: Effect.Effect<A, E, Theme>,
) => effect.pipe(Effect.provideService(Principal, user));

const makeRuntime = (db: DbClient) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
	);
	return ManagedRuntime.make(ThemeLive.pipe(Layer.provide(infra)) as Layer.Layer<unknown>);
};

const withTheme = <A, E>(effect: (theme: Theme["Service"]) => Effect.Effect<A, E, never>) =>
	Effect.gen(function* () {
		const theme = yield* Theme;
		return yield* effect(theme);
	});

/** Build the layer (runs the create-only seed), then clear the table
 * so each test owns its rows — the seed itself is covered separately. */
const freshServiceDb = async () => {
	const { db, d1 } = makeTestDb();
	const runtime = makeRuntime(db);
	await runtime.runPromise(withTheme(() => Effect.void));
	await run(d1, "DELETE FROM theme_definitions");
	return { db, d1, runtime };
};

describe("ThemeLive seed", () => {
	it("seeds the KTB default as the main row on an empty database", async () => {
		const { db, d1 } = makeTestDb();
		const runtime = makeRuntime(db);
		try {
			const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
			expect(theme?.appName).toBe("KTB Health");
			expect(theme?.scope).toBe("platform");
			const rows = await all<{ scope: string; is_main: number; enabled: number }>(
				d1,
				`SELECT scope, is_main, enabled FROM theme_definitions`,
			);
			expect(rows).toEqual([{ scope: "platform", is_main: 1, enabled: 1 }]);
		} finally {
			await runtime.dispose();
		}
	});

	it("does not reseed when rows already exist", async () => {
		const { db, d1 } = makeTestDb();
		await insertRow(d1, { scope: "tenant", scopeId: "1" });
		const runtime = makeRuntime(db);
		try {
			await runtime.runPromise(withTheme((t) => t.resolve()));
			const count = await all<{ n: number }>(d1, `SELECT COUNT(*) AS n FROM theme_definitions`);
			expect(count[0]!.n).toBe(1);
		} finally {
			await runtime.dispose();
		}
	});
});

describe("ThemeLive.resolve", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Theme, never>;
	let db: DbClient;
	let d1: SqlDatabase;

	beforeAll(async () => {
		({ db, d1, runtime } = await freshServiceDb());
	});

	afterAll(() => runtime.dispose());

	it("returns null when no row matches and no main row exists", async () => {
		const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
		expect(theme).toBeNull();
	});

	it("resolves tenant → platform for session scope", async () => {
		const tenantId = await insertRow(d1, {
			scope: "tenant",
			scopeId: "7",
			appName: "Tenant Co",
		});
		const theme = await runtime.runPromise(
			withTheme((t) => t.resolve()).pipe(
				Effect.provideService(Tenant, {
					id: "7",
					kind: "clinic",
					slug: "clinic-7",
					role: "member",
				} as never),
			),
		);
		expect(theme?.id).toBe(tenantId);
		expect(theme?.scope).toBe("tenant");
		expect(theme?.appName).toBe("Tenant Co");
	});

	it("falls through to platform when the tenant row is absent", async () => {
		const platformId = await insertRow(d1, {
			scope: "platform",
			appName: "Platform Co",
		});
		const theme = await runtime.runPromise(withTheme((t) => t.resolve({ scope: "session" })));
		expect(theme?.id).toBe(platformId);
		expect(theme?.scope).toBe("platform");
	});

	it("portal-instance scope tries instance → tenant → platform", async () => {
		const instId = await insertRow(d1, {
			scope: "portal-instance",
			scopeId: "inst-1",
			appName: "Instance Co",
		});
		const theme = await runtime.runPromise(
			withTheme((t) => t.resolve({ scope: "portal-instance", id: "inst-1" })),
		);
		expect(theme?.id).toBe(instId);
		// Unknown instance falls back to platform (tenant unbound → skipped).
		const fallback = await runtime.runPromise(
			withTheme((t) => t.resolve({ scope: "portal-instance", id: "nope" })),
		);
		expect(fallback?.scope).toBe("platform");
	});

	it("falls back to the enabled is_main row when the chain misses", async () => {
		// Clear accumulated rows so the scope chain genuinely misses.
		await run(d1, "DELETE FROM theme_definitions");
		const mainId = await insertRow(d1, {
			scope: "tenant",
			scopeId: "77",
			appName: "Main Co",
			isMain: true,
		});
		const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
		expect(theme?.id).toBe(mainId);
		expect(theme?.appName).toBe("Main Co");
		// A disabled main row is skipped → null.
		await setThemeEnabled(db, mainId, false);
		expect(await runtime.runPromise(withTheme((t) => t.resolve()))).toBeNull();
	});
});

describe("ThemeLive resolve read failure", () => {
	it("tolerates per-scope read failures and falls through the chain", async () => {
		// Db without theme_definitions → every candidate read rejects;
		// the seed fails too (logged, swallowed) and resolve → null.
		const brokenDb = makeDb(makeD1("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)"));
		const runtime = makeRuntime(brokenDb);
		try {
			const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
			expect(theme).toBeNull();
		} finally {
			await runtime.dispose();
		}
	});
});

describe("ThemeLive admin surface", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Theme, never>;
	let db: DbClient;
	let d1: SqlDatabase;

	beforeAll(async () => {
		({ db, d1, runtime } = await freshServiceDb());
	});

	afterAll(() => runtime.dispose());

	it("list summarizes rows for admins and denies non-admins", async () => {
		await insertRow(d1, { scope: "platform", appName: "Plat", version: 3 });
		const rows = (await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) => t.list()),
			),
		)) as readonly ThemeSummary[];
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]).toMatchObject({
			scope: "platform",
			appName: "Plat",
			isMain: false,
			version: 3,
		});
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withTheme((t) => t.list()),
				),
			),
		).rejects.toThrowError(Forbidden);
		await expect(runtime.runPromise(withTheme((t) => t.list()))).rejects.toThrowError(Forbidden);
	});

	it("get presents a row by id, null when missing, Forbidden for non-admins", async () => {
		const id = await insertRow(d1, {
			scope: "tenant",
			scopeId: "4",
			seeds: JSON.stringify({ primary: "#ff0000" }),
		});
		const theme = await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) => t.get(id)),
			),
		);
		expect(theme?.id).toBe(id);
		expect(theme?.seeds.primary).toBe("#ff0000");
		expect(
			await runtime.runPromise(
				asUser(
					ADMIN,
					withTheme((t) => t.get(999)),
				),
			),
		).toBeNull();
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withTheme((t) => t.get(id)),
				),
			),
		).rejects.toThrowError(Forbidden);
	});

	it("publish upserts by natural scope key and bumps version", async () => {
		const first = await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) =>
					t.publish({
						scope: "tenant",
						scopeId: "11",
						appName: "Pub",
						seeds: { primary: "#00ff00" },
					}),
				),
			),
		);
		expect(first).toMatchObject({ scope: "tenant", scopeId: "11", version: 1, isMain: false });
		const second = await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) => t.publish({ scope: "tenant", scopeId: "11", seeds: {} })),
			),
		);
		expect(second.id).toBe(first.id);
		expect(second.version).toBe(2);
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withTheme((t) => t.publish(publishInput())),
				),
			),
		).rejects.toThrowError(Forbidden);
	});

	it("publish dies when the upsert returns no row", async () => {
		const emptyDb = {
			select: () => ({
				from: () => ({ where: () => ({ limit: async () => [] }) }),
			}),
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as DbClient;
		const rt = makeRuntime(emptyDb);
		try {
			await expect(
				rt.runPromise(
					asUser(
						ADMIN,
						withTheme((t) => t.publish(publishInput())),
					),
				),
			).rejects.toThrow();
		} finally {
			await rt.dispose();
		}
	});

	it("setEnabled toggles the stored flag", async () => {
		const id = await insertRow(d1, { scope: "platform", appName: "Toggle" });
		await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) => t.setEnabled(id, false)),
			),
		);
		expect((await getThemeById(db, id))?.enabled).toBe(false);
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withTheme((t) => t.setEnabled(id, true)),
				),
			),
		).rejects.toThrowError(Forbidden);
	});

	it("setMain swaps the flag for admins and denies non-admins", async () => {
		const a = await insertRow(d1, { scope: "platform", scopeId: "ma", isMain: true });
		const b = await insertRow(d1, { scope: "tenant", scopeId: "mb" });
		await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) => t.setMain(b)),
			),
		);
		expect((await getThemeById(db, a))?.isMain).toBe(false);
		expect((await getThemeById(db, b))?.isMain).toBe(true);
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withTheme((t) => t.setMain(a)),
				),
			),
		).rejects.toThrowError(Forbidden);
		await expect(
			runtime.runPromise(
				asUser(
					ADMIN,
					withTheme((t) => t.setMain(999)),
				),
			),
		).rejects.toThrow();
	});

	it("publish by id updates that row and can move scopes", async () => {
		const id = await insertRow(d1, { scope: "platform", appName: "Old" });
		const summary = await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) =>
					t.publish({
						id,
						scope: "tenant",
						scopeId: "42",
						appName: "Moved",
						seeds: { primary: "#123456" },
					}),
				),
			),
		);
		expect(summary).toMatchObject({ id, scope: "tenant", scopeId: "42", appName: "Moved" });
		const row = (await getThemeById(db, id))!;
		expect(row.scope).toBe("tenant");
		expect(row.scopeId).toBe("42");
		expect(row.version).toBe(2);
	});

	it("publish by id dies when the row is gone", async () => {
		await expect(
			runtime.runPromise(
				asUser(
					ADMIN,
					withTheme((t) => t.publish({ id: 999, scope: "platform", scopeId: "", seeds: {} })),
				),
			),
		).rejects.toThrow();
	});

	it("publish by id dies when the update returns no row", async () => {
		// select() finds the row but the update yields nothing — e.g. a
		// concurrent delete between the two statements.
		const vanishingDb = {
			select: () => ({
				from: () => ({ where: () => ({ limit: async () => [{ id: 4 }] }) }),
			}),
			update: () => ({
				set: () => ({ where: () => ({ returning: async () => [] }) }),
			}),
		} as unknown as DbClient;
		const rt = makeRuntime(vanishingDb);
		try {
			await expect(
				rt.runPromise(
					asUser(
						ADMIN,
						withTheme((t) => t.publish({ id: 4, scope: "platform", scopeId: "", seeds: {} })),
					),
				),
			).rejects.toThrow("theme upsert returned no row");
		} finally {
			await rt.dispose();
		}
	});

	it("remove deletes the row for admins and denies non-admins", async () => {
		const id = await insertRow(d1, { scope: "platform", appName: "Doomed" });
		await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) => t.remove(id)),
			),
		);
		expect(await getThemeById(db, id)).toBeNull();
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withTheme((t) => t.remove(1)),
				),
			),
		).rejects.toThrowError(Forbidden);
	});

	it("remove refuses the main row", async () => {
		const id = await insertRow(d1, { scope: "tenant", scopeId: "main", isMain: true });
		await expect(
			runtime.runPromise(
				asUser(
					ADMIN,
					withTheme((t) => t.remove(id)),
				),
			),
		).rejects.toThrow("cannot delete the main theme");
		expect(await getThemeById(db, id)).not.toBeNull();
	});

	it("listAssets summarizes upload rows for admins and denies non-admins", async () => {
		const themeId = await insertRow(d1, { scope: "platform" });
		const a = await insertAsset(d1, { themeId, kind: "favicon", r2Key: "k1" });
		const b = await insertAsset(d1, {
			themeId,
			kind: "font",
			status: "failed",
			variants: JSON.stringify({ error: "boom" }),
		});
		const c = await insertAsset(d1, { themeId, kind: "font", variants: "{oops" });
		await insertAsset(d1, { themeId: null, kind: "favicon" });
		const rows = await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) => t.listAssets(themeId)),
			),
		);
		// Newest first (created_at ties break on id desc).
		expect(rows.map((r) => r.id)).toEqual([c, b, a]);
		expect(rows[0]?.variants).toBeNull(); // invalid JSON degrades to null
		expect(rows[1]?.variants).toEqual({ error: "boom" });
		expect(rows[2]?.variants).toBeNull(); // absent column
		expect(rows[2]?.r2Key).toBe("k1");
		expect(rows[2]?.createdAt).toBe(new Date(0).toISOString());
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withTheme((t) => t.listAssets(themeId)),
				),
			),
		).rejects.toThrowError(Forbidden);
	});

	it("previewRow returns disabled rows for admins", async () => {
		const id = await insertRow(d1, { scope: "platform", enabled: false });
		const row = (await runtime.runPromise(
			asUser(
				ADMIN,
				withTheme((t) => t.previewRow(id)),
			),
		)) as ThemeRow;
		expect(row.id).toBe(id);
		expect(row.enabled).toBe(false);
		expect(
			await runtime.runPromise(
				asUser(
					ADMIN,
					withTheme((t) => t.previewRow(999)),
				),
			),
		).toBeNull();
		await expect(
			runtime.runPromise(
				asUser(
					PLAIN,
					withTheme((t) => t.previewRow(id)),
				),
			),
		).rejects.toThrowError(Forbidden);
	});
});

// ---------- managed-font cascade (fonts plugin optional edge) ----------

import { FontCatalog, type FontCatalogFamily } from "@ktb/fonts/catalog";
import { FontHooks, FontHooksLive } from "@ktb/fonts/hooks";

describe("ThemeLive managed fonts", () => {
	const catalogEntry = (over: Partial<FontCatalogFamily> = {}): FontCatalogFamily => ({
		id: 1,
		providerId: 7,
		kind: "googlefonts",
		family: "Inter",
		weights: [400, 700],
		status: "ready",
		meta: null,
		...over,
	});

	const makeCascadeRuntime = async (
		db: DbClient,
		d1: SqlDatabase,
		entries: FontCatalogFamily[],
	) => {
		// A mutable stand-in lets tests simulate a re-sync; the real
		// FontHooks registry proves the invalidation wiring end to end.
		// `fail` makes list() die so the catalogSnapshot catchCause
		// fallback is exercised.
		const state = { entries, fail: false };
		const hooksRuntime = ManagedRuntime.make(FontHooksLive);
		const hooks = await hooksRuntime.runPromise(FontHooks);
		const infra = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			Layer.succeed(
				FontCatalog,
				FontCatalog.of({
					list: () =>
						state.fail ? Effect.die(new Error("catalog read boom")) : Effect.succeed(state.entries),
				}),
			),
			Layer.succeed(FontHooks, hooks),
		);
		const runtime = ManagedRuntime.make(
			ThemeLive.pipe(Layer.provide(infra)) as Layer.Layer<unknown>,
		);
		await runtime.runPromise(withTheme(() => Effect.void)); // build + seed
		// Same as freshServiceDb: clear the seeded main row so each
		// test owns its rows (the seed itself is covered elsewhere).
		await run(d1, "DELETE FROM theme_definitions");
		return { runtime, hooksRuntime, hooks, state };
	};

	it("resolves managed sources into fontLinks/styleCss and invalidates on font hooks", async () => {
		const { db, d1 } = makeTestDb();
		const { runtime, hooksRuntime, hooks, state } = await makeCascadeRuntime(db, d1, [
			catalogEntry(),
		]);
		try {
			const themeId = await insertRow(d1, {
				scope: "platform",
				fonts: JSON.stringify({
					delivery: "self-host",
					sources: { sans: { providerId: 7, family: "Inter" } },
				}),
			});
			const first = await runtime.runPromise(withTheme((t) => t.resolve()));
			expect(first?.id).toBe(themeId);
			expect(first?.fontLinks).toEqual([
				"https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
			]);
			expect(first?.styleCss).toContain('"Inter"');

			// Re-sync changes the catalog — the cached snapshot must NOT
			// leak the new weights until a fonts hook fires.
			state.entries = [catalogEntry({ weights: [900] })];
			const stale = await runtime.runPromise(withTheme((t) => t.resolve()));
			expect(stale?.fontLinks[0]).toContain("wght@400;700");

			await hooksRuntime.runPromise(
				hooks.invoke("theme.font-catalog", {
					event: "family.synced",
					providerId: 7,
					kind: "googlefonts",
				}),
			);
			const fresh = await runtime.runPromise(withTheme((t) => t.resolve()));
			expect(fresh?.fontLinks[0]).toContain("wght@900");
		} finally {
			await runtime.dispose();
			await hooksRuntime.dispose();
		}
	});

	it("resolves local-provider self-host faces through meta.assetId", async () => {
		const { db, d1 } = makeTestDb();
		const fontAsset = {
			faces: [{ url: "/api/theme/assets?key=brand.woff2", weight: 400, format: "woff2" }],
			fallback: null,
		};
		// Runtime first (it clears the seeded row); the catalog snapshot
		// is mutable so the entry can reference the asset id inserted below.
		const { runtime, hooksRuntime, state } = await makeCascadeRuntime(db, d1, []);
		try {
			const themeId = await insertRow(d1, {
				scope: "platform",
				fonts: JSON.stringify({
					delivery: "self-host",
					assets: { "Brand Sans": fontAsset },
					sources: { sans: { providerId: 4, family: "Brand Sans" } },
				}),
			});
			// The owning theme's fonts.assets carries the self-host
			// manifest the font job wrote; the catalog row points at the
			// asset via meta.assetId (the local adapter's contract).
			const assetId = await insertAsset(d1, { themeId, kind: "font", status: "ready" });
			state.entries = [
				catalogEntry({
					id: 2,
					providerId: 4,
					kind: "local",
					family: "Brand Sans",
					weights: [],
					meta: { source: "local", assetId },
				}),
			];
			const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
			expect(theme?.fontFaceCss).toContain('@font-face{font-family:"Brand Sans"');
			expect(theme?.fontFaceCss).toContain("/api/theme/assets?key=brand.woff2");
			expect(theme?.fontLinks).toEqual([]);
			expect(theme?.styleCss).toContain('"Brand Sans"');
		} finally {
			await runtime.dispose();
			await hooksRuntime.dispose();
		}
	});

	it("degrades to free-form resolution when the catalog read fails", async () => {
		const { db, d1 } = makeTestDb();
		const { runtime, hooksRuntime, state } = await makeCascadeRuntime(db, d1, [catalogEntry()]);
		try {
			state.fail = true;
			await insertRow(d1, {
				scope: "platform",
				fonts: JSON.stringify({
					delivery: "google-fonts",
					families: { sans: "Inter" },
					sources: { sans: { providerId: 7, family: "Inter" } },
				}),
			});
			const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
			// The managed source never resolves — the free-form family
			// and its google-fonts delivery take over instead.
			expect(theme?.fontLinks).toEqual([
				"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
			]);
			expect(theme?.styleCss).toContain('"Inter"');
		} finally {
			await runtime.dispose();
			await hooksRuntime.dispose();
		}
	});

	it("falls back to the matched fonts when the asset read rejects", async () => {
		const { db, d1 } = makeTestDb();
		const { runtime, hooksRuntime, state } = await makeCascadeRuntime(db, d1, []);
		try {
			managedAssetsOverride.current = () => Promise.reject(new Error("asset read boom"));
			await insertRow(d1, {
				scope: "platform",
				fonts: JSON.stringify({
					delivery: "self-host",
					sources: { sans: { providerId: 4, family: "Brand Sans" } },
				}),
			});
			state.entries = [
				catalogEntry({
					id: 2,
					providerId: 4,
					kind: "local",
					family: "Brand Sans",
					weights: [],
					meta: { source: "local", assetId: 1 },
				}),
			];
			const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
			// The slot name still applies (matched fonts pass through
			// unresolved) but no @font-face is emitted.
			expect(theme?.styleCss).toContain('"Brand Sans"');
			expect(theme?.fontFaceCss).toBe("");
		} finally {
			managedAssetsOverride.current = undefined;
			await runtime.dispose();
			await hooksRuntime.dispose();
		}
	});

	it("degrades to free-form resolution when fonts.services is absent", async () => {
		const { db, d1 } = makeTestDb();
		const runtime = makeRuntime(db);
		try {
			await insertRow(d1, {
				scope: "platform",
				fonts: JSON.stringify({
					delivery: "self-host",
					families: { sans: "Inter" },
					sources: { sans: { providerId: 7, family: "Inter" } },
				}),
			});
			const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
			expect(theme?.fontLinks).toEqual([]);
			expect(theme?.styleCss).toContain('"Inter"');
		} finally {
			await runtime.dispose();
		}
	});
});
