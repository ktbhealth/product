import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import { permissionEpoch, relationTuples, roles } from "@ktb/db/schema";

const DDL = `
CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
`;

describe("rbac schema", () => {
	it("exposes table config for the surviving tables", () => {
		for (const t of [roles, relationTuples, permissionEpoch]) {
			const cfg = getTableConfig(t);
			expect(cfg.name).toBeTruthy();
			expect(cfg.columns.length).toBeGreaterThan(0);
		}
	});

	it("fires roles.$onUpdate on drizzle update", async () => {
		const db = makeDb(makeD1(DDL));
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
