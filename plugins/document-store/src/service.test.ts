import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { documentCollections, documentRecords } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { Tenant, TenantAccess, type Tenant as TenantValue } from "@ktb/tenant";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";

import {
	documentStoreOpDuration,
	documentStoreOps,
	documentStoreRows,
	tagged,
} from "@ktb/observability";

import { defineCollection } from "./collection.ts";
import { DocumentCollections } from "./collection.ts";
import { f } from "./fields.ts";
import { FIND_SCAN_MAX_ROWS } from "./query.ts";
import { Permissions, type PermissionsShape } from "@ktb/rbac";
import {
	BrokenReference,
	DocumentInUse,
	DocumentStore,
	DocumentStoreLive,
	DocumentValidationError,
	DuplicateFieldValue,
	DOCUMENT_STORE_TEST_DDL,
	InvalidDocumentQuery,
	type DocumentBatchResult,
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

// ---------- T-128: collection permissions + query guards ----------

/** Collection gated on every operation plus a field-level pair. */
const permThings = defineCollection({
	name: "test.permthings",
	fields: {
		title: f.string({ required: true }),
		secret: f.string(),
		count: f.number(),
		// Partial field rules: note is read-gated only, audit write-gated
		// only — exercises the per-op spec === undefined branches.
		note: f.string(),
		audit: f.string(),
	},
	permissions: {
		read: "docs.permthings.read",
		// ANY-of spec: "docs.permthings.admin" alone satisfies write.
		write: ["docs.permthings.write", "docs.permthings.admin"],
		delete: "docs.permthings.delete",
		fields: {
			secret: { read: "docs.permthings.secret.read", write: "docs.permthings.secret.write" },
			note: { read: "docs.permthings.note.read" },
			audit: { write: "docs.permthings.audit.write" },
		},
	},
});

/** Permissions block covering ONLY write — read/delete stay
 * fencing-only (spec === undefined branches). */
const writeOnly = defineCollection({
	name: "test.writeonly",
	fields: { v: f.string() },
	permissions: { write: "docs.writeonly.write" },
});

/** Oversized-payload target (json field — no length constraint). */
const bigDoc = defineCollection({
	name: "test.bigdoc",
	fields: { payload: f.json() },
});

/** Scan-cap target — bulk-filled directly via SQL in the test. */
const scanColl = defineCollection({
	name: "test.scan",
	fields: { v: f.number() },
});

const PERM_DEFS = [permThings, writeOnly, bigDoc, scanColl];

const ALL_GRANTS = [
	"docs.permthings.read",
	"docs.permthings.write",
	"docs.permthings.delete",
	"docs.permthings.secret.read",
	"docs.permthings.secret.write",
	"docs.permthings.note.read",
	"docs.permthings.audit.write",
	"docs.writeonly.write",
];

describe("DocumentStoreLive permissions + guards (T-128)", () => {
	let db: ReturnType<typeof makeDb>;
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore, never>;
	let runtimeNoPerms: ManagedRuntime.ManagedRuntime<DocumentStore, never>;
	const grants = new Set<string>();
	/** Tenant id the fake Permissions.can last observed (undefined =
	 * personal/global scope); "unset" until the first grant check. */
	let lastTenantId: unknown = "unset";

	const allowAll: PermissionsShape = {
		permissionsFor: () => Effect.succeed(new Map()),
		canFor: () => Effect.succeed(false),
		can: (resource, action, opts) => {
			lastTenantId = opts?.tenantId;
			return Effect.succeed(grants.has(`${resource}.${action}`));
		},
		requirePermissionFor: () => Effect.void,
		requirePermission: () => Effect.void,
		invalidate: () => Effect.void,
	};

	beforeAll(() => {
		db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: PERM_DEFS }),
			Layer.succeed(Permissions, allowAll),
		);
		runtime = ManagedRuntime.make(DocumentStoreLive.pipe(Layer.provide(deps)));
		// Same store WITHOUT the Permissions service — permissioned
		// collections must fail closed, permissionless unaffected.
		runtimeNoPerms = ManagedRuntime.make(
			DocumentStoreLive.pipe(
				Layer.provide(
					Layer.merge(
						Layer.succeed(Db, db),
						Layer.succeed(DocumentCollections, { collections: PERM_DEFS }),
					),
				),
			),
		);
	});

	afterAll(async () => {
		await runtime.dispose();
		await runtimeNoPerms.dispose();
	});

	const as = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, DocumentStore>,
		tenant?: TenantValue | null,
	) => {
		let eff = Effect.provideService(effect, Principal, userId === null ? null : { userId });
		if (tenant !== undefined) eff = Effect.provideService(eff, Tenant, tenant);
		return runtime.runPromise(eff);
	};

	const asNoPerms = <A, E>(userId: string, effect: Effect.Effect<A, E, DocumentStore>) =>
		runtimeNoPerms.runPromise(Effect.provideService(effect, Principal, { userId }));

	const call = <A, E>(f: (s: DocumentStore["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(DocumentStore, f);

	const tagOf = (p: Promise<unknown>) =>
		p.then(
			() => "ok",
			(e: unknown) => (e as { _tag?: string })._tag,
		);

	beforeEach(() => {
		grants.clear();
		lastTenantId = "unset";
	});

	it("denies every operation when no grants exist (fail closed)", async () => {
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.insert(permThings, { title: "x" })),
				),
			),
		).toBe("Forbidden");
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.get(permThings, 1)),
				),
			),
		).toBe("Forbidden");
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.find(permThings)),
				),
			),
		).toBe("Forbidden");
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.update(permThings, 1, { count: 1 })),
				),
			),
		).toBe("Forbidden");
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.delete(permThings, 1)),
				),
			),
		).toBe("Forbidden");
		// The Forbidden path names the collection + op.
		const err = await as(
			"u1",
			call((s) => s.find(permThings)),
		).then(
			() => null,
			(e: unknown) => e as { path?: string },
		);
		expect(err?.path).toBe("documents.test.permthings.read");
	});

	it("runs full CRUD when every grant is present", async () => {
		for (const g of ALL_GRANTS) grants.add(g);
		const rec = await as(
			"u1",
			call((s) => s.insert(permThings, { title: "t", secret: "s3cr3t", count: 1 })),
		);
		expect(rec.data.secret).toBe("s3cr3t");
		const got = await as(
			"u1",
			call((s) => s.get(permThings, rec.id)),
		);
		expect(got?.data.secret).toBe("s3cr3t");
		const page = await as(
			"u1",
			call((s) => s.find(permThings, { filter: { title: "t" } })),
		);
		expect(page.rows.some((r) => r.id === rec.id && r.data.secret === "s3cr3t")).toBe(true);
		const upd = await as(
			"u1",
			call((s) => s.update(permThings, rec.id, { count: 5 })),
		);
		expect(upd.data.count).toBe(5);
		await as(
			"u1",
			call((s) => s.delete(permThings, rec.id)),
		);
		expect(
			await as(
				"u1",
				call((s) => s.get(permThings, rec.id)),
			),
		).toBeNull();
	});

	it("ANY-of write spec: the admin alternative alone satisfies write", async () => {
		for (const g of [
			"docs.permthings.read",
			"docs.permthings.admin", // second array element, not .write
			"docs.permthings.delete",
			"docs.permthings.secret.read",
			"docs.permthings.secret.write",
		]) {
			grants.add(g);
		}
		const rec = await as(
			"u1",
			call((s) => s.insert(permThings, { title: "admin-path" })),
		);
		expect(rec.data.title).toBe("admin-path");
		const upd = await as(
			"u1",
			call((s) => s.update(permThings, rec.id, { count: 2 })),
		);
		expect(upd.data.count).toBe(2);
	});

	it("strips read-denied fields from get/find/insert/update results", async () => {
		// Everything EXCEPT secret.read — the stored value stays, the
		// wire view drops the key (whole-field deny, no masking).
		for (const g of [
			"docs.permthings.read",
			"docs.permthings.write",
			"docs.permthings.delete",
			"docs.permthings.secret.write",
		]) {
			grants.add(g);
		}
		const rec = await as(
			"u1",
			call((s) => s.insert(permThings, { title: "hideme", secret: "topsecret" })),
		);
		expect(rec.data.secret).toBeUndefined();
		expect(rec.data.title).toBe("hideme");
		const got = await as(
			"u1",
			call((s) => s.get(permThings, rec.id)),
		);
		expect(got?.data.secret).toBeUndefined();
		const page = await as(
			"u1",
			call((s) => s.find(permThings)),
		);
		const row = page.rows.find((r) => r.id === rec.id);
		expect(row?.data.secret).toBeUndefined();
		expect(row?.data.title).toBe("hideme");
		// The value is still STORED — an unscoped (admin) read sees it.
		const adminView = await as(
			"u1",
			call((s) => s.get(permThings, rec.id, { unscoped: true })),
		);
		expect(adminView?.data.secret).toBe("topsecret");
	});

	it("rejects writes touching write-denied fields", async () => {
		// secret.write absent — collection ops still allowed.
		for (const g of [
			"docs.permthings.read",
			"docs.permthings.write",
			"docs.permthings.delete",
			"docs.permthings.secret.read",
		]) {
			grants.add(g);
		}
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.insert(permThings, { title: "ok", secret: "nope" })),
				),
			),
		).toBe("Forbidden");
		// Untouched fields write fine.
		const rec = await as(
			"u1",
			call((s) => s.insert(permThings, { title: "clean" })),
		);
		expect(rec.data.title).toBe("clean");
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.update(permThings, rec.id, { secret: "x" })),
				),
			),
		).toBe("Forbidden");
		const upd = await as(
			"u1",
			call((s) => s.update(permThings, rec.id, { count: 9 })),
		);
		expect(upd.data.count).toBe(9);
	});

	it("unscoped system flows bypass collection AND field permissions", async () => {
		grants.clear(); // nothing granted at all
		const rec = await as(
			"u1",
			call((s) => s.insert(permThings, { title: "sys", secret: "raw" }, { unscoped: true })),
		);
		expect(rec.data.secret).toBe("raw"); // no read-strip either
		const got = await as(
			"u1",
			call((s) => s.get(permThings, rec.id, { unscoped: true })),
		);
		expect(got?.data.secret).toBe("raw");
		const upd = await as(
			"u1",
			call((s) => s.update(permThings, rec.id, { secret: "raw2" }, { unscoped: true })),
		);
		expect(upd.data.secret).toBe("raw2");
		const page = await as(
			"u1",
			call((s) => s.find(permThings, {}, { unscoped: true })),
		);
		expect(page.rows.some((r) => r.data.secret === "raw2")).toBe(true);
		await as(
			"u1",
			call((s) => s.delete(permThings, rec.id, { unscoped: true })),
		);
	});

	it("write-only permissions leave reads/deletes fencing-only", async () => {
		grants.add("docs.writeonly.write");
		// No read grant needed — read spec is undeclared.
		const rec = await as(
			"u1",
			call((s) => s.insert(writeOnly, { v: "x" })),
		);
		const got = await as(
			"u1",
			call((s) => s.get(writeOnly, rec.id)),
		);
		expect(got?.data.v).toBe("x");
		const page = await as(
			"u1",
			call((s) => s.find(writeOnly)),
		);
		expect(page.rows.some((r) => r.id === rec.id)).toBe(true);
		// Delete ungated too (no delete spec) — record disappears.
		await as(
			"u1",
			call((s) => s.delete(writeOnly, rec.id)),
		);
		expect(
			await as(
				"u1",
				call((s) => s.get(writeOnly, rec.id)),
			),
		).toBeNull();
		// …but writes still need the grant.
		grants.clear();
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.insert(writeOnly, { v: "y" })),
				),
			),
		).toBe("Forbidden");
	});

	it("absent Permissions service fails closed for permissioned defs only", async () => {
		// runtimeNoPerms has no Permissions in its environment.
		expect(
			await tagOf(
				asNoPerms(
					"u1",
					call((s) => s.insert(permThings, { title: "x" })),
				),
			),
		).toBe("Forbidden");
		expect(
			await tagOf(
				asNoPerms(
					"u1",
					call((s) => s.find(permThings)),
				),
			),
		).toBe("Forbidden");
		// Permissionless collections are unaffected (backward compat).
		const plain = await asNoPerms(
			"u1",
			call((s) => s.insert(things, { title: "noauthz-needed" })),
		);
		expect(plain.data.title).toBe("noauthz-needed");
	});

	it("passes the ambient tenant id to grant lookups (P-084)", async () => {
		for (const g of ALL_GRANTS) grants.add(g);
		await as(
			"u1",
			call((s) => s.insert(permThings, { title: "tenant-scoped" })),
			tenantA,
		);
		expect(lastTenantId).toBe(1);
		// Personal scope → undefined tenantId (global grants only).
		await as(
			"u1",
			call((s) => s.find(permThings)),
		);
		expect(lastTenantId).toBeUndefined();
	});

	it("rejects documents over MAX_DOCUMENT_BYTES on insert and update", async () => {
		const big = "x".repeat(70 * 1024);
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.insert(bigDoc, { payload: big })),
				),
			),
		).toBe("DocumentTooLarge");
		const small = await as(
			"u1",
			call((s) => s.insert(bigDoc, { payload: "tiny" })),
		);
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.update(bigDoc, small.id, { payload: big })),
				),
			),
		).toBe("DocumentTooLarge");
		// Under the cap still writes.
		const ok = await as(
			"u1",
			call((s) => s.insert(bigDoc, { payload: "y".repeat(1024) })),
		);
		expect(ok.id).toBeGreaterThan(0);
	});

	it("checks permissions per op inside a batch — denial rolls everything back", async () => {
		for (const g of ALL_GRANTS) grants.add(g);
		// secret.write denied: the second op fails planning, so the
		// permitted first insert must not commit either.
		grants.delete("docs.permthings.secret.write");
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{ op: "insert", collection: permThings, data: { title: "ok-op" } },
							{ op: "insert", collection: permThings, data: { title: "bad", secret: "x" } },
						]),
					),
				),
			),
		).toBe("Forbidden");
		const page = await as(
			"u1",
			call((s) => s.find(permThings, { filter: { title: "ok-op" } })),
		);
		expect(page.total).toBe(0);
		// delete permission is checked per op too.
		grants.delete("docs.permthings.delete");
		expect(
			await tagOf(
				as(
					"u1",
					call((s) => s.batch([{ op: "delete", collection: permThings, id: 1 }])),
				),
			),
		).toBe("Forbidden");
	});

	it("fails find when the visible slice exceeds the scan cap", async () => {
		// One service insert + FIND_SCAN_MAX_ROWS bulk rows.
		const first = await as(
			"u1",
			call((s) => s.insert(scanColl, { v: 0 })),
		);
		expect(first.id).toBeGreaterThan(0);
		const collectionId = first.collectionId;
		const now = new Date();
		const chunk = 1000;
		for (let base = 0; base < FIND_SCAN_MAX_ROWS; base += chunk) {
			await db.insert(documentRecords).values(
				Array.from({ length: chunk }, (_, i) => ({
					collectionId,
					data: JSON.stringify({ v: base + i }),
					ownerId: "u1",
					createdAt: now,
					updatedAt: now,
				})),
			);
		}
		const err = await as(
			"u1",
			call((s) => s.find(scanColl)),
		).then(
			() => null,
			(e: unknown) => e as { _tag?: string; issues?: string[] },
		);
		expect(err?._tag).toBe("InvalidDocumentQuery");
		expect(err?.issues?.[0]).toContain("scan cap");
	});
});

