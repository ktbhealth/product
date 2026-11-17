import { describe, expect, it, vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
	DocumentStore,
	type DocumentRecord,
	type DocumentStoreShape,
	type FindResult,
} from "@ktb/document-store";
import { Permissions, type PermissionsShape } from "@ktb/rbac";

import type { ViewDef } from "./definition.ts";
import { ViewDefinitions } from "./definition.ts";
import { REF_LOOKUP_CAP, Views, ViewsLive, type ViewsShape } from "./service.ts";
import type { ViewPageWire } from "./wire.ts";

const DEF: ViewDef = {
	id: "notes",
	title: "Notes",
	collection: "clinic.notes",
	kind: "table",
	fields: [{ field: "title" }, { field: "body" }],
};

const record = (over: Partial<DocumentRecord> = {}): DocumentRecord =>
	({
		id: 1,
		collectionId: 2,
		collection: "clinic.notes",
		data: { title: "t", body: "b" },
		ownerId: "u1",
		tenantId: null,
		createdAt: new Date("2024-01-01T00:00:00.000Z"),
		updatedAt: new Date("2024-01-02T00:00:00.000Z"),
		...over,
	}) as DocumentRecord;

const store = (over: Record<string, unknown> = {}): DocumentStoreShape =>
	({
		find: () => Effect.succeed({ rows: [], total: 0 }),
		get: () => Effect.succeed(null),
		...over,
	}) as unknown as DocumentStoreShape;

const permissions = (can: PermissionsShape["can"]): PermissionsShape =>
	({ can }) as PermissionsShape;

const makeViews = (
	defs: readonly ViewDef[],
	docStore: DocumentStoreShape,
	perms?: PermissionsShape,
): Effect.Effect<ViewsShape> =>
	Effect.scoped(
		Layer.build(
			ViewsLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(ViewDefinitions, { views: defs }),
						Layer.succeed(DocumentStore, docStore),
						...(perms === undefined ? [] : [Layer.succeed(Permissions, perms)]),
					),
				),
			),
		),
	).pipe(Effect.map((ctx) => Context.get(ctx, Views)));

const run = <A, E>(eff: Effect.Effect<A, E, Views>, views: ViewsShape): Promise<A> =>
	Effect.runPromise(eff.pipe(Effect.provideService(Views, views)));

describe("Views.allows", () => {
	it("denies unparseable paths, unknown keys and forbidden permissions", async () => {
		const views = await Effect.runPromise(makeViews([DEF], store()));
		expect(await run(views.allows("/nope"), views)).toBe(false);
		expect(await run(views.allows("/v/unknown"), views)).toBe(false);
		const guarded: ViewDef = { ...DEF, id: "g", permission: "patient.read" };
		const noPerms = await Effect.runPromise(makeViews([guarded], store()));
		// permission declared but the rbac port is absent → fail closed
		expect(await run(noPerms.allows("/v/g"), noPerms)).toBe(false);
		const denied = await Effect.runPromise(
			makeViews(
				[guarded],
				store(),
				permissions(() => Effect.succeed(false)),
			),
		);
		expect(await run(denied.allows("/v/g"), denied)).toBe(false);
	});

	it("admits defs without permission and defs whose grant holds", async () => {
		const views = await Effect.runPromise(makeViews([DEF], store()));
		expect(await run(views.allows("/v/notes"), views)).toBe(true);
		const can = vi.fn<PermissionsShape["can"]>(() => Effect.succeed(true));
		const guarded: ViewDef = { ...DEF, id: "g", permission: "patient.read" };
		const allowed = await Effect.runPromise(makeViews([guarded], store(), permissions(can)));
		expect(await run(allowed.allows("/v/g"), allowed)).toBe(true);
		expect(can).toHaveBeenCalledWith("patient", "read");
	});
});

