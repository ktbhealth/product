import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Db, makeDb, type SqlDatabase, type SqlStatement } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { Forbidden, Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { RichTextDeleteHooks, type RichTextDeleteHook } from "@ktb/rich-text/delete-hooks";
import { Schemas } from "@ktb/schemas/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	Pages,
	PagesLive,
	DuplicatePagePath,
	InvalidBuilderDoc,
	InvalidPageInput,
	InvalidPagePath,
	PageNotFound,
	normalizePagePath,
	pagesRichTextDeleteHook,
	type PageInput,
} from "./service.ts";

import { page } from "./schema.ts";

describe("normalizePagePath", () => {
	it("accepts and canonicalizes valid paths", () => {
		expect(normalizePagePath("/about")).toBe("/about");
		expect(normalizePagePath("  /about/us  ")).toBe("/about/us");
		expect(normalizePagePath("/about/")).toBe("/about");
		expect(normalizePagePath("/about//")).toBe("/about");
		expect(normalizePagePath("/")).toBe("/");
		expect(normalizePagePath("/a-b_c.d~e")).toBe("/a-b_c.d~e");
	});

	it("rejects invalid paths", () => {
		for (const bad of [
			"",
			"   ",
			"about",
			"https://x.com/a",
			"/has space",
			"/quest?ion",
			"/hash#tag",
			"/star*",
			"/platform",
			"/platform/x",
			"/platform/",
			`/${"a".repeat(200)}`,
		]) {
			expect(normalizePagePath(bad)).toBeNull();
		}
	});
});

