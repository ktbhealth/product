import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient, type SqlDatabase } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant } from "@ktb/tenant";

import { KTB_DEFAULT_THEME } from "./default-theme.ts";
import {
	findTheme,
	getThemeById,
	listThemes,
	setThemeEnabled,
	Theme,
	ThemeLive,
	upsertTheme,
	type ThemePublishInput,
	type ThemeRow,
} from "./theme.ts";
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
	version integer DEFAULT 1 NOT NULL,
	created_at integer NOT NULL,
	updated_at integer
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
		version?: number;
		fonts?: string | null;
		brand?: string | null;
	},
): Promise<number> => {
	await run(
		d1,
		`INSERT INTO theme_definitions (scope, scope_id, app_name, seeds, tokens, fonts, brand, enabled, version, created_at)
		 VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, 0)`,
		[
			row.scope,
			row.scopeId ?? "",
			row.appName ?? null,
			row.seeds ?? "{}",
			row.fonts ?? null,
			row.brand ?? null,
			row.enabled === false ? 0 : 1,
			row.version ?? 1,
		],
	);
	const rows = await all<{ id: number }>(
		d1,
		`SELECT id FROM theme_definitions ORDER BY id DESC LIMIT 1`,
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
			version: 1,
		});
		expect(JSON.parse(created!.seeds)).toEqual(seeds);
		expect(JSON.parse(created!.tokens)["light"]).toBeDefined();
		expect(JSON.parse(created!.fonts!)).toEqual(fonts);
		expect(JSON.parse(created!.brand!)).toEqual(brand);

		const updated = await upsertTheme(db, publishInput({ seeds: {} }), created!.id);
		expect(updated?.version).toBe(2);
		// Nullish fonts/brand serialize to SQL NULL.
		expect(updated!.fonts).toBeNull();
		expect(updated!.brand).toBeNull();
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

describe("ThemeLive.resolve", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Theme, never>;
	let db: DbClient;
	let d1: SqlDatabase;

	beforeAll(() => {
		({ db, d1 } = makeTestDb());
		runtime = makeRuntime(db);
	});

	afterAll(() => runtime.dispose());

	it("returns the built-in KTB default when no row matches", async () => {
		const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
		expect(theme).toEqual(KTB_DEFAULT_THEME);
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
		expect(theme.id).toBe(tenantId);
		expect(theme.scope).toBe("tenant");
		expect(theme.appName).toBe("Tenant Co");
	});

	it("falls through to platform when the tenant row is absent", async () => {
		const platformId = await insertRow(d1, {
			scope: "platform",
			appName: "Platform Co",
		});
		const theme = await runtime.runPromise(withTheme((t) => t.resolve({ scope: "session" })));
		expect(theme.id).toBe(platformId);
		expect(theme.scope).toBe("platform");
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
		expect(theme.id).toBe(instId);
		// Unknown instance falls back to platform (tenant unbound → skipped).
		const fallback = await runtime.runPromise(
			withTheme((t) => t.resolve({ scope: "portal-instance", id: "nope" })),
		);
		expect(fallback.scope).toBe("platform");
	});
});

describe("ThemeLive resolve read failure", () => {
	it("tolerates per-scope read failures and falls through the chain", async () => {
		// Db without theme_definitions → every candidate read rejects.
		const brokenDb = makeDb(makeD1("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)"));
		const runtime = makeRuntime(brokenDb);
		try {
			const theme = await runtime.runPromise(withTheme((t) => t.resolve()));
			expect(theme).toEqual(KTB_DEFAULT_THEME);
		} finally {
			await runtime.dispose();
		}
	});
});

describe("ThemeLive admin surface", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Theme, never>;
	let db: DbClient;
	let d1: SqlDatabase;

	beforeAll(() => {
		({ db, d1 } = makeTestDb());
		runtime = makeRuntime(db);
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
		expect(first).toMatchObject({ scope: "tenant", scopeId: "11", version: 1 });
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