// ---------- T-126: multi-document batch ----------

const bTargets = defineCollection({
	name: "batch.targets",
	fields: {
		label: f.string({ required: true }),
		code: f.string({ unique: true }),
	},
});

const bThings = defineCollection({
	name: "batch.things",
	fields: {
		title: f.string({ required: true, maxLength: 20 }),
		count: f.number({ default: 0 }),
		target: f.ref({ collection: "batch.targets" }),
	},
});

const bCascade = defineCollection({
	name: "batch.cascade",
	fields: {
		t: f.ref({ collection: "batch.targets", onDelete: "cascade" }),
		t2: f.ref({ collection: "batch.targets", onDelete: "cascade" }),
		v: f.string(),
	},
});

const bNullify = defineCollection({
	name: "batch.nullify",
	fields: {
		t: f.ref({ collection: "batch.targets", onDelete: "nullify" }),
		t2: f.ref({ collection: "batch.targets", onDelete: "nullify" }),
		v: f.string({ required: true }),
	},
});

/** Required ref + nullify: a nullify patch fails re-validation, so the
 * policy skips the document (best-effort) instead of writing invalid. */
const bReqNull = defineCollection({
	name: "batch.reqnull",
	fields: {
		t: f.ref({ collection: "batch.targets", onDelete: "nullify" }, { required: true }),
		v: f.string(),
	},
});

