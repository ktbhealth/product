import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { documentCollections, documentRecords } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { defineCollection } from "./collection.ts";
import { DocumentCollections } from "./collection.ts";
import { f } from "./fields.ts";
import { matchFilter, type DocumentFilter } from "./query.ts";
import { compileFilterPrefilter } from "./sqlfilter.ts";
import { DocumentStore, DocumentStoreLive, DOCUMENT_STORE_TEST_DDL } from "./service.ts";

/**
 * SQL pushdown tests (T-149): compileFilterPrefilter unit coverage
 * plus an end-to-end equivalence matrix — `find` results must equal
 * `matchFilter` applied to the same stored documents, since the SQL
 * fragment is only a superset prefilter and the JS matcher remains
 * the semantic source of truth.
 */

const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
`;

const sqldocs = defineCollection({
	name: "test.sqldocs",
	fields: { v: f.json() },
});

/** Def WITH migrations — pushdown must be skipped (stored data ≠
 * migrated data), results still correct via the pure-JS path. */
const migrated = defineCollection({
	name: "test.migrated",
	version: 2,
	fields: { v: f.json() },
	migrations: [
		{
			from: 1,
			to: 2,
			// Bumps v.n so a filter on the MIGRATED value differs from
			// the STORED one — proves find() filters post-migration
			// data (i.e. pushdown was skipped).
			migrate: (doc) => ({
				...doc,
				v: { ...(doc.v as Record<string, unknown>), n: 10 },
			}),
		},
	],
});

describe("compileFilterPrefilter", () => {
	const pushed = (filter: DocumentFilter) => compileFilterPrefilter(filter) !== undefined;
	const notPushed = (filter: DocumentFilter) => compileFilterPrefilter(filter) === undefined;

	it("returns undefined for absent/unconstraining filters", () => {
		expect(compileFilterPrefilter(undefined)).toBeUndefined();
		expect(notPushed({})).toBe(true);
		expect(notPushed({ $and: [] })).toBe(true); // every() over [] → true
		expect(notPushed({ $and: [5 as never] })).toBe(true); // non-object sub-filter matches all
		expect(notPushed({ $or: [{ title: { $regex: "x" } }] })).toBe(true); // unconstrained branch
	});

	it("pushes scalar equality and literals", () => {
		expect(pushed({ a: 1 })).toBe(true);
		expect(pushed({ a: "x" })).toBe(true);
		expect(pushed({ a: true })).toBe(true);
		expect(pushed({ a: null })).toBe(true);
		expect(pushed({ a: { $eq: 2 } })).toBe(true);
		expect(pushed({ a: { $eq: undefined } })).toBe(true);
		expect(pushed({ "a.b_c": 1 })).toBe(true);
	});

	it("keeps deep/ambiguous conditions JS-side", () => {
		expect(notPushed({ a: { $eq: { x: 1 } } })).toBe(true); // object literal
		expect(notPushed({ a: { $eq: [1] } })).toBe(true); // array literal
		expect(notPushed({ a: { x: 1 } })).toBe(true); // literal object condition → deep jsonEqual
		expect(notPushed({ a: [1, 2] })).toBe(true); // literal array condition → deep jsonEqual
		expect(notPushed({ a: { $eq: Number.NaN } })).toBe(true);
		expect(notPushed({ a: { $eq: Number.POSITIVE_INFINITY } })).toBe(true);
		expect(notPushed({ a: { $regex: "^x" } })).toBe(true);
		expect(notPushed({ a: { $gt: "5" } })).toBe(true); // string range operand
		expect(notPushed({ a: { $gt: Number.NaN } })).toBe(true);
		expect(notPushed({ a: { $in: [1, { x: 1 }] } })).toBe(true); // inexpressible element
		expect(notPushed({ a: { $nin: [1, [2]] } })).toBe(true);
		expect(notPushed({ a: { $nin: "x" as never } })).toBe(true); // non-array operand
		expect(notPushed({ a: { $in: "x" as never } })).toBe(true);
		expect(notPushed({ a: { $exists: "yes" as never } })).toBe(true);
		expect(notPushed({ a: { $unknown: 1 } })).toBe(true); // unknown op → vacuous JS-side
		expect(notPushed({ "a.0": 1 })).toBe(true); // numeric segment → JS array-index semantics
		expect(notPushed({ "a-b": 1 })).toBe(true); // non-identifier segment
		expect(notPushed({ constructor: 1 })).toBe(true); // prototype-chain key
		expect(notPushed({ "__proto__.x": 1 })).toBe(true);
		expect(notPushed({ a: { $ne: { x: 1 } } })).toBe(true);
		expect(notPushed({ a: { $ne: Number.NaN } })).toBe(true);
	});

	it("pushes ranges, $in/$nin and $exists", () => {
		for (const op of ["$gt", "$gte", "$lt", "$lte"] as const) {
			expect(pushed({ a: { [op]: 5 } })).toBe(true);
		}
		expect(pushed({ a: { $in: [1, "x", true, null] } })).toBe(true);
		expect(pushed({ a: { $in: [] } })).toBe(true); // never matches → 0=1
		expect(pushed({ a: { $nin: [1, "x"] } })).toBe(true);
		expect(notPushed({ a: { $nin: [] } })).toBe(true); // vacuous → no constraint
		expect(pushed({ a: { $exists: true } })).toBe(true);
		expect(pushed({ a: { $exists: false } })).toBe(true);
	});

	it("combines $and/$or structurally", () => {
		expect(
			pushed({
				$and: [{ a: 1 }, { b: { $gt: 2 } }],
				$or: [{ c: "x" }, { d: { $exists: false } }],
			}),
		).toBe(true);
		expect(notPushed({ $or: [{ a: 1 }, { b: { $regex: "x" } }] })).toBe(true);
		// Non-array logical operands fail closed in matchFilter → 0=1.
		expect(pushed({ $and: "x" as never })).toBe(true);
		expect(pushed({ $or: "x" as never })).toBe(true);
		expect(pushed({ $or: [] })).toBe(true);
	});
});

describe("find() SQL pushdown equivalence", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore, never>;
	let db: ReturnType<typeof makeDb>;

	/** Stored payloads covering the semantic traps: JSON null vs
	 * missing, booleans vs 0/1, int64-unsafe integers, strings that
	 * look numeric, arrays/objects under range ops, prototype keys,
	 * nested paths and array-index paths. */
	const DOCS: (Record<string, unknown> | string)[] = [
		{ n: 5, s: "abc", b: true, z: null, f: 5.5, arr: [1, 2], obj: { h: 1 }, nest: { a: { b: 2 } } },
		{ n: "5", s: "5", b: false, z: 1, f: 5, arr: [], obj: {}, nest: { a: { b: "x" } } },
		{ n: null, s: "", b: null, f: -0, arr: ["a"], obj: { h: "x" } },
		{ n: 10, s: "zzz", b: true, extra: "e" },
		// Raw JSON: 9007199254740993 exceeds JS safe-integer range — a
		// JS literal would already round to ...992 before stringify,
		// but SQLite json_extract keeps the exact int64 value. JS sees
		// 9007199254740992 — the loose/strict equality split exists
		// for exactly this divergence.
		'{"n":9007199254740993,"s":"big","note":"int64-unsafe"}',
		{ n: -9223372036854775808, s: "minint" }, // |E| bound-check trap (abs() overflows in SQLite)
		{ n: 0, s: "0", arr: [{ k: 1 }] },
		{ s: "only-string" }, // most keys missing
		{ n: 5.0, s: "five-point-oh" }, // JSON 5.0 === JS 5
		{ constructor: "own-key", n: 1 }, // own prop shadows prototype — still JS-consistent
		{ n: 7, s: "uni-€-😀", nest: { a: { b: null } } },
	];

	/** Entry → the value JS `JSON.parse` produces (matchFilter's view). */
	const docValue = (d: Record<string, unknown> | string): Record<string, unknown> =>
		typeof d === "string" ? (JSON.parse(d) as Record<string, unknown>) : d;
	/** Entry → the exact TEXT stored in document_records.data. */
	const docJson = (d: Record<string, unknown> | string): string =>
		typeof d === "string" ? d : JSON.stringify(d);

	const insertedIds: number[] = [];

	beforeAll(async () => {
		db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: [sqldocs, migrated] }),
		);
		runtime = ManagedRuntime.make(DocumentStoreLive.pipe(Layer.provide(deps)));
		const now = new Date();
		for (const def of [sqldocs, migrated]) {
			const collRows = await db
				.insert(documentCollections)
				.values({
					name: def.name,
					ownerPluginId: "",
					schemaJson: JSON.stringify(def),
					version: def.version,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			const collectionId = (collRows[0] as { id: number }).id;
			if (def.name === sqldocs.name) {
				for (const doc of DOCS) {
					const rows = await db
						.insert(documentRecords)
						.values({
							collectionId,
							data: docJson(doc),
							ownerId: "",
							createdAt: now,
							updatedAt: now,
						})
						.returning();
					insertedIds.push((rows[0] as { id: number }).id);
				}
			}
		}
	});

	afterAll(() => runtime.dispose());

	const findIds = (collection: string, filter: DocumentFilter) =>
		runtime
			.runPromise(
				Effect.flatMap(DocumentStore, (s) =>
					s.find(collection, { filter, limit: 500 }, { unscoped: true }),
				),
			)
			.then((r) => r.rows.map((row) => row.id).sort((a, b) => a - b));

	const expectedIds = (filter: DocumentFilter) =>
		DOCS.map((d, i) => ({ d: docValue(d), id: insertedIds[i] as number }))
			.filter(({ d }) => matchFilter(d, filter))
			.map(({ id }) => id)
			.sort((a, b) => a - b);

	const FILTERS: DocumentFilter[] = [
		{ n: 5 },
		{ n: { $eq: 5 } },
		{ n: { $eq: "5" } },
		{ n: { $ne: 5 } },
		{ n: { $gt: 4 } },
		{ n: { $gte: 5 } },
		{ n: { $lt: 6 } },
		{ n: { $lte: 5 } },
		{ n: { $gt: -10 } },
		{ n: { $lt: 9007199254740992 } },
		{ n: { $gt: 9007199254740991 } },
		{ n: { $eq: 9007199254740992 } }, // JS-rounded value of the int64-unsafe doc
		{ n: { $ne: 9007199254740992 } },
		{ s: { $eq: "5" } },
		{ s: { $gt: "a" } },
		{ s: { $lt: "b" } },
		{ b: { $eq: true } },
		{ b: { $eq: false } },
		{ b: { $ne: true } },
		{ z: { $eq: null } },
		{ z: { $exists: true } },
		{ z: { $exists: false } },
		{ missing: { $exists: false } },
		{ missing: { $exists: true } },
		{ missing: { $eq: null } },
		{ missing: { $ne: null } },
		{ n: { $in: [5, "5", null] } },
		{ n: { $nin: [5, "5"] } },
		{ n: { $in: [] } },
		{ n: { $nin: [] } },
		{ f: { $gt: 5 } },
		{ f: { $lt: 5.4 } },
		{ arr: { $exists: true } },
		{ obj: { $gt: 0 } }, // object → String() coercion, always > numeric string
		{ "nest.a.b": 2 },
		{ "nest.a.b": { $ne: 2 } },
		{ "arr.0": 1 }, // array-index path → JS-only
		{ constructor: { $exists: true } }, // prototype-chain key → JS-only
		{ $and: [{ n: { $gte: 0 } }, { s: { $exists: true } }] },
		{ $or: [{ n: 5 }, { s: "only-string" }] },
		{ $or: [{ n: { $regex: "^5" } }, { s: "zzz" }] }, // regex branch → whole $or JS-side
		{ n: { $gt: 1, $lt: 8 } },
		{ n: { $gte: 5, $lte: 5, $ne: "5" } },
		{ title: { $regex: "doc" } }, // pure-regex → no pushdown, still correct
	];

	it.each(FILTERS.map((f, i) => [i, f] as const))(
		"filter %i matches matchFilter exactly",
		async (_i, filter) => {
			const expected = expectedIds(filter);
			const actual = await findIds("test.sqldocs", filter);
			expect(actual).toEqual(expected);
		},
	);

	it("migrated defs skip pushdown but stay correct", async () => {
		// Stored at version 1; def version 2 migrates on read — SQL would
		// see pre-migration data, so find must use the pure-JS path.
		const now = new Date();
		const collRows = await db
			.select()
			.from(documentCollections)
			.where(eq(documentCollections.name, "test.migrated"));
		const collectionId = (collRows[0] as { id: number }).id;
		await db.insert(documentRecords).values({
			collectionId,
			data: JSON.stringify({ v: { n: 1 } }), // stored n=1 fails the filter; migrated n=10 passes
			schemaVersion: 1,
			ownerId: "",
			createdAt: now,
			updatedAt: now,
		});
		const result = await runtime.runPromise(
			Effect.flatMap(DocumentStore, (s) =>
				s.find("test.migrated", { filter: { "v.n": { $gt: 2 } } }, { unscoped: true }),
			),
		);
		// If SQL pushdown ran on STORED data (n=1) this would be 0 —
		// the migrated read path is the only way to get 1.
		expect(result.total).toBe(1);
		expect(result.rows[0]?.data).toMatchObject({ v: { n: 10 } });
	});
});
