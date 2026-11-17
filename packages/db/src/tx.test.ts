import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { makeDb, type DbClient } from "./index.ts";
import { makeD1 } from "./testing.ts";
import { tx } from "./tx.ts";

const t = sqliteTable("t", {
	id: integer().primaryKey({ autoIncrement: true }),
	v: text().notNull(),
});

const DDL = "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)";

const makeClient = () => makeDb(makeD1(DDL));

describe("tx", () => {
	it("runs ops atomically and returns per-op results", async () => {
		const db = makeClient();
		const results = await tx(db, [
			db.insert(t).values({ v: "a" }).returning({ id: t.id, v: t.v }),
			db.insert(t).values({ v: "b" }),
		]);
		expect(results[0]).toEqual([{ id: 1, v: "a" }]);
		const rows = await db.select().from(t).orderBy(t.id);
		expect(rows.map((r) => r.v)).toEqual(["a", "b"]);
	});

	it("rolls the whole batch back when a later op fails", async () => {
		const db = makeClient();
		// Second insert violates NOT NULL — nothing from the batch may land.
		await expect(
			tx(db, [db.insert(t).values({ v: "kept?" }), db.insert(t).values({ v: null as never })]),
		).rejects.toThrow(/constraint failed/);
		const rows = await db.select().from(t);
		expect(rows).toHaveLength(0);
	});

	it("rolls back on a constraint violation mid-batch", async () => {
		const db = makeDb(makeD1(`${DDL.replace("NOT NULL", "NOT NULL UNIQUE")}`));
		await tx(db, [db.insert(t).values({ v: "dup" })]);
		await expect(
			tx(db, [db.insert(t).values({ v: "first" }), db.insert(t).values({ v: "dup" })]),
		).rejects.toThrow(/constraint failed/);
		const rows = await db.select().from(t);
		expect(rows.map((r) => r.v)).toEqual(["dup"]);
	});

	it("rejects on a client with no atomic batch (pg seam)", async () => {
		const db = makeClient();
		const op = db.insert(t).values({ v: "x" });
		const batchless = { dialect: {} } as unknown as DbClient;
		await expect(tx(batchless, [op])).rejects.toThrow(/atomic batch/);
	});

	it("supports update+delete mixes like the migrated call sites", async () => {
		const db = makeClient();
		await tx(db, [db.insert(t).values({ v: "old" }), db.insert(t).values({ v: "keep" })]);
		const [, deleted] = await tx(db, [
			db.delete(t).where(eq(t.v, "old")),
			db.update(t).set({ v: "new" }).where(eq(t.v, "keep")).returning({ v: t.v }),
		]);
		expect(deleted).toEqual([{ v: "new" }]);
	});
});