const BATCH_DEFS = [bTargets, bThings, bCascade, bNullify, bReqNull];

describe("DocumentStoreLive batch (T-126)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore, never>;
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: BATCH_DEFS }),
		);
		runtime = ManagedRuntime.make(DocumentStoreLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const as = <A, E>(userId: string | null, effect: Effect.Effect<A, E, DocumentStore>) => {
		let eff = Effect.provideService(effect, Principal, userId === null ? null : { userId });
		return runtime.runPromise(eff);
	};

	const call = <A, E>(f: (s: DocumentStore["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(DocumentStore, f);

	const tagOf = (p: Promise<unknown>) =>
		p.then(
			() => "ok",
			(e: unknown) => (e as { _tag?: string })._tag,
		);

	it("runs mixed ops atomically and returns position-aligned results", async () => {
		// Pre-existing committed rows the batch will update/delete.
		const oldTarget = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "old", code: "old1" })),
		);
		const oldThing = await as(
			"u1",
			call((s) => s.insert(bThings, { title: "old-thing" })),
		);

		const results = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "insert", collection: bThings, data: { title: "b1" }, id: 910001 },
					{ op: "insert", collection: bTargets, data: { label: "BT", code: "bc1" }, id: 910002 },
					// Update merges over the pending insert above.
					{ op: "update", collection: bThings, id: 910001, data: { count: 7 } },
					// Ref resolves through the same-batch explicit-id insert.
					{ op: "insert", collection: bThings, data: { title: "linked", target: 910002 } },
					{ op: "update", collection: bTargets, id: oldTarget.id, data: { label: "renamed" } },
					{ op: "delete", collection: bThings, id: oldThing.id },
				]),
			),
		);
		expect(results).toHaveLength(6);
		expect(results[0]).toMatchObject({ op: "insert" });
		expect((results[0] as { record: { id: number } }).record.id).toBe(910001);
		const updRec = (results[2] as Extract<DocumentBatchResult, { op: "insert" | "update" }>).record;
		expect(updRec?.data).toEqual(expect.objectContaining({ title: "b1", count: 7 }));
		expect(results[5]).toEqual({ op: "delete" });

		// Persisted state reflects every op.
		const got = await as(
			"u1",
			call((s) => s.get(bThings, 910001)),
		);
		expect(got?.data).toEqual(expect.objectContaining({ title: "b1", count: 7 }));
		expect(got?.schemaVersion).toBe(1);
		const linked = await as(
			"u1",
			call((s) => s.find(bThings, { filter: { target: 910002 } })),
		);
		expect(linked.rows).toHaveLength(1);
		const renamed = await as(
			"u1",
			call((s) => s.get(bTargets, oldTarget.id)),
		);
		expect(renamed?.data.label).toBe("renamed");
		expect(
			await as(
				"u1",
				call((s) => s.get(bThings, oldThing.id)),
			),
		).toBeNull();
	});

	it("rolls the whole batch back when a later op fails validation", async () => {
		const before = await as(
			"u1",
			call((s) => s.find(bThings)),
		);
		const err = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "insert", collection: bThings, data: { title: "survivor?" }, id: 910010 },
					// Over maxLength — fails planning, nothing may commit.
					{ op: "insert", collection: bThings, data: { title: "x".repeat(30) } },
				]),
			),
		).then(
			() => null,
			(e: unknown) => e as { _tag?: string },
		);
		expect(err?._tag).toBe("DocumentValidationError");
		expect(
			await as(
				"u1",
				call((s) => s.get(bThings, 910010)),
			),
		).toBeNull();
		const after = await as(
			"u1",
			call((s) => s.find(bThings)),
		);
		expect(after.total).toBe(before.total);
	});

	it("rolls back when a mid-batch ref check fails", async () => {
		const err = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "insert", collection: bThings, data: { title: "doomed" }, id: 910011 },
					{ op: "insert", collection: bThings, data: { title: "bad-ref", target: 424242 } },
				]),
			),
		).then(
			() => null,
			(e: unknown) => e as { _tag?: string },
		);
		expect(err?._tag).toBe("BrokenReference");
		expect(
			await as(
				"u1",
				call((s) => s.get(bThings, 910011)),
			),
		).toBeNull();
	});

	it("enforces explicit-id conflicts inside the batch", async () => {
		const existing = await as(
			"u1",
			call((s) => s.insert(bThings, { title: "taken" })),
		);
		// Explicit id of a committed row → RecordIdConflict.
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([{ op: "insert", collection: bThings, data: { title: "x" }, id: existing.id }]),
					),
				),
			),
		).toBe("RecordIdConflict");
		// Two inserts claiming the same explicit id → second conflicts.
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{ op: "insert", collection: bThings, data: { title: "a" }, id: 910020 },
							{ op: "insert", collection: bThings, data: { title: "b" }, id: 910020 },
						]),
					),
				),
			),
		).toBe("RecordIdConflict");
		expect(
			await as(
				"u1",
				call((s) => s.get(bThings, 910020)),
			),
		).toBeNull();
		// Non-positive ids are validation errors.
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([{ op: "insert", collection: bThings, data: { title: "x" }, id: 0 }]),
					),
				),
			),
		).toBe("DocumentValidationError");
	});

	it("lets a later op reuse an id freed by an earlier delete", async () => {
		const old = await as(
			"u1",
			call((s) => s.insert(bThings, { title: "freed" })),
		);
		const results = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "delete", collection: bThings, id: old.id },
					{ op: "insert", collection: bThings, data: { title: "reborn", count: 3 }, id: old.id },
				]),
			),
		);
		expect(results[1]).toMatchObject({ op: "insert" });
		const got = await as(
			"u1",
			call((s) => s.get(bThings, old.id)),
		);
		expect(got?.data.title).toBe("reborn");
	});

	it("update and delete compose over pending writes", async () => {
		// insert → update merges into the SAME write; both ops report
		// the resulting record.
		const merged = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "insert", collection: bThings, data: { title: "pend" }, id: 910030 },
					{ op: "update", collection: bThings, id: 910030, data: { count: 9, title: "pend2" } },
				]),
			),
		);
		expect(merged[0]).toMatchObject({ op: "insert" });
		expect(merged[1]).toMatchObject({ op: "update" });
		const got = await as(
			"u1",
			call((s) => s.get(bThings, 910030)),
		);
		expect(got?.data).toEqual(expect.objectContaining({ title: "pend2", count: 9 }));

		// insert → delete: the write is dropped, both ops resolve.
		const dropped = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "insert", collection: bThings, data: { title: "ghost" }, id: 910031 },
					{ op: "delete", collection: bThings, id: 910031 },
				]),
			),
		);
		expect(dropped[0]).toEqual({ op: "insert", record: null });
		expect(dropped[1]).toEqual({ op: "delete" });
		expect(
			await as(
				"u1",
				call((s) => s.get(bThings, 910031)),
			),
		).toBeNull();

		// delete → update of the same committed row fails not-found.
		const victim = await as(
			"u1",
			call((s) => s.insert(bThings, { title: "victim" })),
		);
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{ op: "delete", collection: bThings, id: victim.id },
							{ op: "update", collection: bThings, id: victim.id, data: { count: 1 } },
						]),
					),
				),
			),
		).toBe("RecordNotFound");
		// The failed batch persisted nothing — the victim survives.
		expect(
			await as(
				"u1",
				call((s) => s.get(bThings, victim.id)),
			),
		).not.toBeNull();
	});

	it("enforces unique fields across pending writes in one batch", async () => {
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{ op: "insert", collection: bTargets, data: { label: "U", code: "dup1" } },
							{ op: "insert", collection: bTargets, data: { label: "U2", code: "dup1" } },
						]),
					),
				),
			),
		).toBe("DuplicateFieldValue");
		const page = await as(
			"u1",
			call((s) => s.find(bTargets, { filter: { code: "dup1" } })),
		);
		expect(page.total).toBe(0);
	});

	it("applies cascade/nullify/restrict atomically with the delete", async () => {
		// Seed one target per policy.
		const cTarget = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "C", code: "bc-c" })),
		);
		const cascRef = await as(
			"u1",
			call((s) => s.insert(bCascade, { t: cTarget.id, v: "keep?" })),
		);
		const nTarget = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "N", code: "bc-n" })),
		);
		const nullRef = await as(
			"u1",
			call((s) => s.insert(bNullify, { t: nTarget.id, v: "req" })),
		);
		const rTarget = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "R", code: "bc-r" })),
		);
		const restrRef = await as(
			"u1",
			call((s) => s.insert(bThings, { title: "holds", target: rTarget.id })),
		);

		// A failing op AFTER the delete rolls the cascade back too —
		// no orphans, no half-applied policies.
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{ op: "delete", collection: bTargets, id: cTarget.id },
							{ op: "insert", collection: bThings, data: { title: "x".repeat(30) } },
						]),
					),
				),
			),
		).toBe("DocumentValidationError");
		expect(
			await as(
				"u1",
				call((s) => s.get(bTargets, cTarget.id)),
			),
		).not.toBeNull();
		expect(
			await as(
				"u1",
				call((s) => s.get(bCascade, cascRef.id)),
			),
		).not.toBeNull();

		// Clean cascade delete: target AND referrer gone together.
		await as(
			"u1",
			call((s) => s.batch([{ op: "delete", collection: bTargets, id: cTarget.id }])),
		);
		expect(
			await as(
				"u1",
				call((s) => s.get(bTargets, cTarget.id)),
			),
		).toBeNull();
		expect(
			await as(
				"u1",
				call((s) => s.get(bCascade, cascRef.id)),
			),
		).toBeNull();

		// Nullify patches the referrer inside the same transaction.
		await as(
			"u1",
			call((s) => s.batch([{ op: "delete", collection: bTargets, id: nTarget.id }])),
		);
		const nullified = await as(
			"u1",
			call((s) => s.get(bNullify, nullRef.id)),
		);
		expect(nullified?.data.t).toBeNull();
		expect(nullified?.data.v).toBe("req");

		// Restrict still blocks — referencedBy names the batch-visible ref.
		const inUse = await as(
			"u1",
			call((s) => s.batch([{ op: "delete", collection: bTargets, id: rTarget.id }])),
		).then(
			() => null,
			(e: unknown) => e as { _tag?: string; referencedBy?: string[] },
		);
		expect(inUse?._tag).toBe("DocumentInUse");
		expect(inUse?.referencedBy).toContain("batch.things.target");
		// Clean up the restrict pair so later tests stay isolated.
		await as(
			"u1",
			call((s) => s.delete(bThings, restrRef.id)),
		);
		await as(
			"u1",
			call((s) => s.delete(bTargets, rTarget.id)),
		);
	});

	it("sees pending writes during ref-policy scans (cascade + nullify)", async () => {
		// Same-batch insert referenced by a cascade ref, then the target
		// is deleted — the pending ref write is dropped with it.
		const res = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "insert", collection: bTargets, data: { label: "P", code: "bc-p" }, id: 910040 },
					{ op: "insert", collection: bCascade, data: { t: 910040, v: "pend" }, id: 910041 },
					{ op: "delete", collection: bTargets, id: 910040 },
				]),
			),
		);
		expect(res[0]).toEqual({ op: "insert", record: null });
		expect(res[1]).toEqual({ op: "insert", record: null });
		expect(res[2]).toEqual({ op: "delete" });
		expect(
			await as(
				"u1",
				call((s) => s.get(bTargets, 910040)),
			),
		).toBeNull();
		expect(
			await as(
				"u1",
				call((s) => s.get(bCascade, 910041)),
			),
		).toBeNull();

		// Nullify patches the PENDING write's data (t → null) instead of
		// emitting a second write.
		const res2 = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "insert", collection: bTargets, data: { label: "P2", code: "bc-p2" }, id: 910042 },
					{ op: "insert", collection: bNullify, data: { t: 910042, v: "pend-n" }, id: 910043 },
					{ op: "delete", collection: bTargets, id: 910042 },
				]),
			),
		);
		const nullRec = (res2[1] as Extract<DocumentBatchResult, { op: "insert" | "update" }>).record;
		expect(nullRec?.data.t).toBeNull();
		const stored = await as(
			"u1",
			call((s) => s.get(bNullify, 910043)),
		);
		expect(stored?.data.t).toBeNull();

		// Restrict sees the pending ref and fails the whole batch —
		// the target insert rolls back with it.
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{
								op: "insert",
								collection: bTargets,
								data: { label: "P3", code: "bc-p3" },
								id: 910044,
							},
							{ op: "insert", collection: bThings, data: { title: "holds-p", target: 910044 } },
							{ op: "delete", collection: bTargets, id: 910044 },
						]),
					),
				),
			),
		).toBe("DocumentInUse");
		expect(
			await as(
				"u1",
				call((s) => s.get(bTargets, 910044)),
			),
		).toBeNull();
	});

	it("sees earlier deletes when checking refs and uniqueness", async () => {
		// Ref to a target deleted earlier in the same batch → broken.
		const doomed = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "doomed", code: "bc-doomed" })),
		);
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{ op: "delete", collection: bTargets, id: doomed.id },
							{ op: "insert", collection: bThings, data: { title: "late", target: doomed.id } },
						]),
					),
				),
			),
		).toBe("BrokenReference");

		// Unique value freed by an earlier delete is reusable.
		const freed = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "freed", code: "reuse-me" })),
		);
		const reused = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "delete", collection: bTargets, id: freed.id },
					{ op: "insert", collection: bTargets, data: { label: "new", code: "reuse-me" } },
				]),
			),
		);
		expect(reused[1]).toMatchObject({ op: "insert" });
		const page = await as(
			"u1",
			call((s) => s.find(bTargets, { filter: { code: "reuse-me" } })),
		);
		expect(page.total).toBe(1);
	});

	it("rejects a ref that resolves to a pending write of another collection", async () => {
		// The id exists in the plan, but under batch.things — a ref
		// field pointing at batch.targets must not resolve it.
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{ op: "insert", collection: bThings, data: { title: "wrong-coll" }, id: 910050 },
							{ op: "insert", collection: bCascade, data: { t: 910050 } },
						]),
					),
				),
			),
		).toBe("BrokenReference");
		expect(
			await as(
				"u1",
				call((s) => s.get(bThings, 910050)),
			),
		).toBeNull();
	});

	it("sees pending updates inside uniqueness buckets", async () => {
		const ct = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "CT", code: "ct-base" })),
		);
		// update → update merges; the second update's own uniqueness
		// check excludes itself. The trailing insert then collides
		// with the pending write's effective data.
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{ op: "update", collection: bTargets, id: ct.id, data: { code: "u-move" } },
							{ op: "update", collection: bTargets, id: ct.id, data: { code: "u-move2" } },
							{ op: "insert", collection: bTargets, data: { label: "X", code: "u-move2" } },
						]),
					),
				),
			),
		).toBe("DuplicateFieldValue");
		// Whole batch rolled back — the committed row keeps its code.
		const after = await as(
			"u1",
			call((s) => s.get(bTargets, ct.id)),
		);
		expect(after?.data.code).toBe("ct-base");
	});

	it("skips dropped and foreign-collection writes during uniqueness scans", async () => {
		const victim = await as(
			"u1",
			call((s) => s.insert(bThings, { title: "upd-me" })),
		);
		const results = await as(
			"u1",
			call((s) =>
				s.batch([
					// Pending insert later cascade-dropped by the delete.
					{ op: "insert", collection: bTargets, data: { label: "D", code: "bc-drop" }, id: 910080 },
					// Autoincrement pending insert (id null) — also dropped.
					{ op: "insert", collection: bCascade, data: { t: 910080 } },
					// A pending UPDATE — exercises the kind!==insert skip.
					{ op: "update", collection: bThings, id: victim.id, data: { count: 4 } },
					{ op: "delete", collection: bTargets, id: 910080 },
					// Later ops' uniqueness scans must skip the dropped
					// writes and the foreign-collection update above.
					{ op: "insert", collection: bThings, data: { title: "after" } },
					{ op: "insert", collection: bTargets, data: { label: "post" } },
				]),
			),
		);
		expect(results[0]).toEqual({ op: "insert", record: null });
		expect(results[1]).toEqual({ op: "insert", record: null });
		expect(results[3]).toEqual({ op: "delete" });
		expect(results[4]).toMatchObject({ op: "insert" });
		expect(results[5]).toMatchObject({ op: "insert" });
	});

	it("rejects updates that fail validation after merging into a pending write", async () => {
		expect(
			await tagOf(
				as(
					"u1",
					call((s) =>
						s.batch([
							{ op: "insert", collection: bThings, data: { title: "ok" }, id: 910070 },
							{ op: "update", collection: bThings, id: 910070, data: { title: "x".repeat(30) } },
						]),
					),
				),
			),
		).toBe("DocumentValidationError");
		expect(
			await as(
				"u1",
				call((s) => s.get(bThings, 910070)),
			),
		).toBeNull();
	});

	it("delete drops a pending update on the same committed row", async () => {
		const victim = await as(
			"u1",
			call((s) => s.insert(bThings, { title: "doomed-update" })),
		);
		const results = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "update", collection: bThings, id: victim.id, data: { count: 2 } },
					{ op: "delete", collection: bThings, id: victim.id },
				]),
			),
		);
		// The update's write is dropped — its op reports record: null.
		expect(results[0]).toEqual({ op: "update", record: null });
		expect(results[1]).toEqual({ op: "delete" });
		expect(
			await as(
				"u1",
				call((s) => s.get(bThings, victim.id)),
			),
		).toBeNull();
	});

	it("cascade and nullify compose across multiple fields and ops", async () => {
		// One doc referencing two targets through two cascade fields.
		const t1 = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "C1", code: "bc-c1" })),
		);
		const t2 = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "C2", code: "bc-c2" })),
		);
		const multi = await as(
			"u1",
			call((s) => s.insert(bCascade, { t: t1.id, t2: t2.id, v: "multi" })),
		);
		// Delete t1 first (cascade kills `multi`), then t2 — the second
		// delete's scan must skip the already-deleted referrer.
		await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "delete", collection: bTargets, id: t1.id },
					{ op: "delete", collection: bTargets, id: t2.id },
				]),
			),
		);
		expect(
			await as(
				"u1",
				call((s) => s.get(bCascade, multi.id)),
			),
		).toBeNull();

		// Two nullify fields on one doc, deleted in one batch — the
		// second patch merges over the first (both fields end null).
		const n1 = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "N1", code: "bc-n1" })),
		);
		const n2 = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "N2", code: "bc-n2" })),
		);
		const holder = await as(
			"u1",
			call((s) => s.insert(bNullify, { t: n1.id, t2: n2.id, v: "both" })),
		);
		await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "delete", collection: bTargets, id: n1.id },
					{ op: "delete", collection: bTargets, id: n2.id },
				]),
			),
		);
		const patched = await as(
			"u1",
			call((s) => s.get(bNullify, holder.id)),
		);
		expect(patched?.data.t).toBeNull();
		expect(patched?.data.t2).toBeNull();
		expect(patched?.data.v).toBe("both");
	});

	it("nullify patches pending updates and skips invalid documents", async () => {
		// Pending UPDATE on a committed nullify ref: the policy patches
		// the update's effective data (t → null) rather than the stored row.
		const nt = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "NP", code: "bc-np" })),
		);
		const holder = await as(
			"u1",
			call((s) => s.insert(bNullify, { t: nt.id, v: "orig" })),
		);
		await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "update", collection: bNullify, id: holder.id, data: { v: "changed" } },
					{ op: "delete", collection: bTargets, id: nt.id },
				]),
			),
		);
		const patched = await as(
			"u1",
			call((s) => s.get(bNullify, holder.id)),
		);
		expect(patched?.data.t).toBeNull();
		expect(patched?.data.v).toBe("changed");

		// Cascade through a pending update kills the committed row too.
		const ct = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "CP", code: "bc-cp" })),
		);
		const casc = await as(
			"u1",
			call((s) => s.insert(bCascade, { t: ct.id, v: "orig" })),
		);
		const res = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "update", collection: bCascade, id: casc.id, data: { v: "changed" } },
					{ op: "delete", collection: bTargets, id: ct.id },
				]),
			),
		);
		expect(res[0]).toEqual({ op: "update", record: null });
		expect(
			await as(
				"u1",
				call((s) => s.get(bCascade, casc.id)),
			),
		).toBeNull();

		// A stored row whose data fails re-validation is skipped by
		// nullify (best-effort), exactly like the sequential path.
		const st = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "SKIP", code: "bc-skip" })),
		);
		const skip = await as(
			"u1",
			call((s) => s.insert(bNullify, { t: st.id, v: "ok" })),
		);
		await db
			.update(documentRecords)
			.set({ data: JSON.stringify({ t: st.id, t2: null, v: 42 }) })
			.where(eq(documentRecords.id, skip.id));
		await as(
			"u1",
			call((s) => s.batch([{ op: "delete", collection: bTargets, id: st.id }])),
		);
		const skipped = await as(
			"u1",
			call((s) => s.get(bNullify, skip.id)),
		);
		expect(skipped?.data.t).toBe(st.id); // patch skipped — still dangling

		// Nullify on a pending insert patches its data in place — even a
		// `required` ref accepts null (null = unset is valid for refs).
		const rt = await as(
			"u1",
			call((s) => s.insert(bTargets, { label: "RQ", code: "bc-rq" })),
		);
		const res2 = await as(
			"u1",
			call((s) =>
				s.batch([
					{ op: "insert", collection: bReqNull, data: { t: rt.id, v: "x" } },
					{ op: "delete", collection: bTargets, id: rt.id },
				]),
			),
		);
		const kept = (res2[0] as Extract<DocumentBatchResult, { op: "insert" | "update" }>).record;
		expect(kept?.data.t).toBeNull();
	});

	it("empty batch is a no-op", async () => {
		const res = await as(
			"u1",
			call((s) => s.batch([])),
		);
		expect(res).toEqual([]);
	});
});

