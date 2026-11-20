import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type SqlDatabase, type SqlStatement } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { RichTextDeleteHooks, type RichTextDeleteHook } from "@ktb/rich-text/delete-hooks";
import { RichTexts } from "@ktb/rich-text/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { layouts } from "./schema.ts";
import {
	InvalidBuilderDoc,
	InvalidLayoutConfig,
	InvalidLayoutName,
	LAYOUTS_TEST_DDL,
	LayoutNameTaken,
	LayoutNotFound,
	Layouts,
	LayoutsLive,
	layoutsRichTextDeleteHook,
} from "./service.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CONFIG = JSON.stringify({
	sections: [
		{ id: "hero", title: "Hero", kind: "rich-text", refId: 1 },
		{ id: "body", title: "Body", kind: "rich-text", refId: 2 },
	],
});

const DOC_VALUE = [{ type: "p", children: [{ text: "Hello" }] }];

/** RichTexts stub whose getById resolves canned content per id. */
const richTextsStub = (docs: Readonly<Record<number, unknown>>) =>
	Layer.succeed(
		RichTexts,
		RichTexts.of({
			adminList: () => Effect.succeed([]),
			adminGet: () => Effect.succeed(null),
			adminCreate: () => Effect.succeed(null),
			adminUpdate: () => Effect.die("unused"),
			adminRemove: () => Effect.die("unused"),
			getById: (id: number) =>
				Effect.succeed(
					id in docs
						? {
								id,
								title: `Doc ${id}`,
								createdAt: new Date(0),
								updatedAt: new Date(0),
								content: docs[id],
							}
						: null,
				),
		}),
	);