describe("Views.load — list mode", () => {
	it("returns a list wire with rows, paging and resolved refs", async () => {
		const rows = [
			record({ id: 1, data: { title: "a", author: 9 } }),
			record({ id: 2, data: { title: "b", author: 9 } }),
			record({ id: 3, data: { title: "c", author: "x" } }),
		];
		const find = vi.fn<() => Effect.Effect<FindResult>>(() =>
			Effect.succeed({ rows, total: 42 } satisfies FindResult),
		);
		const get = vi.fn<(collection: string, id: number) => Effect.Effect<DocumentRecord | null>>(
			(collection: string, id: number) =>
				Effect.succeed(
					collection === "clinic.authors" && id === 9
						? record({ id: 9, collection: "clinic.authors", data: { name: "Ana" } })
						: null,
				),
		);
		const def: ViewDef = {
			...DEF,
			fields: [
				{ field: "title" },
				{ field: "author", format: "ref", refCollection: "clinic.authors", refLabelField: "name" },
			],
		};
		const views = await Effect.runPromise(makeViews([def], store({ find, get })));
		const wire = (await run(views.load("/v/notes"), views)) as Extract<
			ViewPageWire,
			{ mode: "list" }
		>;
		expect(wire.mode).toBe("list");
		expect(wire.path).toBe("/v/notes");
		expect(wire.def).toEqual(def);
		expect(wire.rows).toHaveLength(3);
		expect(wire.rows[0]).toMatchObject({ id: 1, createdAt: "2024-01-01T00:00:00.000Z" });
		expect(wire.total).toBe(42);
		expect(wire.pageSize).toBe(25);
		expect(wire.offset).toBe(0);
		// deduped across rows; the non-numeric ref is skipped
		expect(wire.refs).toEqual({ "clinic.authors:9": "Ana" });
		expect(get).toHaveBeenCalledTimes(1);
		expect(find).toHaveBeenCalledWith("clinic.notes", {
			limit: 25,
			offset: 0,
		});
	});

	it("plans declared filters/sort/pageSize into the find query", async () => {
		const find = vi.fn<() => Effect.Effect<FindResult>>(() =>
			Effect.succeed({ rows: [], total: 0 } satisfies FindResult),
		);
		const def: ViewDef = {
			...DEF,
			pageSize: 10,
			sort: [{ field: "title", dir: "asc" }],
			filters: [
				{ field: "kind", op: "$eq", value: "n" },
				{ field: "title", op: "$regex" },
			],
		};
		const views = await Effect.runPromise(makeViews([def], store({ find })));
		await run(views.load("/v/notes"), views);
		expect(find).toHaveBeenCalledWith("clinic.notes", {
			filter: { kind: { $eq: "n" } },
			sort: [{ field: "title", dir: "asc" }],
			limit: 10,
			offset: 0,
		});
	});

	it("caps ref lookups at REF_LOOKUP_CAP", async () => {
		const rows = Array.from({ length: REF_LOOKUP_CAP + 10 }, (_, i) =>
			record({ id: i + 1, data: { title: `t${i}`, author: i + 1 } }),
		);
		const get = vi.fn<() => Effect.Effect<DocumentRecord | null>>(() => Effect.succeed(null));
		const def: ViewDef = {
			...DEF,
			fields: [
				{ field: "title" },
				{ field: "author", format: "ref", refCollection: "clinic.authors" },
			],
		};
		const views = await Effect.runPromise(
			makeViews([def], store({ find: () => Effect.succeed({ rows, total: rows.length }), get })),
		);
		const wire = (await run(views.load("/v/notes"), views)) as { refs: object };
		expect(Object.keys(wire.refs)).toHaveLength(0);
		expect(get).toHaveBeenCalledTimes(REF_LOOKUP_CAP);
	});

	it("labels ref fallbacks: missing target, null label value, absent label field", async () => {
		const rows = [
			record({ id: 1, data: { a: 1, b: 2, c: 3 } }),
			record({ id: 2, data: { a: 2, b: 5, c: 6 } }),
			record({ id: 3, data: { a: 7, b: 8, c: 9 } }),
		];
		const get = vi.fn<(_c: string, id: number) => Effect.Effect<DocumentRecord | null>>(
			(_c: string, id: number) => {
				if (id === 1) return Effect.succeed(null); // missing target
				if (id === 2) return Effect.succeed(record({ data: { lbl: null } }));
				if (id === 3) return Effect.succeed(record({ data: { name: "See" } }));
				return Effect.succeed(record({ data: { other: "x" } }));
			},
		);
		const def: ViewDef = {
			...DEF,
			fields: [
				{ field: "title" },
				{ field: "a", format: "ref", refCollection: "t.one", refLabelField: "lbl" },
				{ field: "b", format: "ref", refCollection: "t.two" },
				{ field: "c", format: "ref", refCollection: "t.three", refLabelField: "name" },
			],
		};
		const views = await Effect.runPromise(
			makeViews(
				[def],
				store({
					find: () => Effect.succeed({ rows, total: rows.length }),
					get: get as never,
				}),
			),
		);
		const wire = (await run(views.load("/v/notes"), views)) as { refs: Record<string, string> };
		expect(wire.refs["t.one:1"]).toBeUndefined(); // target record missing
		expect(wire.refs["t.one:2"]).toBe("#2"); // label value null → fallback
		expect(wire.refs["t.one:7"]).toBe("#7"); // label path absent → fallback
		expect(wire.refs["t.two:5"]).toBe("#5"); // no label field → fallback
		expect(wire.refs["t.three:3"]).toBe("See"); // label resolves to text
		expect(wire.refs["t.three:9"]).toBe("#9"); // label path absent → fallback
	});

	it("ignores ref fields without a refCollection (no lookups)", async () => {
		const rows = [record({ data: { title: "t", author: 3 } })];
		const get = vi.fn<() => Effect.Effect<DocumentRecord | null>>(() => Effect.succeed(null));
		const def: ViewDef = {
			...DEF,
			fields: [{ field: "author", format: "ref" }],
		};
		const views = await Effect.runPromise(
			makeViews(
				[def],
				store({ find: () => Effect.succeed({ rows, total: 1 }), get: get as never }),
			),
		);
		const wire = (await run(views.load("/v/notes"), views)) as { refs: object };
		expect(wire.refs).toEqual({});
		expect(get).not.toHaveBeenCalled();
	});

	it("swallows per-target lookup errors", async () => {
		const rows = [record({ data: { title: "t", author: 3 } })];
		const def: ViewDef = {
			...DEF,
			fields: [{ field: "author", format: "ref", refCollection: "gone.coll" }],
		};
		const views = await Effect.runPromise(
			makeViews(
				[def],
				store({
					find: () => Effect.succeed({ rows, total: 1 }),
					get: () => Effect.fail({ _tag: "UnknownCollection", name: "gone.coll" }),
				}),
			),
		);
		const wire = (await run(views.load("/v/notes"), views)) as { refs: object };
		expect(wire.refs).toEqual({});
	});

	it("returns null for unknown paths and unregistered collections", async () => {
		const views = await Effect.runPromise(
			makeViews(
				[DEF],
				store({
					find: () => Effect.fail({ _tag: "UnknownCollection", name: "clinic.notes" }),
				}),
			),
		);
		expect(await run(views.load("/nope"), views)).toBeNull();
		expect(await run(views.load("/v/other"), views)).toBeNull();
		expect(await run(views.load("/v/notes"), views)).toBeNull();
	});

	it("propagates non-collection store errors", async () => {
		const views = await Effect.runPromise(
			makeViews(
				[DEF],
				store({
					find: () => Effect.fail({ _tag: "InvalidDocumentQuery", collection: "x", issues: [] }),
				}),
			),
		);
		await expect(run(views.load("/v/notes"), views)).rejects.toMatchObject({
			_tag: "InvalidDocumentQuery",
		});
	});
});

