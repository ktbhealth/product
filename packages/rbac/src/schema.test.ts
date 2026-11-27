import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { permissionEpoch, relationTuples, roles } from "@ktb/db/schema";

describe("rbac schema", () => {
	it("exposes table config for the surviving tables", () => {
		for (const t of [roles, relationTuples, permissionEpoch]) {
			const cfg = getTableConfig(t);
			expect(cfg.name).toBeTruthy();
			expect(cfg.columns.length).toBeGreaterThan(0);
		}
	});

	it("fires roles.$onUpdate on drizzle update", async () => {
		const db = makeDb(makeTestD1());
		await db.insert(roles).values({
			id: 1,
			name: "auditor",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		await db.update(roles).set({ description: "RO" }).where(eq(roles.id, 1));
		const row = await db.select().from(roles).where(eq(roles.id, 1));
		expect(row[0]?.description).toBe("RO");
		expect(row[0]?.updatedAt.getTime()).toBeGreaterThan(0);
	});
});