// ---------- T-130: schema versioning + migration hooks ----------

/** Version-3 def with a two-step chain: v1 docs gain `b`, then `b`
 * is bumped — exercises chained lazy migration end to end. */
const migGood = defineCollection({
	name: "test.miggood",
	version: 3,
	fields: {
		a: f.string({ required: true }),
		b: f.number(),
	},
	migrations: [
		{
			from: 1,
			to: 2,
			migrate: (doc) => ({ ...doc, b: typeof doc.a === "string" ? doc.a.length : 0 }),
		},
		{
			from: 2,
			to: 3,
			migrate: (doc) => ({ ...doc, b: (doc.b as number) + 10 }),
		},
	],
});

/** Version bump with a gap: v1→v2 exists but nothing covers v2→v3. */
const migGap = defineCollection({
	name: "test.miggap",
	version: 3,
	fields: { a: f.string() },
	migrations: [{ from: 1, to: 2, migrate: (doc) => doc }],
});

/** migrate() throws — typed failure, stored row untouched. */
const migThrow = defineCollection({
	name: "test.migthrw",
	version: 2,
	fields: { a: f.string() },
	migrations: [
		{
			from: 1,
			to: 2,
			migrate: () => {
				throw new Error("boom");
			},
		},
	],
});

/** migrate() returns a non-object. */
const migBadRet = defineCollection({
	name: "test.migbadret",
	version: 2,
	fields: { a: f.string() },
	migrations: [{ from: 1, to: 2, migrate: () => 42 as unknown as Record<string, unknown> }],
});