describe("PagesLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Pages, never>;

	beforeAll(() => {
		const db = makeDb(makeTestD1());
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(PagesLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Pages>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (p: Pages["Service"]) => Effect.Effect<A, E>) => Effect.flatMap(Pages, f);

	const admin = <A, E>(f: (p: Pages["Service"]) => Effect.Effect<A, E>) =>
		asUser("admin-1", call(f), "admin@x.com");

	const input = (over: Partial<PageInput> = {}): PageInput => ({
		path: "/about",
		title: "About",
		...over,
	});

	it("adminCreate inserts a draft with defaults and returns the row", async () => {
		const row = await admin((p) => p.adminCreate(input()));
		expect(row).not.toBeNull();
		expect(row!.path).toBe("/about");
		expect(row!.published).toBe(false);
		expect(row!.showInNav).toBe(false);
		expect(row!.sortOrder).toBe(0);
		expect(row!.richTextId).toBeNull();
		expect(row!.searchSchemaId).toBeNull();
		expect(row!.layoutId).toBeNull();
	});

	it("adminCreate honors explicit flags and normalized paths", async () => {
		const row = await admin((p) =>
			p.adminCreate(
				input({
					path: "  /team/  ",
					title: "Team",
					published: true,
					showInNav: true,
					sortOrder: 2,
					richTextId: 42,
					searchSchemaId: 7,
				}),
			),
		);
		expect(row!.path).toBe("/team");
		expect(row!.published).toBe(true);
		expect(row!.showInNav).toBe(true);
		expect(row!.sortOrder).toBe(2);
		expect(row!.richTextId).toBe(42);
		expect(row!.searchSchemaId).toBe(7);
	});

	it("adminCreate rejects invalid and duplicate paths", async () => {
		await expect(admin((p) => p.adminCreate(input({ path: "nope" })))).rejects.toBeInstanceOf(
			InvalidPagePath,
		);
		await expect(
			admin((p) => p.adminCreate(input({ path: "/platform/x" }))),
		).rejects.toBeInstanceOf(InvalidPagePath);
		await expect(admin((p) => p.adminCreate(input({ path: "/about" })))).rejects.toBeInstanceOf(
			DuplicatePagePath,
		);
	});

	it("adminCreate/adminUpdate reject non-positive or non-integer richTextId", async () => {
		for (const bad of [0, -3, 1.5]) {
			await expect(
				admin((p) => p.adminCreate(input({ path: `/bad-${bad}`, richTextId: bad }))),
			).rejects.toBeInstanceOf(InvalidPageInput);
		}
		const target = await admin((p) => p.adminCreate(input({ path: "/rt-target" })));
		await expect(
			admin((p) => p.adminUpdate(target!.id, input({ path: "/rt-target", richTextId: 0 }))),
		).rejects.toBeInstanceOf(InvalidPageInput);
		// Explicit null clears the reference; absent also resolves null.
		const linked = await admin((p) => p.adminCreate(input({ path: "/rt-linked", richTextId: 9 })));
		expect(linked!.richTextId).toBe(9);
		const cleared = await admin((p) =>
			p.adminUpdate(linked!.id, input({ path: "/rt-linked", richTextId: null })),
		);
		expect(cleared.richTextId).toBeNull();
		const absent = await admin((p) => p.adminUpdate(linked!.id, input({ path: "/rt-linked" })));
		expect(absent.richTextId).toBeNull();
	});

	it("adminCreate/adminUpdate reject non-positive or non-integer layoutId", async () => {
		for (const bad of [0, -3, 1.5]) {
			await expect(
				admin((p) => p.adminCreate(input({ path: `/bad-layout-${bad}`, layoutId: bad }))),
			).rejects.toBeInstanceOf(InvalidPageInput);
		}
		const target = await admin((p) => p.adminCreate(input({ path: "/layout-target" })));
		await expect(
			admin((p) => p.adminUpdate(target!.id, input({ path: "/layout-target", layoutId: 0 }))),
		).rejects.toBeInstanceOf(InvalidPageInput);
		// Explicit null clears the reference; absent also resolves null.
		const linked = await admin((p) =>
			p.adminCreate(input({ path: "/layout-linked", layoutId: 9 })),
		);
		expect(linked!.layoutId).toBe(9);
		const cleared = await admin((p) =>
			p.adminUpdate(linked!.id, input({ path: "/layout-linked", layoutId: null })),
		);
		expect(cleared.layoutId).toBeNull();
		const absent = await admin((p) => p.adminUpdate(linked!.id, input({ path: "/layout-linked" })));
		expect(absent.layoutId).toBeNull();
	});

	it("adminCreate/adminUpdate reject non-positive or non-integer searchSchemaId", async () => {
		for (const bad of [0, -3, 1.5]) {
			await expect(
				admin((p) => p.adminCreate(input({ path: `/bad-schema-${bad}`, searchSchemaId: bad }))),
			).rejects.toBeInstanceOf(InvalidPageInput);
		}
		const target = await admin((p) => p.adminCreate(input({ path: "/schema-target" })));
		await expect(
			admin((p) => p.adminUpdate(target!.id, input({ path: "/schema-target", searchSchemaId: 0 }))),
		).rejects.toBeInstanceOf(InvalidPageInput);
		// Explicit null clears the reference; absent also resolves null.
		const linked = await admin((p) =>
			p.adminCreate(input({ path: "/schema-linked", searchSchemaId: 9 })),
		);
		expect(linked!.searchSchemaId).toBe(9);
		const cleared = await admin((p) =>
			p.adminUpdate(linked!.id, input({ path: "/schema-linked", searchSchemaId: null })),
		);
		expect(cleared.searchSchemaId).toBeNull();
		const absent = await admin((p) => p.adminUpdate(linked!.id, input({ path: "/schema-linked" })));
		expect(absent.searchSchemaId).toBeNull();
	});

	it("adminList returns every page ordered by sortOrder then path", async () => {
		await admin((p) => p.adminCreate(input({ path: "/aaa", title: "A", sortOrder: 1 })));
		await admin((p) => p.adminCreate(input({ path: "/zzz", title: "Z", sortOrder: 0 })));
		const rows = await admin((p) => p.adminList());
		// sortOrder asc, then path asc: the sortOrder-0 rows (/about,
		// /layout-linked, /layout-target, /rt-linked, /rt-target,
		// /schema-linked, /schema-target, /zzz) come before /aaa(1)
		// and /team(2).
		expect(rows.map((r) => r.path)).toEqual([
			"/about",
			"/layout-linked",
			"/layout-target",
			"/rt-linked",
			"/rt-target",
			"/schema-linked",
			"/schema-target",
			"/zzz",
			"/aaa",
			"/team",
		]);
	});

	it("adminUpdate rewrites fields, bumps updatedAt and keeps the id", async () => {
		const created = await admin((p) => p.adminCreate(input({ path: "/edit-me" })));
		const updated = await admin((p) =>
			p.adminUpdate(created!.id, {
				path: "/renamed/",
				title: "Renamed",
				richTextId: 7,
				searchSchemaId: 11,
				layoutId: 13,
				published: true,
				showInNav: true,
				sortOrder: 5,
			}),
		);
		expect(updated.id).toBe(created!.id);
		expect(updated.path).toBe("/renamed");
		expect(updated.title).toBe("Renamed");
		expect(updated.richTextId).toBe(7);
		expect(updated.searchSchemaId).toBe(11);
		expect(updated.layoutId).toBe(13);
		expect(updated.published).toBe(true);
		expect(updated.showInNav).toBe(true);
		expect(updated.sortOrder).toBe(5);
	});

	it("adminUpdate is a partial update — omitted fields keep stored values", async () => {
		const created = await admin((p) =>
			p.adminCreate(
				input({
					path: "/partial",
					title: "Partial",
					richTextId: 7,
					searchSchemaId: 11,
					layoutId: 13,
					published: true,
					showInNav: true,
					sortOrder: 5,
				}),
			),
		);
		// A rename-only update must not unpublish, unnav or unbind.
		const renamed = await admin((p) => p.adminUpdate(created!.id, { path: "/partial-renamed" }));
		expect(renamed.path).toBe("/partial-renamed");
		expect(renamed.title).toBe("Partial");
		expect(renamed.published).toBe(true);
		expect(renamed.showInNav).toBe(true);
		expect(renamed.sortOrder).toBe(5);
		expect(renamed.richTextId).toBe(7);
		expect(renamed.searchSchemaId).toBe(11);
		expect(renamed.layoutId).toBe(13);
		// Explicit null clears id refs; explicit false/0 are real writes.
		const cleared = await admin((p) =>
			p.adminUpdate(created!.id, {
				richTextId: null,
				published: false,
				sortOrder: 0,
			}),
		);
		expect(cleared.richTextId).toBeNull();
		expect(cleared.published).toBe(false);
		expect(cleared.sortOrder).toBe(0);
		expect(cleared.layoutId).toBe(13);
		expect(cleared.searchSchemaId).toBe(11);
	});

	it("adminUpdate rejects invalid paths, clashes and missing rows", async () => {
		const target = await admin((p) => p.adminCreate(input({ path: "/upd-target" })));
		await expect(
			admin((p) => p.adminUpdate(target!.id, input({ path: "bad path" }))),
		).rejects.toBeInstanceOf(InvalidPagePath);
		// /about exists from the first test — updating /upd-target onto it clashes.
		await expect(
			admin((p) => p.adminUpdate(target!.id, input({ path: "/about" }))),
		).rejects.toBeInstanceOf(DuplicatePagePath);
		// Updating a row onto its OWN current path is not a clash.
		const same = await admin((p) =>
			p.adminUpdate(target!.id, input({ path: "/upd-target", title: "Still here" })),
		);
		expect(same.path).toBe("/upd-target");
		await expect(
			admin((p) => p.adminUpdate(9999, input({ path: "/ghost" }))),
		).rejects.toBeInstanceOf(PageNotFound);
	});

	it("adminRemove deletes and reports missing rows", async () => {
		const row = await admin((p) => p.adminCreate(input({ path: "/doomed" })));
		await admin((p) => p.adminRemove(row!.id));
		await expect(admin((p) => p.adminRemove(row!.id))).rejects.toBeInstanceOf(PageNotFound);
	});

	it("admin methods are Forbidden for non-admins and anonymous callers", async () => {
		await expect(
			asUser(
				"u1",
				call((p) => p.adminList()),
				"doc@x.com",
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				null,
				call((p) => p.adminList()),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				"u1",
				call((p) => p.adminCreate(input({ path: "/nope" }))),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u1",
				call((p) => p.adminUpdate(1, input())),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u1",
				call((p) => p.adminRemove(1)),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("publishedByPath resolves published rows only, tolerating trailing slashes", async () => {
		await admin((p) => p.adminCreate(input({ path: "/pub", published: true, title: "Pub" })));
		await admin((p) => p.adminCreate(input({ path: "/draft", title: "Draft" })));
		const found = await asUser(
			null,
			call((p) => p.publishedByPath("/pub/")),
		);
		expect(found?.title).toBe("Pub");
		expect(
			await asUser(
				null,
				call((p) => p.publishedByPath("/draft")),
			),
		).toBeNull();
		expect(
			await asUser(
				null,
				call((p) => p.publishedByPath("/missing")),
			),
		).toBeNull();
		// Works without any principal — public read.
		const publicRow = await asUser(
			null,
			call((p) => p.publishedByPath("  /pub  ")),
		);
		expect(publicRow?.path).toBe("/pub");
		// Single-character request paths skip trailing-slash stripping.
		expect(
			await asUser(
				null,
				call((p) => p.publishedByPath("/")),
			),
		).toBeNull();
	});

	it("adminCreate resolves null when the insert returning is empty", async () => {
		// A SqlDatabase whose statements always yield zero rows: the
		// duplicate pre-check passes and the INSERT ... RETURNING comes
		// back empty, so adminCreate's `rows[0] ?? null` arm fires.
		const emptyStatement: SqlStatement = {
			bind: () => emptyStatement,
			first: async <T = unknown>() => null as T | null,
			run: async () => ({ success: true, results: [], meta: {} }),
			all: async <T = unknown>() => ({
				success: true,
				results: [] as T[],
				meta: {},
			}),
			raw: async <T = unknown[]>() => [] as unknown as T[],
		};
		const emptySql: SqlDatabase = {
			prepare: () => emptyStatement,
			dump: async () => new ArrayBuffer(0),
			batch: async () => [],
			exec: async () => ({ count: 0, duration: 0 }),
		};
		const deps = Layer.merge(
			Layer.succeed(Db, makeDb(emptySql)),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const rt = ManagedRuntime.make(PagesLive.pipe(Layer.provide(deps)));
		try {
			const row = await rt.runPromise(
				Effect.gen(function* () {
					const pages = yield* Pages;
					return yield* pages.adminCreate(input());
				}).pipe(
					Effect.provideService(Principal, {
						userId: "admin-1",
						email: "admin@x.com",
					}),
				),
			);
			expect(row).toBeNull();
		} finally {
			await rt.dispose();
		}
	});

	it("navList returns published+showInNav rows ordered by sortOrder then title", async () => {
		await admin((p) =>
			p.adminCreate(
				input({
					path: "/nav-b",
					title: "Beta",
					published: true,
					showInNav: true,
					sortOrder: 1,
				}),
			),
		);
		await admin((p) =>
			p.adminCreate(
				input({
					path: "/nav-a",
					title: "Alpha",
					published: true,
					showInNav: true,
					sortOrder: 1,
				}),
			),
		);
		// Published but not flagged, and flagged but unpublished — excluded.
		await admin((p) =>
			p.adminCreate(input({ path: "/nav-off", published: true, showInNav: false })),
		);
		await admin((p) =>
			p.adminCreate(input({ path: "/nav-draft", published: false, showInNav: true })),
		);
		const rows = await asUser(
			null,
			call((p) => p.navList()),
		);
		const paths = rows.map((r) => r.path);
		expect(paths).toContain("/nav-a");
		expect(paths).toContain("/nav-b");
		expect(paths).toContain("/team"); // published + showInNav from earlier test
		expect(paths).not.toContain("/nav-off");
		expect(paths).not.toContain("/nav-draft");
		// sortOrder 1 rows come before /team (sortOrder 2); ties by title.
		expect(paths.indexOf("/nav-a")).toBeLessThan(paths.indexOf("/nav-b"));
		expect(paths.indexOf("/nav-b")).toBeLessThan(paths.indexOf("/team"));
	});

	it("adminGet returns the full row incl. builderJson; missing ids resolve null", async () => {
		const created = await admin((p) => p.adminCreate(input({ path: "/built" })));
		const fetched = await admin((p) => p.adminGet(created!.id));
		expect(fetched?.path).toBe("/built");
		expect(fetched?.builderJson).toBeNull();
		await expect(admin((p) => p.adminGet(9999))).resolves.toBeNull();
	});

	it("adminSetBuilderJson writes, clears and rejects malformed docs", async () => {
		const created = await admin((p) => p.adminCreate(input({ path: "/doc" })));
		const doc = '{"version":1,"data":{"content":[]}}';
		const written = await admin((p) => p.adminSetBuilderJson(created!.id, doc));
		expect(written.builderJson).toBe(doc);
		const reread = await admin((p) => p.adminGet(created!.id));
		expect(reread?.builderJson).toBe(doc);

		// null clears the document.
		const cleared = await admin((p) => p.adminSetBuilderJson(created!.id, null));
		expect(cleared.builderJson).toBeNull();

		// Malformed payloads: non-JSON, non-object JSON and arrays.
		for (const bad of ["not json", '"str"', "[1,2]", "42"]) {
			await expect(admin((p) => p.adminSetBuilderJson(created!.id, bad))).rejects.toBeInstanceOf(
				InvalidBuilderDoc,
			);
		}
		// Missing row → PageNotFound.
		await expect(admin((p) => p.adminSetBuilderJson(9999, doc))).rejects.toBeInstanceOf(
			PageNotFound,
		);
		// Non-admin principals are denied.
		await expect(
			asUser(
				"u-1",
				call((p) => p.adminSetBuilderJson(created!.id, doc)),
				"doc@x.com",
			),
		).rejects.toBeInstanceOf(Forbidden);
	});
});

describe("Pages.validatedSearch", () => {
	const depsFor = (schemasLayer?: Layer.Layer<Schemas>) => {
		const db = makeDb(makeTestD1());
		const base = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const all = schemasLayer === undefined ? base : Layer.mergeAll(base, schemasLayer);
		return { db, layer: PagesLive.pipe(Layer.provide(all)) };
	};

	// `validate` is typed loosely on purpose: stubs exercise failure and
	// malformed-issue shapes the real service's `never` error channel
	// would not admit.
	const schemasStub = (validate: unknown) =>
		Layer.succeed(
			Schemas,
			Schemas.of({
				adminList: () => Effect.succeed([]),
				adminGet: () => Effect.succeed(null),
				adminCreate: () => Effect.succeed(null),
				adminUpdate: () => Effect.die("unused"),
				adminRemove: () => Effect.die("unused"),
				getById: () => Effect.succeed(null),
				validate: validate as Schemas["Service"]["validate"],
			}),
		);

	const seed = async (db: ReturnType<typeof makeDb>) => {
		const now = new Date();
		await db.insert(page).values([
			{
				path: "/search",
				title: "Search",
				searchSchemaId: 3,
				published: true,
				showInNav: false,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			},
			{
				path: "/plain",
				title: "Plain",
				searchSchemaId: null,
				published: true,
				showInNav: false,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			},
			{
				path: "/draft-search",
				title: "Draft",
				searchSchemaId: 3,
				published: false,
				showInNav: false,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			},
		]);
	};

	it("passes search through when the page binds no schema", async () => {
		const { db, layer } = depsFor();
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const out = await rt.runPromise(
				Effect.flatMap(Pages, (p) => p.validatedSearch("/plain", { anything: "goes" })),
			);
			expect(out).toEqual({ anything: "goes" });
		} finally {
			await rt.dispose();
		}
	});

	it("passes search through for missing or unpublished pages", async () => {
		const validate = vi.fn(() => Effect.succeed({ valid: false, issues: [] }));
		const { db, layer } = depsFor(schemasStub(validate));
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const missing = await rt.runPromise(
				Effect.flatMap(Pages, (p) => p.validatedSearch("/missing", { a: 1 })),
			);
			const draft = await rt.runPromise(
				Effect.flatMap(Pages, (p) => p.validatedSearch("/draft-search/", { a: 1 })),
			);
			expect(missing).toEqual({ a: 1 });
			expect(draft).toEqual({ a: 1 });
			expect(validate).not.toHaveBeenCalled();
		} finally {
			await rt.dispose();
		}
	});

	it("passes search through when the Schemas service is absent", async () => {
		const { db, layer } = depsFor();
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const out = await rt.runPromise(
				Effect.flatMap(Pages, (p) => p.validatedSearch("/search", { q: "x" })),
			);
			expect(out).toEqual({ q: "x" });
		} finally {
			await rt.dispose();
		}
	});

	it("returns the input unchanged when validation passes", async () => {
		const validate = vi.fn(() => Effect.succeed({ valid: true, issues: [] }));
		const { db, layer } = depsFor(schemasStub(validate));
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const search = { q: "x", page: "2" };
			const out = await rt.runPromise(
				Effect.flatMap(Pages, (p) => p.validatedSearch("/search", search)),
			);
			expect(out).toEqual(search);
			expect(validate).toHaveBeenCalledWith(3, search);
		} finally {
			await rt.dispose();
		}
	});

	it("strips top-level keys blamed by issue paths, preserving the rest", async () => {
		const validate = vi.fn(() =>
			Effect.succeed({
				valid: false,
				issues: [
					{ path: "filter.tag", keyword: "type", message: "bad" },
					{ path: "items[0].id", keyword: "type", message: "bad" },
					{ path: "$", keyword: "type", message: "root" },
					{ path: "", keyword: "type", message: "empty" },
				],
			}),
		);
		const { db, layer } = depsFor(schemasStub(validate));
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const out = await rt.runPromise(
				Effect.flatMap(Pages, (p) =>
					p.validatedSearch("/search", {
						filter: { tag: 1 },
						items: [{ id: "x" }],
						q: "keep",
					}),
				),
			);
			// "filter.tag" blames "filter", "items[0].id" blames "items";
			// "$"/"" blame nothing — "q" survives untouched.
			expect(out).toEqual({ q: "keep" });
		} finally {
			await rt.dispose();
		}
	});

	it("blames bare top-level keys and ignores paths that start with a segment", async () => {
		// "plain" has no "." or "[" — the whole path is the key.
		// "[0]"/".deep" start with a segment → empty key → ignored.
		const validate = vi.fn(() =>
			Effect.succeed({
				valid: false,
				issues: [
					{ path: "plain", keyword: "type", message: "bad" },
					{ path: "[0]", keyword: "type", message: "bad" },
					{ path: ".deep", keyword: "type", message: "bad" },
				],
			}),
		);
		const { db, layer } = depsFor(schemasStub(validate));
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const out = await rt.runPromise(
				Effect.flatMap(Pages, (p) => p.validatedSearch("/search", { plain: "drop", q: "keep" })),
			);
			expect(out).toEqual({ q: "keep" });
		} finally {
			await rt.dispose();
		}
	});

	it("keeps every param when issues name no top-level key", async () => {
		const validate = vi.fn(() =>
			Effect.succeed({
				valid: false,
				issues: [{ path: "$", keyword: "type", message: "root" }],
			}),
		);
		const { db, layer } = depsFor(schemasStub(validate));
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const out = await rt.runPromise(
				Effect.flatMap(Pages, (p) => p.validatedSearch("/search", { a: 1, b: 2 })),
			);
			expect(out).toEqual({ a: 1, b: 2 });
		} finally {
			await rt.dispose();
		}
	});

	it("passes search through when the validate effect fails", async () => {
		const validate = vi.fn(() => Effect.fail(new Error("schema exploded")));
		const { db, layer } = depsFor(schemasStub(validate));
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const out = await rt.runPromise(
				Effect.flatMap(Pages, (p) => p.validatedSearch("/search", { q: "x" })),
			);
			expect(out).toEqual({ q: "x" });
		} finally {
			await rt.dispose();
		}
	});
});

