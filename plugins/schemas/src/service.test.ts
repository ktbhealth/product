import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type SqlDatabase, type SqlStatement } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { schemas } from "./schema.ts";
import {
	InvalidSchema,
	InvalidSchemaName,
	Schemas,
	SchemasLive,
	SchemaNameTaken,
	SchemaNotFound,
} from "./service.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const QUERY_SCHEMA = JSON.stringify({
	type: "object",
	properties: { q: { type: "string" } },
	required: ["q"],
});

describe("SchemasLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Schemas, never>;
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeTestD1());
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(SchemasLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Schemas>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (p: Schemas["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Schemas, f);

	const admin = <A, E>(f: (p: Schemas["Service"]) => Effect.Effect<A, E>) =>
		asUser("admin-1", call(f), "admin@x.com");

	const idByName = async (name: string) => {
		const rows = await db.select({ id: schemas.id }).from(schemas).where(eq(schemas.name, name));
		return rows[0]!.id;
	};

	it("adminCreate seeds the permissive {} schema and trims the name", async () => {
		const doc = await admin((p) => p.adminCreate({ name: "  query-params  " }));
		expect(doc).not.toBeNull();
		expect(doc!.name).toBe("query-params");
		expect(doc!.description).toBeNull();
		expect(doc!.schema).toBe("{}");
		expect(doc!.createdAt).toBeInstanceOf(Date);
		expect(doc!.updatedAt).toBeInstanceOf(Date);
	});

	it("adminCreate honors description and a supplied schema", async () => {
		const doc = await admin((p) =>
			p.adminCreate({ name: "search", description: "  Page params  ", schema: QUERY_SCHEMA }),
		);
		expect(doc!.description).toBe("Page params");
		expect(doc!.schema).toBe(QUERY_SCHEMA);
	});

	it("adminCreate stores a blank description as null", async () => {
		const doc = await admin((p) => p.adminCreate({ name: "blank-desc", description: "   " }));
		expect(doc!.description).toBeNull();
	});

	it("adminCreate rejects blank names, duplicate names and bad schemas", async () => {
		await expect(admin((p) => p.adminCreate({ name: "   " }))).rejects.toBeInstanceOf(
			InvalidSchemaName,
		);
		await expect(admin((p) => p.adminCreate({ name: "query-params" }))).rejects.toBeInstanceOf(
			SchemaNameTaken,
		);
		for (const bad of ["not json", "[]", '"x"', '{"type":"nonsense"}', '{"bogus":1}']) {
			await expect(
				admin((p) => p.adminCreate({ name: `bad-${bad.length}-${Math.random()}`, schema: bad })),
			).rejects.toBeInstanceOf(InvalidSchema);
		}
	});

	it("adminList returns metas ordered by updatedAt desc (no schema)", async () => {
		const first = await admin((p) => p.adminCreate({ name: "first" }));
		await sleep(5);
		const second = await admin((p) => p.adminCreate({ name: "second" }));
		const rows = await admin((p) => p.adminList());
		expect(rows.map((r) => r.id)).toContain(first!.id);
		expect(rows.map((r) => r.id)).toContain(second!.id);
		// Most recently updated first.
		expect(rows.findIndex((r) => r.id === second!.id)).toBeLessThan(
			rows.findIndex((r) => r.id === first!.id),
		);
		// Meta only — the schema payload never leaves the service layer.
		expect(rows[0]).not.toHaveProperty("schema");
	});

	it("adminGet returns the stored schema text; missing ids resolve null", async () => {
		const created = await admin((p) => p.adminCreate({ name: "get-me", schema: QUERY_SCHEMA }));
		const doc = await admin((p) => p.adminGet(created!.id));
		expect(doc).toMatchObject({ id: created!.id, name: "get-me" });
		expect(doc!.schema).toBe(QUERY_SCHEMA);
		await expect(admin((p) => p.adminGet(9999))).resolves.toBeNull();
	});

	it("adminUpdate patches name/description/schema and clears blank descriptions", async () => {
		const created = await admin((p) => p.adminCreate({ name: "before", description: "old" }));
		const updated = await admin((p) =>
			p.adminUpdate(created!.id, { name: "after", description: "new", schema: QUERY_SCHEMA }),
		);
		expect(updated.id).toBe(created!.id);
		expect(updated.name).toBe("after");
		expect(updated.description).toBe("new");
		expect(updated.schema).toBe(QUERY_SCHEMA);
		expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());

		// Blank description clears the column; untouched fields survive.
		const cleared = await admin((p) => p.adminUpdate(created!.id, { description: "  " }));
		expect(cleared.description).toBeNull();
		expect(cleared.name).toBe("after");
		expect(cleared.schema).toBe(QUERY_SCHEMA);

		// Empty update still bumps updatedAt.
		const bumped = await admin((p) => p.adminUpdate(created!.id, {}));
		expect(bumped.name).toBe("after");
	});

	it("adminUpdate rejects bad input and reports missing rows", async () => {
		const created = await admin((p) => p.adminCreate({ name: "guarded" }));
		await expect(admin((p) => p.adminUpdate(created!.id, { name: " " }))).rejects.toBeInstanceOf(
			InvalidSchemaName,
		);
		await expect(
			admin((p) => p.adminUpdate(created!.id, { schema: "nope" })),
		).rejects.toBeInstanceOf(InvalidSchema);
		// Renaming onto another row's name conflicts; keeping the row's
		// own name does not.
		await expect(
			admin((p) => p.adminUpdate(created!.id, { name: "query-params" })),
		).rejects.toBeInstanceOf(SchemaNameTaken);
		const same = await admin((p) => p.adminUpdate(created!.id, { name: "guarded" }));
		expect(same.name).toBe("guarded");
		await expect(admin((p) => p.adminUpdate(9999, { name: "ghost" }))).rejects.toBeInstanceOf(
			SchemaNotFound,
		);
	});

	it("adminRemove deletes and reports missing rows", async () => {
		const row = await admin((p) => p.adminCreate({ name: "doomed" }));
		await admin((p) => p.adminRemove(row!.id));
		await expect(admin((p) => p.adminRemove(row!.id))).rejects.toBeInstanceOf(SchemaNotFound);
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
				call((p) => p.adminGet(1)),
				"doc@x.com",
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
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
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				"u1",
				call((p) => p.adminRemove(1)),
				"doc@x.com",
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("getById is a public read returning the stored schema", async () => {
		const created = await admin((p) => p.adminCreate({ name: "public", schema: QUERY_SCHEMA }));
		const doc = await asUser(
			null,
			call((p) => p.getById(created!.id)),
		);
		expect(doc).toMatchObject({ id: created!.id, name: "public" });
		expect(doc!.schema).toBe(QUERY_SCHEMA);
		await expect(
			asUser(
				null,
				call((p) => p.getById(9999)),
			),
		).resolves.toBeNull();
	});

	it("validate reports valid data with no issues", async () => {
		const created = await admin((p) => p.adminCreate({ name: "v-ok", schema: QUERY_SCHEMA }));
		const res = await asUser(
			null,
			call((p) => p.validate(created!.id, { q: "hi" })),
		);
		expect(res).toEqual({ valid: true, issues: [] });
	});

	it("validate reports violations as sorted issues", async () => {
		const created = await admin((p) => p.adminCreate({ name: "v-bad", schema: QUERY_SCHEMA }));
		const res = await asUser(
			null,
			call((p) => p.validate(created!.id, {})),
		);
		expect(res.valid).toBe(false);
		expect(res.issues.length).toBeGreaterThan(0);
		expect(res.issues[0]).toMatchObject({ path: "$", keyword: "required" });
		const wrongType = await asUser(
			null,
			call((p) => p.validate(created!.id, "nope")),
		);
		expect(wrongType.valid).toBe(false);
	});

	it("validate resolves invalid:false for missing rows", async () => {
		const res = await asUser(
			null,
			call((p) => p.validate(9999, {})),
		);
		expect(res.valid).toBe(false);
		expect(res.issues[0]!.message).toContain("not found");
	});

	it("validate resolves invalid:false for malformed stored JSON", async () => {
		const now = new Date();
		await db.insert(schemas).values({
			name: "corrupt",
			schema: "{not json",
			createdAt: now,
			updatedAt: now,
		});
		const id = await idByName("corrupt");
		const res = await asUser(
			null,
			call((p) => p.validate(id, {})),
		);
		expect(res.valid).toBe(false);
		expect(res.issues[0]!.message).toContain("not valid JSON");
	});

	it("validate resolves invalid:false with definition issues for out-of-subset stored schemas", async () => {
		const now = new Date();
		await db.insert(schemas).values({
			name: "out-of-subset",
			schema: JSON.stringify({ type: "nonsense" }),
			createdAt: now,
			updatedAt: now,
		});
		const id = await idByName("out-of-subset");
		const res = await asUser(
			null,
			call((p) => p.validate(id, {})),
		);
		expect(res.valid).toBe(false);
		expect(res.issues.length).toBeGreaterThan(0);
		expect(res.issues[0]!.keyword).toBe("type");
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
		const rt = ManagedRuntime.make(SchemasLive.pipe(Layer.provide(deps)));
		try {
			const doc = await rt.runPromise(
				Effect.gen(function* () {
					const schemas = yield* Schemas;
					return yield* schemas.adminCreate({ name: "ghost" });
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
