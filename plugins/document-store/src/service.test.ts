import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { documentCollections, documentRecords } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { Tenant, TenantAccess, type Tenant as TenantValue } from "@ktb/tenant";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { defineCollection } from "./collection.ts";
import { DocumentCollections } from "./collection.ts";
import { f } from "./fields.ts";
import {
	BrokenReference,
	DocumentInUse,
	DocumentStore,
	DocumentStoreLive,
	DocumentValidationError,
	DuplicateFieldValue,
	DOCUMENT_STORE_TEST_DDL,
	InvalidDocumentQuery,
	RecordNotFound,
	UnknownCollection,
	type DocumentStoreError,
} from "./service.ts";

/** Minimal groups stub — document_records.tenant_id FKs to groups.id. */
const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
INSERT INTO groups (id, name) VALUES (1, 'clinic-a'), (2, 'clinic-b');
`;

const targets = defineCollection({
	name: "test.targets",
	fields: {
		label: f.string({ required: true }),
		code: f.string({ unique: true }),
	},
});

const things = defineCollection({
	name: "test.things",
	fields: {
		title: f.string({ required: true, maxLength: 20 }),
		count: f.number({ default: 0, min: 0 }),
		kind: f.enum(["a", "b"] as const),
		target: f.ref({ collection: "test.targets" }),
	},
});

const v1 = defineCollection({
	name: "test.versioned",
	version: 1,
	fields: { a: f.string() },
});
const v2 = defineCollection({
	name: "test.versioned",
	version: 2,
	fields: { a: f.string(), b: f.number() },
});
const v1Again = defineCollection({
	name: "test.versioned",
	version: 1,
	fields: { a: f.string(), stale: f.boolean() },
});

/** Contributed but never written — exercises the row === null paths. */
const lazy = defineCollection({
	name: "test.lazy",
	fields: { v: f.string() },
});

/** Refs with mixed onDelete policies + a dangling target collection. */
const pointer = defineCollection({
	name: "test.pointer",
	fields: {
		t: f.ref({ collection: "test.targets" }),
		gone: f.ref({ collection: "test.missing" }),
	},
});

/** Nullify target whose stored data can be corrupted to fail revalidation. */
const strictNullify = defineCollection({
	name: "test.strictnull",
	fields: {
		t: f.ref({ collection: "test.targets", onDelete: "nullify" }),
		v: f.string({ required: true }),
	},
});

/** Unique on a JSON value — exercises the structural compare branch. */
const uniqJson = defineCollection({
	name: "test.uniqjson",
	fields: { j: f.json({ unique: true }) },
});

/** Hand-written descriptor without onDelete — exercises the "restrict"
 * fallback for defs that bypass the f.ref builder. */
const rawRef = defineCollection({
	name: "test.rawref",
	fields: { t: { kind: "ref", collection: "test.targets" } as never },
});

const tenantA: TenantValue = { id: 1, kind: "clinic", slug: "a", role: "member" };
const tenantB: TenantValue = { id: 2, kind: "clinic", slug: "b", role: "member" };

const DEFS = [targets, things, v2, lazy, pointer, strictNullify, uniqJson, rawRef];

describe("DocumentStoreLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore, never>;
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: DEFS }),
		);
		runtime = ManagedRuntime.make(DocumentStoreLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const as = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, DocumentStore>,
		tenant?: TenantValue | null,
		access?: readonly (string | number)[],
	) => {
		let eff = Effect.provideService(effect, Principal, userId === null ? null : { userId });
		if (tenant !== undefined) eff = Effect.provideService(eff, Tenant, tenant);
		if (access !== undefined) eff = Effect.provideService(eff, TenantAccess, access);
		return runtime.runPromise(eff);
	};

	const call = <A, E>(f: (s: DocumentStore["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(DocumentStore, f);

	const failWith =
		<A>(tag: string) =>
		(effect: Effect.Effect<A, DocumentStoreError, DocumentStore>) =>
			runtime
				.runPromise(Effect.flip(Effect.provideService(effect, Principal, { userId: "u1" })))
				.then((e) => {
					expect((e as { _tag?: string })._tag).toBe(tag);
					return e;
				});

	it("ensureCollection inserts then no-ops on equal/older versions", async () => {
		const row = await runtime.runPromise(call((s) => s.ensureCollection(v1)));
		expect(row.name).toBe("test.versioned");
		expect(row.version).toBe(1);

		const bumped = await runtime.runPromise(call((s) => s.ensureCollection(v2)));
		expect(bumped.version).toBe(2);

		const again = await runtime.runPromise(call((s) => s.ensureCollection(v2)));
		expect(again.version).toBe(2);
		expect(again.id).toBe(bumped.id);

		// Older def does not downgrade.
		const stale = await runtime.runPromise(call((s) => s.ensureCollection(v1Again)));
		expect(stale.version).toBe(2);

		// A bump carrying an explicit owner rewrites owner_plugin_id.
		const owned = await runtime.runPromise(
			call((s) => s.ensureCollection({ ...v2, version: 3, owner: "plugin.x" })),
		);
		expect(owned.version).toBe(3);
		expect(owned.ownerPluginId).toBe("plugin.x");
	});

	it("insert validates, applies defaults and auto-registers", async () => {
		const rec = await as(
			"u1",
			call((s) => s.insert("test.things", { title: "hello" })),
		);
		expect(rec.data.title).toBe("hello");
		expect(rec.data.count).toBe(0); // default applied
		expect(rec.ownerId).toBe("u1");
		expect(rec.tenantId).toBeNull();
		expect(rec.collection).toBe("test.things");
	});

	it("insert rejects invalid data and unknown collections", async () => {
		await failWith("DocumentValidationError")(
			call((s) => s.insert(things, { title: "x".repeat(30) })),
		);
		await failWith("DocumentValidationError")(
			call((s) => s.insert(things, { title: "ok", kind: "z" as never })),
		);
		await failWith("UnknownCollection")(call((s) => s.insert("no.such", { title: "x" })));
	});

	it("get returns the record or null within scope", async () => {
		const rec = await as(
			"u1",
			call((s) => s.insert(things, { title: "get-me" })),
		);
		const got = await as(
			"u1",
			call((s) => s.get(things, rec.id)),
		);
		expect(got?.data.title).toBe("get-me");
		// Other owner cannot see it (personal row).
		const foreign = await as(
			"u2",
			call((s) => s.get(things, rec.id)),
		);
		expect(foreign).toBeNull();
		const missing = await as(
			"u1",
			call((s) => s.get(things, 99999)),
		);
		expect(missing).toBeNull();
	});

	it("find filters, sorts and paginates", async () => {
		await as(
			"u1",
			call((s) => s.insert(things, { title: "f1", count: 5, kind: "a" })),
		);
		await as(
			"u1",
			call((s) => s.insert(things, { title: "f2", count: 1, kind: "b" })),
		);
		await as(
			"u1",
			call((s) => s.insert(things, { title: "f3", count: 9 })),
		);

		const all = await as(
			"u1",
			call((s) => s.find(things)),
		);
		expect(all.total).toBeGreaterThanOrEqual(5); // includes earlier inserts

		const filtered = await as(
			"u1",
			call((s) => s.find(things, { filter: { count: { $gte: 5 } } })),
		);
		expect(filtered.rows.every((r) => (r.data.count ?? 0) >= 5)).toBe(true);

		const byKind = await as(
			"u1",
			call((s) => s.find(things, { filter: { kind: { $in: ["a", "b"] } } })),
		);
		expect(byKind.rows.length).toBeGreaterThanOrEqual(2);

		const sorted = await as(
			"u1",
			call((s) => s.find(things, { sort: [{ field: "count", dir: "desc" }], limit: 3 })),
		);
		expect(sorted.rows).toHaveLength(3);
		const counts = sorted.rows.map((r) => r.data.count ?? 0);
		expect([...counts].sort((a, b) => b - a)).toEqual(counts);

		const paged = await as(
			"u1",
			call((s) => s.find(things, { sort: "title", limit: 2, offset: 1 })),
		);
		expect(paged.rows).toHaveLength(2);
		expect(paged.total).toBe(all.total);

		await failWith("InvalidDocumentQuery")(
			call((s) => s.find(things, { filter: { count: { $bogus: 1 } } })),
		);
		// Malformed sorts are rejected up front (same typed error).
		await failWith("InvalidDocumentQuery")(
			call((s) => s.find(things, { sort: [{ field: "count", dir: "sideways" } as never] })),
		);
		await failWith("InvalidDocumentQuery")(call((s) => s.find(things, { sort: [5] as never })));
		// ReDoS-hardening: over-long / nested-quantifier patterns die
		// at validation, before any row is scanned.
		await failWith("InvalidDocumentQuery")(
			call((s) => s.find(things, { filter: { title: { $regex: "(a+)+" } } })),
		);
		await failWith("InvalidDocumentQuery")(
			call((s) => s.find(things, { filter: { title: { $regex: "x".repeat(201) } } })),
		);
	});

	it("find evaluates $regex through the precompiled path", async () => {
		await as(
			"u1",
			call((s) => s.insert(things, { title: "rx-alpha" })),
		);
		const page = await as(
			"u1",
			call((s) => s.find(things, { filter: { title: { $regex: "^rx-" } } })),
		);
		expect(page.rows.length).toBeGreaterThanOrEqual(1);
		expect(page.rows.every((r) => r.data.title?.startsWith("rx-"))).toBe(true);
	});

	it("update merges, revalidates and enforces unique", async () => {
		const t = await as(
			"u1",
			call((s) => s.insert(targets, { label: "T1", code: "c1" })),
		);
		const rec = await as(
			"u1",
			call((s) => s.insert(things, { title: "upd", target: t.id })),
		);
		const updated = await as(
			"u1",
			call((s) => s.update(things, rec.id, { count: 4 })),
		);
		expect(updated.data.count).toBe(4);
		expect(updated.data.title).toBe("upd");

		// unique violation on targets.code
		await as(
			"u1",
			call((s) => s.insert(targets, { label: "T2", code: "dup" })),
		);
		await failWith("DuplicateFieldValue")(call((s) => s.update(targets, t.id, { code: "dup" })));
		// same value on self is fine
		const same = await as(
			"u1",
			call((s) => s.update(targets, t.id, { code: "c1" })),
		);
		expect(same.data.code).toBe("c1");

		// broken ref on update
		await failWith("DocumentValidationError")(
			call((s) => s.update(things, rec.id, { title: "x".repeat(30) })),
		);
		await failWith("BrokenReference")(call((s) => s.update(things, rec.id, { target: 999999 })));
		await failWith("RecordNotFound")(call((s) => s.update(things, 999999, { count: 1 })));
		await failWith("RecordNotFound")(call((s) => s.delete(things, 999999)));
	});

	it("update rejects explicit undefined — no silent field deletes", async () => {
		const t = await as(
			"u1",
			call((s) => s.insert(targets, { label: "U", code: "u1" })),
		);
		// Required field: `{ label: undefined }` must not bypass required.
		await failWith("DocumentValidationError")(
			call((s) => s.update(targets, t.id, { label: undefined } as never)),
		);
		// Unique field: `{ code: undefined }` must not drop it from the
		// uniqueness check / delete the stored value.
		await failWith("DocumentValidationError")(
			call((s) => s.update(targets, t.id, { code: undefined } as never)),
		);
		// Optional field on things: same rejection.
		const rec = await as(
			"u1",
			call((s) => s.insert(things, { title: "undef", count: 3 })),
		);
		await failWith("DocumentValidationError")(
			call((s) => s.update(things, rec.id, { count: undefined } as never)),
		);
		// Stored values are untouched after the rejected patches.
		const after = await as(
			"u1",
			call((s) => s.get(targets, t.id)),
		);
		expect(after?.data.label).toBe("U");
		expect(after?.data.code).toBe("u1");
		// Absent keys still merge fine.
		const ok = await as(
			"u1",
			call((s) => s.update(things, rec.id, { kind: "a" })),
		);
		expect(ok.data.count).toBe(3);
		expect(ok.data.kind).toBe("a");
	});

	it("ref fields round-trip null (unset) on insert and update", async () => {
		const rec = await as(
			"u1",
			call((s) => s.insert(things, { title: "nullref", target: null })),
		);
		expect(rec.data.target).toBeNull();
		const t = await as(
			"u1",
			call((s) => s.insert(targets, { label: "NR", code: "nr1" })),
		);
		const linked = await as(
			"u1",
			call((s) => s.update(things, rec.id, { target: t.id })),
		);
		expect(linked.data.target).toBe(t.id);
		const unset = await as(
			"u1",
			call((s) => s.update(things, rec.id, { target: null })),
		);
		expect(unset.data.target).toBeNull();
	});

	it("ref on write requires an existing in-scope target", async () => {
		await failWith("BrokenReference")(
			call((s) => s.insert(things, { title: "bad-ref", target: 424242 })),
		);
		// A ref descriptor missing its target collection fails in
		// checkRefs (defense in depth — defineCollection callers always
		// set it via f.ref).
		const weird = defineCollection({
			name: "test.weird",
			fields: { r: { kind: "ref" } as never },
		});
		await failWith("DocumentValidationError")(call((s) => s.insert(weird, { r: 1 } as never)));
	});

	it("delete applies ref onDelete policies", async () => {
		// restrict (default): referencing record blocks the delete.
		const target = await as(
			"u1",
			call((s) => s.insert(targets, { label: "R", code: "r1" })),
		);
		const refRec = await as(
			"u1",
			call((s) => s.insert(things, { title: "ref", target: target.id })),
		);
		const err = await failWith("DocumentInUse")(call((s) => s.delete(targets, target.id)));
		expect((err as { referencedBy?: string[] }).referencedBy).toContain("test.things.target");

		// nullify policy.
		const nullifyDef = defineCollection({
			name: "test.nullify",
			fields: {
				t: f.ref({ collection: "test.targets", onDelete: "nullify" }),
			},
		});
		const nTarget = await as(
			"u1",
			call((s) => s.insert(targets, { label: "N", code: "n1" })),
		);
		await as(
			"u1",
			call((s) => s.insert(nullifyDef, { t: nTarget.id })),
		);
		await as(
			"u1",
			call((s) => s.delete(targets, nTarget.id)),
		);
		const nullified = await as(
			"u1",
			call((s) => s.find(nullifyDef)),
		);
		expect(nullified.rows[0]?.data.t).toBeNull();

		// cascade policy.
		const cascadeDef = defineCollection({
			name: "test.cascade",
			fields: {
				t: f.ref({ collection: "test.targets", onDelete: "cascade" }),
			},
		});
		const cTarget = await as(
			"u1",
			call((s) => s.insert(targets, { label: "C", code: "c1x" })),
		);
		const cascaded = await as(
			"u1",
			call((s) => s.insert(cascadeDef, { t: cTarget.id })),
		);
		await as(
			"u1",
			call((s) => s.delete(targets, cTarget.id)),
		);
		const after = await as(
			"u1",
			call((s) => s.find(cascadeDef)),
		);
		expect(after.rows.find((r) => r.id === cascaded.id)).toBeUndefined();

		// plain delete works once refs are gone.
		await as(
			"u1",
			call((s) => s.delete(things, refRec.id)),
		);
		await as(
			"u1",
			call((s) => s.delete(targets, target.id)),
		);
		const gone = await as(
			"u1",
			call((s) => s.get(targets, target.id)),
		);
		expect(gone).toBeNull();
	});

	it("tenant rows are visible to tenant members, fenced from others", async () => {
		const tDef = defineCollection({ name: "test.tenant", fields: { v: f.string() } });
		const row = await as(
			"doc-1",
			call((s) => s.insert(tDef, { v: "tenant-a" })),
			tenantA,
		);
		expect(row.tenantId).toBe(1);
		expect(row.ownerId).toBe("doc-1");

		// Same tenant, different user: sees the tenant row.
		const member = await as(
			"doc-2",
			call((s) => s.get(tDef, row.id)),
			tenantA,
		);
		expect(member?.data.v).toBe("tenant-a");

		// Other tenant: invisible.
		const outsider = await as(
			"doc-3",
			call((s) => s.get(tDef, row.id)),
			tenantB,
		);
		expect(outsider).toBeNull();

		// Personal scope: invisible (tenant row, not personal).
		const personal = await as(
			"doc-1",
			call((s) => s.get(tDef, row.id)),
		);
		expect(personal).toBeNull();

		// TenantAccess widening: system flow sees both tenants' rows.
		const wide = await as(
			"sys",
			call((s) => s.find(tDef)),
			null,
			[1, 2],
		);
		expect(wide.rows.some((r) => r.id === row.id)).toBe(true);
	});

	it("ctx.ownerId overrides the bound principal", async () => {
		const rec = await as(
			"u1",
			call((s) => s.insert(things, { title: "ctx" }, { ownerId: "other" })),
		);
		expect(rec.ownerId).toBe("other");
		// u1 cannot see a row owned by "other" (personal scope).
		const seen = await as(
			"u1",
			call((s) => s.get(things, rec.id)),
		);
		expect(seen).toBeNull();
		const seenByOther = await as(
			"other",
			call((s) => s.get(things, rec.id)),
		);
		expect(seenByOther?.data.title).toBe("ctx");
	});

	it("system context (null principal) writes ownerless rows invisible to users", async () => {
		const rec = await as(
			null,
			call((s) => s.insert(things, { title: "sys" })),
		);
		expect(rec.ownerId).toBe("");
		const seen = await as(
			"u1",
			call((s) => s.get(things, rec.id)),
		);
		expect(seen).toBeNull();
		const sysSeen = await as(
			null,
			call((s) => s.get(things, rec.id)),
		);
		expect(sysSeen?.data.title).toBe("sys");
	});

	it("contributed-but-unregistered defs read as empty and write as not-found", async () => {
		// `lazy` is contributed but has no document_collections row and
		// no records — reads answer empty, writes fail RecordNotFound
		// (insert is the only path that auto-registers).
		const page = await as(
			"u1",
			call((s) => s.find(lazy)),
		);
		expect(page).toEqual({ rows: [], total: 0 });
		const got = await as(
			"u1",
			call((s) => s.get(lazy, 1)),
		);
		expect(got).toBeNull();
		await failWith("RecordNotFound")(call((s) => s.update(lazy, 1, { v: "x" })));
		await failWith("RecordNotFound")(call((s) => s.delete(lazy, 1)));
	});

	it("resolves DB-registered collections by name (defFromRow)", async () => {
		// A collection row written outside the contributed registry —
		// e.g. by another host — resolves through schema_json.
		const orphan = defineCollection({
			name: "test.orphan",
			fields: { v: f.string({ required: true }) },
		});
		const now = new Date();
		await db.insert(documentCollections).values({
			name: orphan.name,
			ownerPluginId: "other.plugin",
			schemaJson: JSON.stringify(orphan),
			version: 1,
			createdAt: now,
			updatedAt: now,
		});
		const page = await as(
			"u1",
			call((s) => s.find("test.orphan")),
		);
		expect(page.total).toBe(0);
		// Second lookup hits the parsed-def cache.
		const again = await as(
			"u1",
			call((s) => s.find("test.orphan")),
		);
		expect(again.total).toBe(0);
		const rec = await as(
			"u1",
			call((s) => s.insert("test.orphan", { v: "hi" })),
		);
		expect(rec.data.v).toBe("hi");
		expect(rec.collection).toBe("test.orphan");
	});

	it("ctx without ownerId falls back to the bound principal", async () => {
		const rec = await as(
			"u1",
			call((s) => s.insert(things, { title: "ctx-empty" })),
		);
		const page = await as(
			"u1",
			call((s) => s.find(things, {}, {})),
		);
		expect(page.rows.some((r) => r.id === rec.id)).toBe(true);
		// ownerId: null normalizes to the ownerless "" bucket.
		const sys = await as(
			"u1",
			call((s) => s.insert(things, { title: "ctx-null" }, { ownerId: null })),
		);
		expect(sys.ownerId).toBe("");
	});

	it("unique fields: absent values skip, json compares structurally, tenants bucket separately", async () => {
		// Optional unique field absent → skipped, no false positive.
		const noCode = await as(
			"u1",
			call((s) => s.insert(targets, { label: "NoCode" })),
		);
		expect(noCode.data.code).toBeUndefined();

		// JSON unique: structural equality, not reference.
		await as(
			"u1",
			call((s) => s.insert(uniqJson, { j: { a: [1, 2] } })),
		);
		await as(
			"u1",
			call((s) => s.insert(uniqJson, { j: { a: [3] } })),
		);
		await failWith("DuplicateFieldValue")(call((s) => s.insert(uniqJson, { j: { a: [1, 2] } })));
		await as(
			"u1",
			call((s) => s.insert(uniqJson, { j: null })),
		);
		await failWith("DuplicateFieldValue")(call((s) => s.insert(uniqJson, { j: null })));

		// Tenant-scoped uniqueness buckets per tenant_id: same code in
		// the same tenant collides, in another tenant it does not.
		await as(
			"doc-1",
			call((s) => s.insert(targets, { label: "TA", code: "shared" })),
			tenantA,
		);
		const tagOf = (p: Promise<unknown>) =>
			p.then(
				() => "ok",
				(e: unknown) => (e as { _tag?: string })._tag,
			);
		expect(
			await tagOf(
				as(
					"doc-2",
					call((s) => s.insert(targets, { label: "TA2", code: "shared" })),
					tenantA,
				),
			),
		).toBe("DuplicateFieldValue");
		expect(
			await tagOf(
				as(
					"doc-1",
					call((s) => s.insert(targets, { label: "TB", code: "shared" })),
					tenantB,
				),
			),
		).toBe("ok");
	});

	it("tolerates corrupt stored payloads as empty data", async () => {
		const coll = await db
			.select()
			.from(documentCollections)
			.where(eq(documentCollections.name, "test.things"));
		const collectionId = coll[0]!.id;
		const now = new Date();
		const payloads = ["{oops", "[1,2]", "5", "null"];
		const ids: number[] = [];
		for (const data of payloads) {
			const rows = await db
				.insert(documentRecords)
				.values({ collectionId, data, ownerId: "u1", createdAt: now, updatedAt: now })
				.returning();
			ids.push(rows[0]!.id);
		}
		for (const id of ids) {
			const got = await as(
				"u1",
				call((s) => s.get(things, id)),
			);
			expect(got?.data).toEqual({});
		}
	});

	it("delete scans all contributed defs: default policy, dangling refs, invalid rows", async () => {
		// Default onDelete (restrict) via the pointer def.
		const pt = await as(
			"u1",
			call((s) => s.insert(targets, { label: "PT", code: "pt1" })),
		);
		const pref = await as(
			"u1",
			call((s) => s.insert(pointer, { t: pt.id })),
		);
		// rawRef.t has no onDelete → falls back to "restrict".
		await as(
			"u1",
			call((s) => s.insert(rawRef, { t: pt.id } as never)),
		);
		const err = await failWith("DocumentInUse")(call((s) => s.delete(targets, pt.id)));
		expect((err as { referencedBy?: string[] }).referencedBy).toContain("test.pointer.t");
		expect((err as { referencedBy?: string[] }).referencedBy).toContain("test.rawref.t");
		await as(
			"u1",
			call((s) => s.delete(pointer, pref.id)),
		);

		// A nullify target whose stored row fails revalidation is skipped.
		const st = await as(
			"u1",
			call((s) => s.insert(targets, { label: "ST", code: "st1" })),
		);
		const sn = await as(
			"u1",
			call((s) => s.insert(strictNullify, { t: st.id, v: "ok" })),
		);
		// Corrupt the stored payload so partial revalidation fails.
		await db
			.update(documentRecords)
			.set({ data: JSON.stringify({ t: st.id, v: 42 }) })
			.where(eq(documentRecords.id, sn.id));
		await as(
			"u1",
			call((s) => s.delete(targets, st.id)),
		);
		const after = await as(
			"u1",
			call((s) => s.find(strictNullify)),
		);
		const row = after.rows.find((r) => r.id === sn.id);
		expect(row?.data.t).toBe(st.id); // not nullified — write skipped
		expect(row?.data.v).toBe(42);
	});
});
