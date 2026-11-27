import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { documentCollections, documentRecords } from "@ktb/db/schema";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { defineCollection } from "./collection.ts";
import { DocumentCollections } from "./collection.ts";
import { f } from "./fields.ts";
import { FIND_SCAN_MAX_ROWS } from "./query.ts";
import { DocumentStore, DocumentStoreLive } from "./service.ts";

const RUN = process.env.DOCUMENT_STORE_BENCH === "1";

const benchDef = (name: string) =>
	defineCollection({
		name,
		fields: {
			title: f.string({ required: true }),
			count: f.number({ default: 0 }),
			kind: f.enum(["a", "b", "c"] as const),
		},
	});

describe.skipIf(!RUN)("document-store find() benchmark", () => {
	let runtime: ManagedRuntime.ManagedRuntime<DocumentStore, never>;
	let db: ReturnType<typeof makeDb>;

	const COLLECTIONS = [benchDef("bench.1k"), benchDef("bench.10k")];

	beforeAll(async () => {
		db = makeDb(makeTestD1());
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(DocumentCollections, { collections: COLLECTIONS }),
		);
		runtime = ManagedRuntime.make(DocumentStoreLive.pipe(Layer.provide(deps)));
		// Register collection rows, then bulk-load records directly.
		const now = new Date();
		for (const [i, def] of COLLECTIONS.entries()) {
			const size = i === 0 ? 1_000 : FIND_SCAN_MAX_ROWS;
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
			const rows = Array.from({ length: size }, (_, j) => ({
				collectionId,
				data: JSON.stringify({
					title: `doc-${j}`,
					count: j % 100,
					kind: (["a", "b", "c"] as const)[j % 3],
				}),
				ownerId: "",
				createdAt: now,
				updatedAt: now,
			}));
			for (let off = 0; off < rows.length; off += 1000) {
				await db.insert(documentRecords).values(rows.slice(off, off + 1000));
			}
		}
	});

	afterAll(() => runtime.dispose());

	const timeFind = async (
		collection: string,
		query: Parameters<DocumentStore["Service"]["find"]>[1],
	): Promise<{ ms: number; total: number }> => {
		const started = performance.now();
		const result = await runtime.runPromise(
			Effect.flatMap(DocumentStore, (s) => s.find(collection, query, { unscoped: true })),
		);
		return { ms: performance.now() - started, total: result.total };
	};

	it("times unfiltered, SQL-pushed and JS-only filtered find", async () => {
		for (const [name, expected] of [
			["bench.1k", 1_000],
			["bench.10k", FIND_SCAN_MAX_ROWS],
		] as const) {
			const scan = await timeFind(name, {});
			const filtered = await timeFind(name, {
				filter: { kind: { $eq: "b" }, count: { $gte: 50 } },
				sort: [{ field: "title", dir: "asc" }],
				limit: 50,
			});
			// $regex cannot push down — this is the pre-T-149 worst case:
			// every visible row is parsed, migrated and regex-matched.
			const jsOnly = await timeFind(name, {
				filter: { title: { $regex: "^doc-5" } },
				sort: [{ field: "title", dir: "asc" }],
				limit: 50,
			});
			// eslint-disable-next-line no-console -- benchmark output IS the deliverable
			console.log(
				`[bench] ${name}: scan ${scan.ms.toFixed(1)}ms (total=${scan.total}), ` +
					`sql-filtered ${filtered.ms.toFixed(1)}ms (total=${filtered.total}), ` +
					`js-only ${jsOnly.ms.toFixed(1)}ms (total=${jsOnly.total})`,
			);
			expect(scan.total).toBe(expected);
			expect(filtered.total).toBeGreaterThan(0);
			expect(filtered.total).toBeLessThan(expected);
			expect(jsOnly.total).toBeGreaterThan(0);
			expect(jsOnly.total).toBeLessThan(expected);
			// Pushdown must never be slower than the JS-only path.
			expect(filtered.ms).toBeLessThanOrEqual(jsOnly.ms + 5);
		}
	}, 120_000);
});