describe("LayoutsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Layouts, never>;
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(LAYOUTS_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(LayoutsLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Layouts>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (p: Layouts["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Layouts, f);

	const admin = <A, E>(f: (p: Layouts["Service"]) => Effect.Effect<A, E>) =>
		asUser("admin-1", call(f), "admin@x.com");

	it("adminCreate seeds an empty section list and trims the name", async () => {
		const doc = await admin((p) => p.adminCreate({ name: "  landing-page  " }));
		expect(doc).not.toBeNull();
		expect(doc!.name).toBe("landing-page");
		expect(doc!.description).toBeNull();
		expect(doc!.config).toBe('{"sections":[]}');
		expect(doc!.sectionCount).toBe(0);
		expect(doc!.createdAt).toBeInstanceOf(Date);
		expect(doc!.updatedAt).toBeInstanceOf(Date);
	});

	it("adminCreate honors description and a supplied config", async () => {
		const doc = await admin((p) =>
			p.adminCreate({ name: "two-up", description: "  Split hero  ", config: CONFIG }),
		);
		expect(doc!.description).toBe("Split hero");
		expect(doc!.config).toBe(CONFIG);
		expect(doc!.sectionCount).toBe(2);
	});

	it("adminCreate stores a blank description as null", async () => {
		const doc = await admin((p) => p.adminCreate({ name: "blank-desc", description: "   " }));
		expect(doc!.description).toBeNull();
	});

	it("adminCreate rejects blank names, duplicate names and bad configs", async () => {
		await expect(admin((p) => p.adminCreate({ name: "   " }))).rejects.toBeInstanceOf(
			InvalidLayoutName,
		);
		await expect(admin((p) => p.adminCreate({ name: "landing-page" }))).rejects.toBeInstanceOf(
			LayoutNameTaken,
		);
		const badConfigs = [
			"not json",
			"[]",
			'"x"',
			'{"sections":"nope"}',
			'{"sections":[{"id":"a","title":"A","kind":"video","refId":1}]}',
			'{"sections":[{"id":"","title":"A","kind":"rich-text","refId":1}]}',
			'{"sections":[{"id":"a","title":"A","kind":"rich-text","refId":"1"}]}',
			'{"sections":[{"id":"a","title":"A","kind":"rich-text"}]}',
		];
		for (const [i, bad] of badConfigs.entries()) {
			await expect(
				admin((p) => p.adminCreate({ name: `bad-config-${i}`, config: bad })),
			).rejects.toBeInstanceOf(InvalidLayoutConfig);
		}
	});

	it("adminCreate accepts a null refId slot (the unlink-cleanup state)", async () => {
		const doc = await admin((p) =>
			p.adminCreate({
				name: "empty-slot",
				config: JSON.stringify({
					sections: [{ id: "s1", title: "S1", kind: "rich-text", refId: null }],
				}),
			}),
		);
		expect(doc!.sectionCount).toBe(1);
	});

	it("adminList returns metas ordered by updatedAt desc (no config)", async () => {
		const first = await admin((p) => p.adminCreate({ name: "first" }));
		await sleep(5);
		const second = await admin((p) => p.adminCreate({ name: "second" }));
		const rows = await admin((p) => p.adminList());
		expect(rows.map((r) => r.id)).toContain(first!.id);
		expect(rows.map((r) => r.id)).toContain(second!.id);
		expect(rows.findIndex((r) => r.id === second!.id)).toBeLessThan(
			rows.findIndex((r) => r.id === first!.id),
		);
		// Meta only — the config payload never leaves the service layer.
		expect(rows[0]).not.toHaveProperty("config");
	});

	it("adminGet returns the stored config; missing ids resolve null", async () => {
		const created = await admin((p) => p.adminCreate({ name: "get-me", config: CONFIG }));
		const doc = await admin((p) => p.adminGet(created!.id));
		expect(doc).toMatchObject({ id: created!.id, name: "get-me" });
		expect(doc!.config).toBe(CONFIG);
		await expect(admin((p) => p.adminGet(9999))).resolves.toBeNull();
	});

	it("adminSetBuilderJson writes, clears and rejects malformed docs", async () => {
		const created = await admin((p) => p.adminCreate({ name: "built", config: CONFIG }));
		const doc = '{"version":1,"data":{"content":[]}}';
		const written = await admin((p) => p.adminSetBuilderJson(created!.id, doc));
		expect(written.builderJson).toBe(doc);
		// Public read carries the builder document too.
		const publicDoc = await asUser(
			null,
			call((p) => p.getById(created!.id)),
		);
		expect(publicDoc?.builderJson).toBe(doc);

		// null clears the document — the layout falls back to config.
		const cleared = await admin((p) => p.adminSetBuilderJson(created!.id, null));
		expect(cleared.builderJson).toBeNull();

		for (const bad of ["not json", '"str"', "[1,2]", "42"]) {
			await expect(admin((p) => p.adminSetBuilderJson(created!.id, bad))).rejects.toBeInstanceOf(
				InvalidBuilderDoc,
			);
		}
		await expect(admin((p) => p.adminSetBuilderJson(9999, doc))).rejects.toBeInstanceOf(
			LayoutNotFound,
		);
		await expect(
			asUser(
				"u1",
				call((p) => p.adminSetBuilderJson(created!.id, doc)),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("adminUpdate patches name/description/config and clears blank descriptions", async () => {
		const created = await admin((p) => p.adminCreate({ name: "before", description: "old" }));
		const updated = await admin((p) =>
			p.adminUpdate(created!.id, { name: "after", description: "new", config: CONFIG }),
		);
		expect(updated.id).toBe(created!.id);
		expect(updated.name).toBe("after");
		expect(updated.description).toBe("new");
		expect(updated.config).toBe(CONFIG);
		expect(updated.sectionCount).toBe(2);
		expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());

		const cleared = await admin((p) => p.adminUpdate(created!.id, { description: "  " }));
		expect(cleared.description).toBeNull();
		expect(cleared.name).toBe("after");
		expect(cleared.config).toBe(CONFIG);

		const bumped = await admin((p) => p.adminUpdate(created!.id, {}));
		expect(bumped.name).toBe("after");
	});

	it("adminUpdate rejects bad input and reports missing rows", async () => {
		const created = await admin((p) => p.adminCreate({ name: "guarded" }));
		await expect(admin((p) => p.adminUpdate(created!.id, { name: " " }))).rejects.toBeInstanceOf(
			InvalidLayoutName,
		);
		await expect(
			admin((p) => p.adminUpdate(created!.id, { config: "nope" })),
		).rejects.toBeInstanceOf(InvalidLayoutConfig);
		await expect(
			admin((p) => p.adminUpdate(created!.id, { name: "landing-page" })),
		).rejects.toBeInstanceOf(LayoutNameTaken);
		const same = await admin((p) => p.adminUpdate(created!.id, { name: "guarded" }));
		expect(same.name).toBe("guarded");
		await expect(admin((p) => p.adminUpdate(9999, { name: "ghost" }))).rejects.toBeInstanceOf(
			LayoutNotFound,
		);
	});

	it("adminRemove deletes and reports missing rows", async () => {
		const row = await admin((p) => p.adminCreate({ name: "doomed" }));
		await admin((p) => p.adminRemove(row!.id));
		await expect(admin((p) => p.adminRemove(row!.id))).rejects.toBeInstanceOf(LayoutNotFound);
	});

	it("admin methods are Forbidden for non-admins and anonymous callers", async () => {
		await expect(
			asUser(
				"u1",
				call((p) => p.adminList()),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
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
				call((p) => p.adminGet(1)),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u1",
				call((p) => p.adminCreate({ name: "x" })),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u1",
				call((p) => p.adminUpdate(1, {})),
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

	it("getById is a public read returning the stored config", async () => {
		const created = await admin((p) => p.adminCreate({ name: "public", config: CONFIG }));
		const doc = await asUser(
			null,
			call((p) => p.getById(created!.id)),
		);
		expect(doc).toMatchObject({ id: created!.id, name: "public" });
		expect(doc!.config).toBe(CONFIG);
		await expect(
			asUser(
				null,
				call((p) => p.getById(9999)),
			),
		).resolves.toBeNull();
	});

	it("toMeta degrades a corrupt stored config to sectionCount 0", async () => {
		// Stored JSON that fails the contract still lists — `toMeta`'s
		// `?.sections.length ?? 0` arm resolves the count to 0 instead
		// of breaking the row.
		const now = new Date();
		await db
			.insert(layouts)
			.values({ name: "corrupt-meta", config: "{oops", createdAt: now, updatedAt: now });
		const rows = await admin((p) => p.adminList());
		const meta = rows.find((r) => r.name === "corrupt-meta")!;
		expect(meta.sectionCount).toBe(0);
		const doc = await asUser(
			null,
			call((p) => p.getById(meta.id)),
		);
		expect(doc!.sectionCount).toBe(0);
	});

	it("adminCreate resolves null when the insert returning is empty", async () => {
		// A SqlDatabase whose statements always yield zero rows: the
		// INSERT ... RETURNING comes back empty, so adminCreate's
		// `rows[0] ?? null` arm fires.
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
		const rt = ManagedRuntime.make(LayoutsLive.pipe(Layer.provide(deps)));
		try {
			const doc = await rt.runPromise(
				Effect.gen(function* () {
					const layouts = yield* Layouts;
					return yield* layouts.adminCreate({ name: "ghost" });
				}).pipe(
					Effect.provideService(Principal, {
						userId: "admin-1",
						email: "admin@x.com",
					}),
				),
			);
			expect(doc).toBeNull();
		} finally {
			await rt.dispose();
		}
	});
});

describe("Layouts.resolveForPage", () => {
	const depsFor = (extra?: Layer.Layer<RichTexts>) => {
		const db = makeDb(makeD1(LAYOUTS_TEST_DDL));
		const base = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const all = extra === undefined ? base : Layer.mergeAll(base, extra);
		return { db, layer: LayoutsLive.pipe(Layer.provide(all)) };
	};

	const seed = async (db: ReturnType<typeof makeDb>) => {
		const now = new Date();
		await db.insert(layouts).values([
			{
				name: "bound",
				description: null,
				config: JSON.stringify({
					sections: [
						{ id: "s1", title: "First", kind: "rich-text", refId: 1 },
						{ id: "s2", title: "Second", kind: "rich-text", refId: 2 },
						{ id: "s3", title: "Empty", kind: "rich-text", refId: null },
						{ id: "s4", title: "Missing", kind: "rich-text", refId: 99 },
					],
				}),
				createdAt: now,
				updatedAt: now,
			},
			{
				name: "corrupt",
				description: null,
				config: "{not json",
				createdAt: now,
				updatedAt: now,
			},
		]);
	};

	const idByName = async (db: ReturnType<typeof makeDb>, name: string) => {
		const all = await db.select().from(layouts);
		return all.find((r) => r.name === name)!.id;
	};

	it("resolves ordered sections with slot content; skips empty/missing slots", async () => {
		const { db, layer } = depsFor(richTextsStub({ 1: DOC_VALUE, 2: [{ type: "p" }] }));
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const id = await idByName(db, "bound");
			const sections = await rt.runPromise(Effect.flatMap(Layouts, (p) => p.resolveForPage(id)));
			expect(sections).toEqual([
				{ id: "s1", title: "First", content: DOC_VALUE },
				{ id: "s2", title: "Second", content: [{ type: "p" }] },
			]);
		} finally {
			await rt.dispose();
		}
	});

	it("resolves null for a missing layout and [] for a corrupt config", async () => {
		const { db, layer } = depsFor(richTextsStub({}));
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const corruptId = await idByName(db, "corrupt");
			await expect(
				rt.runPromise(Effect.flatMap(Layouts, (p) => p.resolveForPage(9999))),
			).resolves.toBeNull();
			await expect(
				rt.runPromise(Effect.flatMap(Layouts, (p) => p.resolveForPage(corruptId))),
			).resolves.toEqual([]);
		} finally {
			await rt.dispose();
		}
	});

	it("degrades to an empty section list when the rich-text service is absent", async () => {
		const { db, layer } = depsFor();
		await seed(db);
		const rt = ManagedRuntime.make(layer as Layer.Layer<unknown, never, never>);
		try {
			const id = await idByName(db, "bound");
			const sections = await rt.runPromise(Effect.flatMap(Layouts, (p) => p.resolveForPage(id)));
			expect(sections).toEqual([]);
		} finally {
			await rt.dispose();
		}
	});
});

describe("layoutsRichTextDeleteHook", () => {
	let db: ReturnType<typeof makeDb>;
	let hook: RichTextDeleteHook;
	const now = new Date();

	const configWith = (refIds: readonly (number | null)[]) =>
		JSON.stringify({
			sections: refIds.map((refId, i) => ({
				id: `s${i}`,
				title: `S${i}`,
				kind: "rich-text",
				refId,
			})),
		});

	const insertLayout = (name: string, config: string) =>
		db.insert(layouts).values({ name, config, createdAt: now, updatedAt: now });

	const allLayouts = () => db.select().from(layouts);

	beforeAll(() => {
		db = makeDb(makeD1(LAYOUTS_TEST_DDL));
		hook = layoutsRichTextDeleteHook(db);
	});

	it("has the 'layouts' id and usage returns only referencing layouts", async () => {
		expect(hook.id).toBe("layouts");
		await insertLayout("uses-7", configWith([7, 8]));
		await insertLayout("uses-8", configWith([8]));
		await insertLayout("uses-none", configWith([null]));
		await insertLayout("corrupt", "{not json");
		const items = await Effect.runPromise(hook.usage(7));
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ title: "uses-7", path: "/platform/layouts" });
		const items8 = await Effect.runPromise(hook.usage(8));
		expect(items8.map((i) => i.title).sort()).toEqual(["uses-7", "uses-8"]);
		expect(await Effect.runPromise(hook.usage(999))).toEqual([]);
	});

	it("cleanup 'layouts.unlink-slots' nulls matching refIds and keeps the layout", async () => {
		await insertLayout("unlink-me", configWith([9, 10, 9]));
		await insertLayout("unlink-keep", configWith([11]));
		await Effect.runPromise(hook.cleanup(9, "layouts.unlink-slots"));
		const rows = await allLayouts();
		const target = rows.find((r) => r.name === "unlink-me")!;
		const config = JSON.parse(target.config) as {
			sections: { refId: number | null }[];
		};
		expect(config.sections.map((s) => s.refId)).toEqual([null, 10, null]);
		// Untouched layout keeps its refs.
		const keep = rows.find((r) => r.name === "unlink-keep")!;
		expect(JSON.parse(keep.config)).toEqual({
			sections: [{ id: "s0", title: "S0", kind: "rich-text", refId: 11 }],
		});
	});

	it("cleanup 'layouts.delete-layouts' removes referencing layouts only", async () => {
		await insertLayout("del-1", configWith([12]));
		await insertLayout("del-2", configWith([12, 13]));
		await insertLayout("del-keep", configWith([14]));
		await Effect.runPromise(hook.cleanup(12, "layouts.delete-layouts"));
		const names = (await allLayouts()).map((r) => r.name);
		expect(names).not.toContain("del-1");
		expect(names).not.toContain("del-2");
		expect(names).toContain("del-keep");
	});

	it("cleanup no-ops on foreign action ids and unreferenced docs", async () => {
		await insertLayout("noop", configWith([15]));
		await Effect.runPromise(hook.cleanup(15, "other.plugin.action"));
		await Effect.runPromise(hook.cleanup(999, "layouts.delete-layouts"));
		await Effect.runPromise(hook.cleanup(999, "layouts.unlink-slots"));
		const row = (await allLayouts()).find((r) => r.name === "noop")!;
		expect(row.config).toBe(configWith([15]));
	});

	it("LayoutsLive registers the hook when the registry is provided", async () => {
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
		const rt = ManagedRuntime.make(LayoutsLive.pipe(Layer.provide(deps)));
		try {
			// Building the layer runs the registration.
			await rt.runPromise(Effect.flatMap(Layouts, (p) => p.getById(1)));
			expect(captured?.id).toBe("layouts");
		} finally {
			await rt.dispose();
		}
	});

	it("LayoutsLive builds without the registry (serviceOption → None)", async () => {
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const rt = ManagedRuntime.make(LayoutsLive.pipe(Layer.provide(deps)));
		try {
			// Layer builds and serves reads; there is no registry to
			// register the delete hook with, which is fine.
			const doc = await rt.runPromise(Effect.flatMap(Layouts, (p) => p.getById(1)));
			expect(doc?.id).toBe(1);
		} finally {
			await rt.dispose();
		}
	});
});