describe("Views.load — detail mode", () => {
	const detailDef: ViewDef = {
		...DEF,
		kind: "detail",
		detailFields: [
			{ field: "title" },
			{ field: "doc", format: "ref", refCollection: "docs.lib", refLabelField: "name" },
		],
	};

	it("returns the record wire with detail-field refs", async () => {
		const get = vi.fn<(collection: string) => Effect.Effect<DocumentRecord | null>>(
			(collection: string) =>
				Effect.succeed(
					collection === "docs.lib"
						? record({ id: 8, collection: "docs.lib", data: { name: "Doc" } })
						: record({ id: 5, data: { title: "n", doc: 8 } }),
				),
		);
		const views = await Effect.runPromise(makeViews([detailDef], store({ get: get as never })));
		const wire = (await run(views.load("/v/notes/5"), views)) as Extract<
			ViewPageWire,
			{ mode: "detail" }
		>;
		expect(wire.mode).toBe("detail");
		expect(wire.path).toBe("/v/notes");
		expect(wire.record?.id).toBe(5);
		expect(wire.refs).toEqual({ "docs.lib:8": "Doc" });
	});

	it("falls back to fields for ref resolution when detailFields is absent", async () => {
		const def: ViewDef = {
			...DEF,
			kind: "detail",
			fields: [{ field: "doc", format: "ref", refCollection: "docs.lib" }],
		};
		const get = vi.fn<(collection: string) => Effect.Effect<DocumentRecord | null>>(
			(collection: string) =>
				Effect.succeed(
					collection === "docs.lib"
						? record({ id: 8, collection: "docs.lib" })
						: record({ id: 5, data: { doc: 8 } }),
				),
		);
		const views = await Effect.runPromise(makeViews([def], store({ get: get as never })));
		const wire = (await run(views.load("/v/notes/5"), views)) as {
			refs: Record<string, string>;
		};
		expect(wire.refs["docs.lib:8"]).toBe("#8");
	});

	it("returns record:null for missing/invisible records", async () => {
		const views = await Effect.runPromise(makeViews([detailDef], store()));
		const wire = (await run(views.load("/v/notes/5"), views)) as {
			record: unknown;
			refs: Record<string, string>;
		};
		expect(wire.record).toBeNull();
		expect(wire.refs).toEqual({});
	});

	it("returns null for unregistered detail collections", async () => {
		const views = await Effect.runPromise(
			makeViews(
				[detailDef],
				store({ get: () => Effect.fail({ _tag: "UnknownCollection", name: "x" }) }),
			),
		);
		expect(await run(views.load("/v/notes/5"), views)).toBeNull();
	});
});

