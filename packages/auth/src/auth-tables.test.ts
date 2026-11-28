import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { makeTestDb } from "@ktb/db-testing";

import { account, apikey, session, user, verification } from "./schema.ts";

describe("apikey table", () => {
	it("$onUpdate stamps updated_at on update", async () => {
		// Real migrations already create `apikey` — no fixture DDL.
		const test = makeTestDb();
		try {
			const db = test.db;
			await db.insert(apikey).values({
				id: "k1",
				referenceId: "u1",
				key: "sk-x",
				createdAt: new Date(1000),
				updatedAt: new Date(1000),
			});
			await db.update(apikey).set({ name: "renamed" }).where(eq(apikey.id, "k1"));
			const [row] = await db.select().from(apikey);
			expect(row?.name).toBe("renamed");
			expect(row?.updatedAt.getTime()).toBeGreaterThan(1000);
		} finally {
			test.close();
		}
	});
});

describe("auth schema lazy callbacks", () => {
	it("invokes every $onUpdate and references callback", () => {
		for (const table of [user, session, account, verification, apikey]) {
			const cfg = getTableConfig(table);
			for (const col of cfg.columns) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const onUpdate = (col as any).onUpdateFn;
				if (typeof onUpdate === "function") {
					expect(onUpdate()).toBeInstanceOf(Date);
				}
			}
			// Materializing foreign-key names resolves the
			// `() => user.id` reference callbacks.
			for (const fk of cfg.foreignKeys) {
				expect(fk.getName()).toContain("_fk");
			}
		}
		// session/account carry the user FK — assert it resolved.
		expect(getTableConfig(session).foreignKeys.length).toBeGreaterThan(0);
		expect(getTableConfig(account).foreignKeys.length).toBeGreaterThan(0);
	});
});
