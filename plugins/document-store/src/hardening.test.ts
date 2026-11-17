import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { documentCollections } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { Tenant, type Tenant as TenantValue } from "@ktb/tenant";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { defineCollection } from "./collection.ts";
import { DocumentCollections } from "./collection.ts";
import { f } from "./fields.ts";
import {
	COLLECTION_CACHE_TTL_MS,
	DocumentIdempotencyConflict,
	DocumentStore,
	DocumentStoreLive,
	DocumentVersionConflict,
	DOCUMENT_STORE_TEST_DDL,
	MAX_COLLECTION_CACHE_ENTRIES,
	type DocumentBatchResult,
	type DocumentRecord,
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

const notes = defineCollection({
	name: "hard.notes",
	fields: {
		title: f.string({ required: true }),
		count: f.number({ default: 0 }),
	},
});

const targets = defineCollection({
	name: "hard.targets",
	fields: { label: f.string({ required: true }) },
});

/** Two ref fields to the SAME target collection — exercises the
 * batched existence check (one IN query per target, T-129). */
const multi = defineCollection({
	name: "hard.multi",
	fields: {
		name: f.string({ required: true }),
		t1: f.ref({ collection: "hard.targets" }),
		t2: f.ref({ collection: "hard.targets" }),
	},
});

/** First ref broken + second target collection unknown — pins error
 * precedence (first problem in field order wins). */
const precedence = defineCollection({
	name: "hard.precedence",
	fields: {
		a: f.ref({ collection: "hard.targets" }),
		b: f.ref({ collection: "hard.missing" }),
	},
});

/** nullify onDelete — the cascade rewrite bumps the row version. */
const nullified = defineCollection({
	name: "hard.nullified",
	fields: {
		t: f.ref({ collection: "hard.targets", onDelete: "nullify" }),
		v: f.string({ required: true }),
	},
});

const tenantA: TenantValue = { id: 1, kind: "clinic", slug: "a", role: "member" };

const DEFS = [notes, targets, multi, precedence, nullified];

describe("DocumentStore hardening (T-127/T-129)", () => {
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

	const as = <A, E>(effect: Effect.Effect<A, E, DocumentStore>, tenant?: TenantValue | null) => {
		const eff = tenant === undefined ? effect : Effect.provideService(effect, Tenant, tenant);
		return runtime.runPromise(eff);
	};

	const call = <A, E>(f: (s: DocumentStore["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(DocumentStore, f);

	const failWith =
		<A>(tag: string) =>
		(effect: Effect.Effect<A, DocumentStoreError, DocumentStore>) =>
			runtime.runPromise(Effect.flip(effect)).then((e) => {
				expect((e as { _tag?: string })._tag).toBe(tag);
				return e;
			});

	// ---------- T-127: row version / expectedVersion ----------

	it("returns version 1 on insert and bumps it on every update", async () => {
		const created = await as(call((s) => s.insert("hard.notes", { title: "v", count: 1 })));
		expect(created.version).toBe(1);
		const u1 = await as(call((s) => s.update("hard.notes", created.id, { count: 2 })));
		expect(u1.version).toBe(2);
		const u2 = await as(call((s) => s.update("hard.notes", created.id, { title: "v2" })));
		expect(u2.version).toBe(3);
		const got = await as(call((s) => s.get("hard.notes", created.id)));
		expect(got?.version).toBe(3);
		const found = await as(call((s) => s.find("hard.notes", { filter: { title: { $eq: "v2" } } })));
		expect(found.rows[0]?.version).toBe(3);
	});

	it("update expectedVersion guards with DocumentVersionConflict", async () => {
		const created = await as(call((s) => s.insert("hard.notes", { title: "cas" })));
		const ok = await as(
			call((s) =>
				s.update("hard.notes", created.id, { count: 5 }, undefined, { expectedVersion: 1 }),
			),
		);
		expect(ok.version).toBe(2);
		const conflict = (await failWith("DocumentVersionConflict")(
			call((s) =>
				s.update("hard.notes", created.id, { count: 6 }, undefined, { expectedVersion: 1 }),
			),
		)) as DocumentVersionConflict;
		expect(conflict.expectedVersion).toBe(1);
		expect(conflict.actualVersion).toBe(2);
		expect(conflict.collection).toBe("hard.notes");
		// Absent the guard, last-write-wins still applies.
		const lww = await as(call((s) => s.update("hard.notes", created.id, { count: 7 })));
		expect(lww.version).toBe(3);
	});

	it("rejects malformed expectedVersion values", async () => {
		const created = await as(call((s) => s.insert("hard.notes", { title: "bad-ev" })));
		for (const expectedVersion of [0, -2, 1.5, Number.NaN]) {
			await failWith("DocumentValidationError")(
				call((s) =>
					s.update("hard.notes", created.id, { count: 1 }, undefined, { expectedVersion }),
				),
			);
		}
	});

	it("expectedVersion on a missing record still fails RecordNotFound", async () => {
		await failWith("RecordNotFound")(
			call((s) => s.update("hard.notes", 999_999, { count: 1 }, undefined, { expectedVersion: 1 })),
		);
	});

	it("batch updates chain expectedVersion against planned versions", async () => {
		const created = await as(call((s) => s.insert("hard.notes", { title: "batch-cas", count: 0 })));
		const results = await as(
			call((s) =>
				s.batch([
					{
						op: "update",
						collection: "hard.notes",
						id: created.id,
						data: { count: 1 },
						expectedVersion: 1,
					},
					{
						op: "update",
						collection: "hard.notes",
						id: created.id,
						data: { count: 2 },
						// The first op plans version 2 — sequential guard.
						expectedVersion: 2,
					},
				]),
			),
		);
		expect(results[0]).toMatchObject({ op: "update" });
		expect(results[1]).toMatchObject({ op: "update" });
		const got = await as(call((s) => s.get("hard.notes", created.id)));
		// Two ops merged into ONE write → one version bump.
		expect(got?.version).toBe(2);
		expect(got?.data.count).toBe(2);
	});

	it("a stale batch expectedVersion aborts the whole batch", async () => {
		const a = await as(call((s) => s.insert("hard.notes", { title: "a", count: 0 })));
		const b = await as(call((s) => s.insert("hard.notes", { title: "b", count: 0 })));
		await failWith("DocumentVersionConflict")(
			call((s) =>
				s.batch([
					{ op: "update", collection: "hard.notes", id: a.id, data: { count: 1 } },
					{
						op: "update",
						collection: "hard.notes",
						id: b.id,
						data: { count: 1 },
						expectedVersion: 99,
					},
				]),
			),
		);
		const gotA = await as(call((s) => s.get("hard.notes", a.id)));
		expect(gotA?.version).toBe(1);
		expect(gotA?.data.count).toBe(0);
	});

	it("expectedVersion on a pending insert reads as version 1", async () => {
		const results = await as(
			call((s) =>
				s.batch([
					{
						op: "insert",
						collection: "hard.notes",
						id: 4242,
						data: { title: "pending", count: 0 },
					},
					{
						op: "update",
						collection: "hard.notes",
						id: 4242,
						data: { count: 3 },
						expectedVersion: 1,
					},
				]),
			),
		);
		expect(results[1]).toMatchObject({ op: "update" });
		const got = await as(call((s) => s.get("hard.notes", 4242)));
		expect(got?.version).toBe(1);
		expect(got?.data.count).toBe(3);
		await failWith("DocumentVersionConflict")(
			call((s) =>
				s.batch([
					{
						op: "insert",
						collection: "hard.notes",
						id: 4243,
						data: { title: "pending2", count: 0 },
					},
					{
						op: "update",
						collection: "hard.notes",
						id: 4243,
						data: { count: 1 },
						expectedVersion: 2,
					},
				]),
			),
		);
	});

	it("nullify cascades bump the rewritten row's version", async () => {
		const t = await as(call((s) => s.insert("hard.targets", { label: "t" })));
		const doc = await as(call((s) => s.insert("hard.nullified", { t: t.id, v: "keep" })));
		expect(doc.version).toBe(1);
		await as(call((s) => s.delete("hard.targets", t.id)));
		const got = await as(call((s) => s.get("hard.nullified", doc.id)));
		expect(got?.data.t).toBeNull();
		expect(got?.version).toBe(2);
	});

	// ---------- T-127: idempotent inserts ----------

	it("replays an insert on idempotencyKey hit instead of duplicating", async () => {
		const first = await as(
			call((s) =>
				s.insert("hard.notes", { title: "orig", count: 1 }, undefined, {
					idempotencyKey: "k-replay",
				}),
			),
		);
		// Retry with a DIFFERENT payload — the stored record wins.
		const replay = await as(
			call((s) =>
				s.insert("hard.notes", { title: "changed", count: 99 }, undefined, {
					idempotencyKey: "k-replay",
				}),
			),
		);
		expect(replay.id).toBe(first.id);
		expect(replay.data).toMatchObject({ title: "orig", count: 1 });
		expect(replay.version).toBe(1);
		// Exactly one record carries the key — unscoped find sees all.
		const all = await as(call((s) => s.find("hard.notes", {}, { unscoped: true })));
		expect(all.rows.filter((r) => r.id === first.id)).toHaveLength(1);
	});

	it("distinct keys and keyless inserts never collide", async () => {
		const k1 = await as(
			call((s) => s.insert("hard.notes", { title: "k1" }, undefined, { idempotencyKey: "k-a" })),
		);
		const k2 = await as(
			call((s) => s.insert("hard.notes", { title: "k2" }, undefined, { idempotencyKey: "k-b" })),
		);
		expect(k2.id).not.toBe(k1.id);
		// NULL keys are distinct in the unique index — many allowed.
		const n1 = await as(call((s) => s.insert("hard.notes", { title: "n1" })));
		const n2 = await as(call((s) => s.insert("hard.notes", { title: "n2" })));
		expect(n2.id).not.toBe(n1.id);
	});

	it("rejects malformed idempotencyKey values", async () => {
		for (const idempotencyKey of ["", "x".repeat(256), 42 as never, null as never]) {
			await failWith("DocumentValidationError")(
				call((s) => s.insert("hard.notes", { title: "bad-key" }, undefined, { idempotencyKey })),
			);
		}
	});

	it("keys are collection-global: cross-scope hits conflict, unscoped replays", async () => {
		const mine = await as(
			call((s) =>
				s.insert(
					"hard.notes",
					{ title: "mine" },
					{ ownerId: "owner-a" },
					{
						idempotencyKey: "shared-key",
					},
				),
			),
		);
		// Same key from another personal scope → typed conflict, no leak.
		const conflict = (await failWith("DocumentIdempotencyConflict")(
			call((s) =>
				s.insert(
					"hard.notes",
					{ title: "theirs" },
					{ ownerId: "owner-b" },
					{
						idempotencyKey: "shared-key",
					},
				),
			),
		)) as DocumentIdempotencyConflict;
		expect(conflict.idempotencyKey).toBe("shared-key");
		// Same scope replays.
		const replay = await as(
			call((s) =>
				s.insert(
					"hard.notes",
					{ title: "mine2" },
					{ ownerId: "owner-a" },
					{
						idempotencyKey: "shared-key",
					},
				),
			),
		);
		expect(replay.id).toBe(mine.id);
		// System/unscoped flow sees every slice → replays too.
		const admin = await as(
			call((s) =>
				s.insert(
					"hard.notes",
					{ title: "admin" },
					{ unscoped: true },
					{
						idempotencyKey: "shared-key",
					},
				),
			),
		);
		expect(admin.id).toBe(mine.id);
		// Tenant members share the tenant slice — replay works there too.
		const t1 = await as(
			call((s) =>
				s.insert("hard.notes", { title: "tenant" }, undefined, { idempotencyKey: "tenant-key" }),
			),
			tenantA,
		);
		const t2 = await as(
			call((s) =>
				s.insert("hard.notes", { title: "tenant2" }, undefined, { idempotencyKey: "tenant-key" }),
			),
			tenantA,
		);
		expect(t2.id).toBe(t1.id);
		expect(t1.tenantId).toBe(1);
	});

	it("batch inserts dedupe against committed rows and each other", async () => {
		const seed = await as(
			call((s) => s.insert("hard.notes", { title: "seed" }, undefined, { idempotencyKey: "bk-1" })),
		);
		// Committed hit inside a batch → replay outcome, no write.
		const results = await as(
			call((s) =>
				s.batch([
					{
						op: "insert",
						collection: "hard.notes",
						data: { title: "ignored" },
						idempotencyKey: "bk-1",
					},
					{
						op: "insert",
						collection: "hard.notes",
						data: { title: "fresh" },
						idempotencyKey: "bk-2",
					},
				]),
			),
		);
		expect(results[0]).toMatchObject({ op: "insert" });
		expect((results[0] as { record: { id: number } }).record.id).toBe(seed.id);
		expect((results[1] as { record: { id: number } }).record.id).not.toBe(seed.id);
		// Two pending inserts sharing a key → conflict, batch aborts.
		await failWith("DocumentIdempotencyConflict")(
			call((s) =>
				s.batch([
					{
						op: "insert",
						collection: "hard.notes",
						data: { title: "p1" },
						idempotencyKey: "bk-dupe",
					},
					{
						op: "insert",
						collection: "hard.notes",
						data: { title: "p2" },
						idempotencyKey: "bk-dupe",
					},
				]),
			),
		);
		// Same key in DIFFERENT collections is fine.
		const cross = await as(
			call((s) =>
				s.batch([
					{
						op: "insert",
						collection: "hard.notes",
						data: { title: "c1" },
						idempotencyKey: "bk-cross",
					},
					{
						op: "insert",
						collection: "hard.targets",
						data: { label: "c2" },
						idempotencyKey: "bk-cross",
					},
				]),
			),
		);
		expect(cross).toHaveLength(2);
	});

	it("a same-batch delete frees the idempotency key for reuse", async () => {
		const results = await as(
			call((s) =>
				s.batch([
					{
						op: "insert",
						collection: "hard.notes",
						id: 4300,
						data: { title: "doomed", count: 0 },
						idempotencyKey: "bk-reuse",
					},
					{ op: "delete", collection: "hard.notes", id: 4300 },
					{
						op: "insert",
						collection: "hard.notes",
						id: 4301,
						data: { title: "reborn", count: 0 },
						idempotencyKey: "bk-reuse",
					},
				]),
			),
		);
		expect(results[0]).toMatchObject({ op: "insert", record: null });
		expect(results[2]).toMatchObject({ op: "insert" });
		const got = await as(call((s) => s.get("hard.notes", 4301)));
		expect(got?.data.title).toBe("reborn");
	});

	it("a committed row deleted earlier in the batch frees its key", async () => {
		const doomed = await as(
			call((s) =>
				s.insert("hard.notes", { title: "gone" }, undefined, { idempotencyKey: "bk-gone" }),
			),
		);
		const results = await as(
			call((s) =>
				s.batch([
					{ op: "delete", collection: "hard.notes", id: doomed.id },
					{
						op: "insert",
						collection: "hard.notes",
						data: { title: "again" },
						idempotencyKey: "bk-gone",
					},
				]),
			),
		);
		const rec = (results[1] as Extract<DocumentBatchResult, { op: "insert" | "update" }>)
			.record as DocumentRecord;
		expect(rec.id).not.toBe(doomed.id);
		expect(rec.data).toMatchObject({ title: "again" });
	});

	// ---------- T-129: batched ref validation ----------

	it("checks multiple refs to one target collection correctly", async () => {
		const t = await as(call((s) => s.insert("hard.targets", { label: "ok" })));
		const doc = await as(call((s) => s.insert("hard.multi", { name: "m", t1: t.id, t2: t.id })));
		expect(doc.data).toMatchObject({ t1: t.id, t2: t.id });
		const broken = (await failWith("BrokenReference")(
			call((s) => s.insert("hard.multi", { name: "m2", t1: t.id, t2: 999_999 })),
		)) as { field: string };
		expect(broken.field).toBe("t2");
	});

	it("preserves first-problem-in-field-order error precedence", async () => {
		// a's target is missing (broken ref), b's collection is unknown —
		// the earlier field's BrokenReference must win over the later
		// UnknownCollection.
		const err = await failWith("BrokenReference")(
			call((s) => s.insert("hard.precedence", { a: 999_999, b: 1 })),
		);
		expect((err as { field: string }).field).toBe("a");
		// With `a` satisfied, the unknown target collection surfaces.
		const t = await as(call((s) => s.insert("hard.targets", { label: "p" })));
		await failWith("UnknownCollection")(
			call((s) => s.insert("hard.precedence", { a: t.id, b: 1 })),
		);
	});

	// ---------- T-129: per-isolate collection cache ----------

	/** DB-only collection (never contributed): exercises the
	 * schema_json → def cache path. The v2 def bumps `version` so
	 * `ensureCollection` actually upserts (highest version wins). */
	const dbOnlyV1 = defineCollection({
		name: "hard.dbonly",
		version: 1,
		fields: { a: f.string() },
	});
	const dbOnlyV2 = defineCollection({
		name: "hard.dbonly",
		version: 2,
		fields: { b: f.number() },
	});
	const dbOnly2V1 = defineCollection({
		name: "hard.dbonly2",
		version: 1,
		fields: { a: f.string() },
	});
	const dbOnly2V2 = defineCollection({
		name: "hard.dbonly2",
		version: 2,
		fields: { b: f.number() },
	});

	const rewriteSchemaJson = (name: string, def: unknown) =>
		Effect.promise(() =>
			db
				.update(documentCollections)
				.set({ schemaJson: JSON.stringify(def) })
				.where(eq(documentCollections.name, name)),
		);

	it("serves cached defs within TTL and refetches after expiry", async () => {
		await as(call((s) => s.ensureCollection(dbOnlyV1)));
		// Bypass the service: rewrite schema_json directly (simulates
		// another isolate registering a newer def).
		await as(call(() => rewriteSchemaJson("hard.dbonly", dbOnlyV2)));
		// Within TTL the cached row+def still apply: `b` is an unknown
		// key under v1's field map.
		await failWith("DocumentValidationError")(call((s) => s.insert("hard.dbonly", { b: 1 })));
		// Past the TTL the row is refetched and the def re-parsed.
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + COLLECTION_CACHE_TTL_MS + 1);
		try {
			const created = await as(call((s) => s.insert("hard.dbonly", { b: 2 })));
			expect(created.data).toMatchObject({ b: 2 });
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("ensureCollection refreshes the cache immediately", async () => {
		await as(call((s) => s.ensureCollection(dbOnly2V1)));
		await as(call((s) => s.ensureCollection(dbOnly2V2)));
		// No TTL wait — the upsert invalidated the cached def.
		const created = await as(call((s) => s.insert("hard.dbonly2", { b: 3 })));
		expect(created.data).toMatchObject({ b: 3 });
	});

	it("evicts the oldest collection caches beyond MAX_COLLECTION_CACHE_ENTRIES", async () => {
		// The FIRST registered collection is the eviction victim.
		const victim = defineCollection({
			name: "hard.evict-victim",
			fields: { a: f.string() },
		});
		const victimV2 = defineCollection({
			name: "hard.evict-victim",
			fields: { b: f.number() },
		});
		await as(call((s) => s.ensureCollection(victim)));
		for (let i = 0; i < MAX_COLLECTION_CACHE_ENTRIES; i++) {
			await as(
				call((s) =>
					s.ensureCollection(
						defineCollection({
							name: `hard.evict-${i}`,
							fields: { v: f.string() },
						}),
					),
				),
			);
		}
		// Rewrite the victim's schema_json behind the service's back —
		// with NO time advance. If the victim's cache entries were
		// evicted, the next op refetches and sees v2; otherwise v1.
		await as(call(() => rewriteSchemaJson("hard.evict-victim", victimV2)));
		const created = await as(call((s) => s.insert("hard.evict-victim", { b: 7 })));
		expect(created.data).toMatchObject({ b: 7 });
		// A recently-registered collection is still cached: same trick
		// on the LAST evict-N def stays invisible until TTL expiry.
		const recent = defineCollection({
			name: "hard.evict-recent",
			fields: { a: f.string() },
		});
		const recentV2 = defineCollection({
			name: "hard.evict-recent",
			fields: { b: f.number() },
		});
		await as(call((s) => s.ensureCollection(recent)));
		await as(call(() => rewriteSchemaJson("hard.evict-recent", recentV2)));
		await failWith("DocumentValidationError")(call((s) => s.insert("hard.evict-recent", { b: 1 })));
	});
});