/** migrate() output fails current-field validation (drops required `a`). */
const migInvalid = defineCollection({
	name: "test.miginvalid",
	version: 2,
	fields: { a: f.string({ required: true }) },
	migrations: [{ from: 1, to: 2, migrate: () => ({}) }],
});

/** Version bump WITHOUT migrations — version stays advisory. */
const migNone = defineCollection({
	name: "test.mignone",
	version: 2,
	fields: { a: f.string() },
});

/** Explicit empty migrations array — the `length === 0` pass-through. */
const migEmpty = defineCollection({
	name: "test.migempty",
	version: 2,
	fields: { a: f.string() },
	migrations: [],
});

/** Contributed but never registered — sweep answers empty. */
const migLazy = defineCollection({
	name: "test.miglazy",
	version: 2,
	fields: { a: f.string() },
	migrations: [{ from: 1, to: 2, migrate: (doc) => doc }],
});

const MIG_DEFS = [migGood, migGap, migThrow, migBadRet, migInvalid, migNone, migEmpty, migLazy];

describe("DocumentStoreLive migrations (T-130)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore, never>;
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: MIG_DEFS }),
		);
		runtime = ManagedRuntime.make(DocumentStoreLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const as = <A, E>(userId: string | null, effect: Effect.Effect<A, E, DocumentStore>) => {
		let eff = Effect.provideService(effect, Principal, userId === null ? null : { userId });
		return runtime.runPromise(eff);
	};

	const call = <A, E>(f: (s: DocumentStore["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(DocumentStore, f);

	const collectionIdOf = async (name: string) => {
		const rows = await db
			.select()
			.from(documentCollections)
			.where(eq(documentCollections.name, name));
		return rows[0]!.id;
	};

	/** Insert a raw stored row — `schema_version` omitted so the
	 * column DEFAULT 1 models a pre-T-130 unversioned document. */
	const seedV1 = async (
		collection: string,
		data: unknown,
		ownerId = "u1",
		schemaVersion?: number,
	) => {
		const now = new Date();
		const rows = await db
			.insert(documentRecords)
			.values({
				collectionId: await collectionIdOf(collection),
				data: typeof data === "string" ? data : JSON.stringify(data),
				ownerId,
				...(schemaVersion === undefined ? {} : { schemaVersion }),
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return rows[0]!;
	};

	const storedRow = async (id: number) => {
		const rows = await db.select().from(documentRecords).where(eq(documentRecords.id, id));
		return rows[0]!;
	};

	beforeAll(async () => {
		// Register every contributed def EXCEPT migLazy (it must stay
		// unregistered for the empty-sweep test) so seedV1 resolves ids.
		await runtime.runPromise(
			call((s) =>
				Effect.forEach(
					MIG_DEFS.filter((d) => d !== migLazy),
					(d) => s.ensureCollection(d),
					{ discard: true },
				),
			),
		);
	});

	it("migrates lazily on get/find without rewriting the stored row", async () => {
		const row = await seedV1("test.miggood", { a: "hey" });
		const got = await as(
			"u1",
			call((s) => s.get(migGood, row.id)),
		);
		// 1→2 sets b=len("hey")=3; 2→3 adds 10 → 13.
		expect(got?.data).toEqual({ a: "hey", b: 13 });
		// schemaVersion still reports the STORED version.
		expect(got?.schemaVersion).toBe(1);
		// The stored payload is untouched — migration is read-time only.
		const stored = await storedRow(row.id);
		expect(stored.data).toBe(JSON.stringify({ a: "hey" }));
		expect(stored.schemaVersion).toBe(1);

		// find filters/sorts over migrated data too.
		const page = await as(
			"u1",
			call((s) => s.find(migGood, { filter: { b: 13 } })),
		);
		expect(page.rows.some((r) => r.id === row.id)).toBe(true);
	});

	it("update migrates first, then stamps the current version", async () => {
		const row = await seedV1("test.miggood", { a: "abc" });
		const updated = await as(
			"u1",
			call((s) => s.update(migGood, row.id, { a: "abcd" })),
		);
		// Migration ran on the STORED doc first (b = len("abc") + 10 =
		// 13), then the patch merged over it — `a` changed, `b` kept.
		expect(updated.data).toEqual({ a: "abcd", b: 13 });
		expect(updated.schemaVersion).toBe(3);
		const stored = await storedRow(row.id);
		expect(stored.schemaVersion).toBe(3);
		expect(JSON.parse(stored.data)).toEqual({ a: "abcd", b: 13 });
	});

	it("batch update migrates the same way", async () => {
		const row = await seedV1("test.miggood", { a: "zz" });
		const results = await as(
			"u1",
			call((s) => s.batch([{ op: "update", collection: migGood, id: row.id, data: {} }])),
		);
		const rec = (results[0] as Extract<DocumentBatchResult, { op: "insert" | "update" }>).record;
		expect(rec?.data.b).toBe(12); // len("zz")=2 → 2+10
		expect(rec?.schemaVersion).toBe(3);
	});

	it("migrateCollection sweeps every in-scope row and reports", async () => {
		await seedV1("test.miggood", { a: "one" });
		await seedV1("test.miggood", { a: "three!" });
		// A current-version row — scanned but not rewritten.
		const current = await as(
			"u1",
			call((s) => s.insert(migGood, { a: "now", b: 1 })),
		);
		const report = await as(
			"u1",
			call((s) => s.migrateCollection(migGood)),
		);
		expect(report.collection).toBe("test.miggood");
		expect(report.migrated).toBeGreaterThanOrEqual(2);
		expect(report.failed).toEqual([]);
		// Every miggood row is now at the def version.
		const rows = await db
			.select()
			.from(documentRecords)
			.where(eq(documentRecords.collectionId, await collectionIdOf("test.miggood")));
		expect(rows.every((r) => r.schemaVersion === 3)).toBe(true);
		expect(current.schemaVersion).toBe(3);
		// Idempotent: a second sweep migrates nothing.
		const again = await as(
			"u1",
			call((s) => s.migrateCollection("test.miggood")),
		);
		expect(again.migrated).toBe(0);
	});

	it("migrateCollection reports per-document failures and leaves them", async () => {
		const good = await seedV1("test.miggood", { a: "fine" });
		// Corrupt payload → parseData {} → migrated doc misses required `a`.
		const bad = await seedV1("test.miggood", "{corrupt");
		const report = await as(
			"u1",
			call((s) => s.migrateCollection("test.miggood")),
		);
		expect(report.failed.map((f) => f.id)).toContain(bad.id);
		expect(report.failed.find((f) => f.id === bad.id)?.reason).toContain(
			"migrated document invalid",
		);
		// Bad row untouched; good row migrated.
		const badStored = await storedRow(bad.id);
		expect(badStored.data).toBe("{corrupt");
		expect(badStored.schemaVersion).toBe(1);
		expect((await storedRow(good.id)).schemaVersion).toBe(3);
		// And the bad row surfaces the typed error on read.
		const err = await as(
			"u1",
			call((s) => s.get(migGood, bad.id)),
		).then(
			() => null,
			(e: unknown) => e as { _tag?: string; reason?: string },
		);
		expect(err?._tag).toBe("DocumentMigrationError");
		expect(err?.reason).toContain("migrated document invalid");
	});

	it("distinguishes every migration failure mode", async () => {
		// No covering path: v1→v2 exists, v2→v3 does not.
		const gap = await seedV1("test.miggap", { a: "x" });
		const gapErr = await as(
			"u1",
			call((s) => s.get(migGap, gap.id)),
		).then(
			() => null,
			(e: unknown) => e as { _tag?: string; reason?: string },
		);
		expect(gapErr?._tag).toBe("DocumentMigrationError");
		expect(gapErr?.reason).toContain("no migration path");

		// migrate() throws.
		const thr = await seedV1("test.migthrw", { a: "x" });
		const thrErr = await as(
			"u1",
			call((s) => s.get(migThrow, thr.id)),
		).then(
			() => null,
			(e: unknown) => e as { _tag?: string; reason?: string },
		);
		expect(thrErr?._tag).toBe("DocumentMigrationError");
		expect(thrErr?.reason).toContain("threw");

		// migrate() returns a non-object.
		const bad = await seedV1("test.migbadret", { a: "x" });
		const badErr = await as(
			"u1",
			call((s) => s.get(migBadRet, bad.id)),
		).then(
			() => null,
			(e: unknown) => e as { _tag?: string; reason?: string },
		);
		expect(badErr?._tag).toBe("DocumentMigrationError");
		expect(badErr?.reason).toContain("non-object");

		// Migrated doc fails current-field validation.
		const inv = await seedV1("test.miginvalid", { a: "x" });
		const invErr = await as(
			"u1",
			call((s) => s.get(migInvalid, inv.id)),
		).then(
			() => null,
			(e: unknown) => e as { _tag?: string; reason?: string },
		);
		expect(invErr?._tag).toBe("DocumentMigrationError");
		expect(invErr?.reason).toContain("migrated document invalid");

		// Every failure left the stored rows byte-identical.
		for (const [id, data] of [
			[gap.id, JSON.stringify({ a: "x" })],
			[thr.id, JSON.stringify({ a: "x" })],
			[bad.id, JSON.stringify({ a: "x" })],
			[inv.id, JSON.stringify({ a: "x" })],
		] as const) {
			const stored = await storedRow(id);
			expect(stored.data).toBe(data);
			expect(stored.schemaVersion).toBe(1);
		}
	});

	it("treats missing migrations and ahead-of-def versions as pass-through", async () => {
		// migNone bumped to v2 with NO migrations: a v1 row reads
		// exactly as stored — version stays advisory.
		const legacy = await seedV1("test.mignone", { a: "old" });
		const got = await as(
			"u1",
			call((s) => s.get(migNone, legacy.id)),
		);
		expect(got?.data).toEqual({ a: "old" });
		expect(got?.schemaVersion).toBe(1);

		// A stored version AHEAD of the def also passes through.
		const ahead = await seedV1("test.mignone", { a: "future" }, "u1", 9);
		const gotAhead = await as(
			"u1",
			call((s) => s.get(migNone, ahead.id)),
		);
		expect(gotAhead?.data).toEqual({ a: "future" });
		expect(gotAhead?.schemaVersion).toBe(9);

		// Explicit empty migrations array behaves the same.
		const empty = await seedV1("test.migempty", { a: "e" });
		const gotEmpty = await as(
			"u1",
			call((s) => s.get(migEmpty, empty.id)),
		);
		expect(gotEmpty?.data).toEqual({ a: "e" });
		expect(gotEmpty?.schemaVersion).toBe(1);

		// Sweep on a no-migration def: scanned, nothing rewritten.
		const report = await as(
			"u1",
			call((s) => s.migrateCollection("test.mignone")),
		);
		expect(report.scanned).toBeGreaterThanOrEqual(2);
		expect(report.migrated).toBe(0);
		expect(report.failed).toEqual([]);
	});

	it("migrateCollection handles unregistered and unknown collections", async () => {
		const empty = await as(
			"u1",
			call((s) => s.migrateCollection("test.miglazy")),
		);
		expect(empty).toEqual({
			collection: "test.miglazy",
			scanned: 0,
			migrated: 0,
			failed: [],
		});
		expect(
			await tagOf2(
				as(
					"u1",
					call((s) => s.migrateCollection("no.such")),
				),
			),
		).toBe("UnknownCollection");
	});
});

const tagOf2 = (p: Promise<unknown>) =>
	p.then(
		() => "ok",
		(e: unknown) => (e as { _tag?: string })._tag,
	);

describe("DocumentStoreLive telemetry (T-131)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore, never>;

	beforeAll(() => {
		const db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: DEFS }),
		);
		runtime = ManagedRuntime.make(DocumentStoreLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const call = <A, E>(f: (s: DocumentStore["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(DocumentStore, f);

	const asUser = <A, E>(userId: string, effect: Effect.Effect<A, E, DocumentStore>) =>
		Effect.provideService(effect, Principal, { userId });

	/** In-memory tracer — same shape as packages/observability sampler tests. */
	const makeTracer = () => {
		const spans: Tracer.NativeSpan[] = [];
		const tracer = Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options);
				spans.push(span);
				return span;
			},
		});
		return { tracer, spans };
	};

	// The metric registry is process-wide — assert deltas, not absolutes.
	const metricCount = <A, S>(metric: Metric.Metric<A, S>) =>
		Effect.runPromise(Metric.value(metric)).then((state) => {
			const count = (state as { count?: number | bigint }).count;
			return typeof count === "bigint" ? Number(count) : (count ?? 0);
		});
	const ops = (op: string, outcome: string) =>
		metricCount(tagged(documentStoreOps, { op, outcome }));
	const durationCount = (op: string) => metricCount(tagged(documentStoreOpDuration, { op }));
	const rows = (op: string, kind: string) => metricCount(tagged(documentStoreRows, { op, kind }));

	it("emits a documents.<method> span per call with bounded attributes", async () => {
		const { tracer, spans } = makeTracer();
		const traced = <A, E>(effect: Effect.Effect<A, E, DocumentStore>) =>
			runtime.runPromise(Effect.provideService(asUser("u1", effect), Tracer.Tracer, tracer));
		// Def ref (spanCollection's non-string branch) …
		await traced(call((s) => s.insert(things, { title: "telemetry" })));
		// … and a string ref for the find span.
		await traced(call((s) => s.find("test.things")));
		const names = spans.map((s) => s.name);
		expect(names).toContain("documents.insert");
		expect(names).toContain("documents.find");
		for (const s of spans) {
			expect(s.attributes.get("documents.collection")).toBe("test.things");
			// Document payloads, record ids and caller data never leak.
			for (const key of s.attributes.keys()) {
				expect(key === "documents.collection" || key === "documents.ops").toBe(true);
			}
		}
	});

	it("counts ops by outcome and records duration on success and failure", async () => {
		const [before, errBefore, durBefore] = await Promise.all([
			ops("insert", "success"),
			ops("insert", "error"),
			durationCount("insert"),
		]);
		await runtime.runPromise(
			asUser(
				"u1",
				call((s) => s.insert(things, { title: "ok" })),
			),
		);
		// Overlong title → DocumentValidationError → outcome=error.
		await runtime.runPromise(
			Effect.flip(
				asUser(
					"u1",
					call((s) => s.insert(things, { title: "x".repeat(30) })),
				),
			),
		);
		expect(await ops("insert", "success")).toBe(before + 1);
		expect(await ops("insert", "error")).toBe(errBefore + 1);
		expect(await durationCount("insert")).toBe(durBefore + 2);
	});

	it("counts find scan rows and batch ops", async () => {
		const scannedBefore = await rows("find", "scanned");
		const batchBefore = await rows("batch", "ops");
		const found = await runtime.runPromise(
			asUser(
				"u1",
				call((s) => s.find("test.things")),
			),
		);
		// Scanned = the whole visible slice; with no filter total === scanned.
		expect(await rows("find", "scanned")).toBe(scannedBefore + found.total);
		const results = await runtime.runPromise(
			asUser(
				"u1",
				call((s) =>
					s.batch([
						{ op: "insert", collection: "test.things", data: { title: "batch-a" } },
						{
							op: "delete",
							collection: "test.things",
							id: found.rows[0]!.id,
						},
					]),
				),
			),
		);
		expect(results).toHaveLength(2);
		expect(await rows("batch", "ops")).toBe(batchBefore + 2);
	});

	it("counts migration sweep rows and spans the sweep", async () => {
		const { tracer, spans } = makeTracer();
		const scannedBefore = await rows("migrateCollection", "scanned");
		const migratedBefore = await rows("migrateCollection", "migrated");
		const failedBefore = await rows("migrateCollection", "failed");
		await runtime.runPromise(
			Effect.provideService(
				asUser(
					"u1",
					call((s) => s.insert(v2, { a: "x" })),
				),
				Tracer.Tracer,
				tracer,
			),
		);
		const report = await runtime.runPromise(
			Effect.provideService(
				asUser(
					"u1",
					call((s) => s.migrateCollection("test.versioned")),
				),
				Tracer.Tracer,
				tracer,
			),
		);
		expect(report.scanned).toBe(1);
		expect(await rows("migrateCollection", "scanned")).toBe(scannedBefore + report.scanned);
		expect(await rows("migrateCollection", "migrated")).toBe(migratedBefore + report.migrated);
		expect(await rows("migrateCollection", "failed")).toBe(failedBefore + report.failed.length);
		expect(spans.map((s) => s.name)).toContain("documents.migrateCollection");
	});

	it("swallows metric-registry failures — ops still succeed", async () => {
		// A registry that throws on any access: recordSafe must keep the
		// write path alive (telemetry is best-effort, never fatal).
		const broken = new Proxy(new Map(), {
			get: () => {
				throw new Error("registry down");
			},
		});
		const rec = await runtime.runPromise(
			Effect.provideService(
				asUser(
					"u1",
					call((s) => s.insert(things, { title: "still works" })),
				),
				Metric.MetricRegistry,
				broken as never,
			),
		);
		expect(rec.data.title).toBe("still works");
	});
});