describe("pagesRichTextDeleteHook", () => {
	let db: ReturnType<typeof makeDb>;
	let hook: RichTextDeleteHook;
	const now = new Date();

	const insertPage = (over: Partial<typeof page.$inferInsert> = {}) =>
		db.insert(page).values({
			path: "/x",
			title: "X",
			published: false,
			showInNav: false,
			sortOrder: 0,
			createdAt: now,
			updatedAt: now,
			...over,
		});

	const allPages = () => db.select().from(page);

	beforeAll(() => {
		db = makeDb(makeTestD1());
		hook = pagesRichTextDeleteHook(db);
	});

	it("has the 'pages' id and usage returns only referencing rows", async () => {
		expect(hook.id).toBe("pages");
		await insertPage({ path: "/a", title: "A", richTextId: 7 });
		await insertPage({ path: "/b", title: "B", richTextId: 7 });
		await insertPage({ path: "/c", title: "C", richTextId: 8 });
		await insertPage({ path: "/d", title: "D", richTextId: null });
		const items = await Effect.runPromise(hook.usage(7));
		expect(items).toHaveLength(2);
		expect(items.map((i) => i.path ?? "").sort((a, b) => a.localeCompare(b))).toEqual(["/a", "/b"]);
		expect(items.map((i) => i.title).sort((a, b) => a.localeCompare(b))).toEqual(["A", "B"]);
		// Unreferenced doc → empty; ids are the page row ids.
		expect(await Effect.runPromise(hook.usage(999))).toEqual([]);
		const ids = items.map((i) => i.id);
		const rows = await allPages();
		expect(ids.sort((a, b) => a - b)).toEqual(
			rows
				.filter((r) => r.richTextId === 7)
				.map((r) => r.id)
				.sort((a, b) => a - b),
		);
	});

	it("cleanup 'pages.unlink-unpublish' unlinks and unpublishes, preserving the rest", async () => {
		await insertPage({
			path: "/u1",
			title: "U1",
			richTextId: 9,
			published: true,
			showInNav: true,
			sortOrder: 3,
		});
		await insertPage({ path: "/u2", title: "U2", richTextId: 9, published: true });
		await insertPage({ path: "/keep", title: "Keep", richTextId: 10, published: true });
		await Effect.runPromise(hook.cleanup(9, "pages.unlink-unpublish"));
		const rows = await allPages();
		const u1 = rows.find((r) => r.path === "/u1")!;
		expect(u1.richTextId).toBeNull();
		expect(u1.published).toBe(false);
		// Untouched fields survive.
		expect(u1.title).toBe("U1");
		expect(u1.path).toBe("/u1");
		expect(u1.showInNav).toBe(true);
		expect(u1.sortOrder).toBe(3);
		const u2 = rows.find((r) => r.path === "/u2")!;
		expect(u2.richTextId).toBeNull();
		expect(u2.published).toBe(false);
		// Other documents are unaffected.
		const keep = rows.find((r) => r.path === "/keep")!;
		expect(keep.richTextId).toBe(10);
		expect(keep.published).toBe(true);
	});

	it("cleanup 'pages.delete-pages' removes referencing pages only", async () => {
		await insertPage({ path: "/del-1", richTextId: 11 });
		await insertPage({ path: "/del-2", richTextId: 11 });
		await insertPage({ path: "/del-keep", richTextId: 12 });
		await Effect.runPromise(hook.cleanup(11, "pages.delete-pages"));
		const paths = (await allPages()).map((r) => r.path);
		expect(paths).not.toContain("/del-1");
		expect(paths).not.toContain("/del-2");
		expect(paths).toContain("/del-keep");
	});

	it("cleanup no-ops on foreign action ids and unreferenced docs", async () => {
		await insertPage({ path: "/noop", richTextId: 13, published: true });
		await Effect.runPromise(hook.cleanup(13, "other.plugin.action"));
		await Effect.runPromise(hook.cleanup(999, "pages.delete-pages"));
		await Effect.runPromise(hook.cleanup(999, "pages.unlink-unpublish"));
		const row = (await allPages()).find((r) => r.path === "/noop")!;
		expect(row.richTextId).toBe(13);
		expect(row.published).toBe(true);
	});

	it("PagesLive registers the hook when the registry is provided", async () => {
		let captured: RichTextDeleteHook | undefined;
		const hooks = RichTextDeleteHooks.of({
			register: (h) => {
				captured = h;
				return Effect.void;
			},
			usage: () => Effect.succeed([]),
			cleanup: () => Effect.void,
		});
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			Layer.succeed(RichTextDeleteHooks, hooks),
		);
		const rt = ManagedRuntime.make(PagesLive.pipe(Layer.provide(deps)));
		try {
			// Building the layer runs the registration.
			await rt.runPromise(Effect.flatMap(Pages, (p) => p.navList()));
			expect(captured?.id).toBe("pages");
			// The registered hook is live against the same db.
			await insertPage({ path: "/reg", title: "Reg", richTextId: 21 });
			expect(await Effect.runPromise(captured!.usage(21))).toHaveLength(1);
		} finally {
			await rt.dispose();
		}
	});

	it("PagesLive builds without the registry (serviceOption → None)", async () => {
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const rt = ManagedRuntime.make(PagesLive.pipe(Layer.provide(deps)));
		try {
			const rows = await rt.runPromise(Effect.flatMap(Pages, (p) => p.navList()));
			expect(Array.isArray(rows)).toBe(true);
		} finally {
			await rt.dispose();
		}
	});
});