describe("Views.query", () => {
	it("re-queries list payloads with offset and filter values", async () => {
		const find = vi.fn<() => Effect.Effect<FindResult>>(() =>
			Effect.succeed({ rows: [record()], total: 3 } satisfies FindResult),
		);
		const def: ViewDef = {
			...DEF,
			filters: [{ field: "title", op: "$regex", param: "q" }],
		};
		const views = await Effect.runPromise(makeViews([def], store({ find })));
		const wire = (await run(
			views.query("/v/notes", { offset: 25, values: { q: "an" } }),
			views,
		)) as {
			offset: number;
		};
		expect(wire.offset).toBe(25);
		expect(find).toHaveBeenCalledWith("clinic.notes", {
			filter: { title: { $regex: "an" } },
			limit: 25,
			offset: 25,
		});
	});

	it("returns null for detail paths, unknown views and bad collections", async () => {
		const views = await Effect.runPromise(makeViews([DEF], store()));
		expect(await run(views.query("/v/notes/3"), views)).toBeNull();
		expect(await run(views.query("/v/nope"), views)).toBeNull();
		const broken = await Effect.runPromise(
			makeViews(
				[DEF],
				store({ find: () => Effect.fail({ _tag: "UnknownCollection", name: "x" }) }),
			),
		);
		expect(await run(broken.query("/v/notes"), broken)).toBeNull();
	});

	it("collapses InvalidDocumentQuery to null (bad interactive operand)", async () => {
		// Interactive filter values are raw user input — a bad operand
		// shape fails store-side validation; the fn contract treats it
		// like an invisible view rather than a 500.
		const views = await Effect.runPromise(
			makeViews(
				[DEF],
				store({
					find: () =>
						Effect.fail({
							_tag: "InvalidDocumentQuery",
							collection: "clinic.notes",
							issues: ["bad operand"],
						}),
				}),
			),
		);
		expect(await run(views.query("/v/notes", { values: { q: "[" } }), views)).toBeNull();
	});
});
