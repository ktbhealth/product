import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { eq } from "drizzle-orm";

import { DOCTOR_ACCESS_ROLES, DOCTOR_ACCESS_STATUSES, doctorAccess } from "./schema.ts";

describe("secretaries schema", () => {
	it("exposes doctor_access with cascading FKs and lookup indexes", () => {
		const cfg = getTableConfig(doctorAccess);
		expect(cfg.name).toBe("doctor_access");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"doctor_id",
			"user_id",
			"email",
			"role",
			"status",
			"invited_by",
			"created_at",
			"updated_at",
		]);
		expect(cfg.foreignKeys.map((fk) => fk.reference().foreignTable)).toHaveLength(2);
		for (const fk of cfg.foreignKeys) {
			expect(fk.reference().foreignColumns.map((c) => c.name)).toEqual(["id"]);
			expect(fk.onDelete).toBe("cascade");
		}
		expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual([
			"doctor_access_doctor_email_idx",
			"doctor_access_email_idx",
			"doctor_access_user_idx",
		]);
	});

	it("defaults to an invited secretary and fires $onUpdate", async () => {
		const db = makeDb(makeTestD1());
		const [created] = await db
			.insert(doctorAccess)
			.values({ doctorId: 1, email: "sec@ktb.test", createdAt: new Date(), updatedAt: new Date(0) })
			.returning();
		expect(created!.role).toBe(DOCTOR_ACCESS_ROLES[0]);
		expect(created!.status).toBe(DOCTOR_ACCESS_STATUSES[0]);
		expect(created!.userId).toBeNull();
		await db
			.update(doctorAccess)
			.set({ userId: "u2", status: "active" })
			.where(eq(doctorAccess.id, created!.id));
		const [row] = await db.select().from(doctorAccess);
		expect(row!.status).toBe("active");
		expect(row!.updatedAt.getTime()).toBeGreaterThan(0);
	});

	it("rejects a second row for the same doctor and email", async () => {
		const db = makeDb(makeTestD1());
		await db
			.insert(doctorAccess)
			.values({ doctorId: 1, email: "sec@ktb.test", createdAt: new Date(), updatedAt: new Date() });
		await expect(
			db.insert(doctorAccess).values({
				doctorId: 1,
				email: "sec@ktb.test",
				createdAt: new Date(),
				updatedAt: new Date(),
			}),
		).rejects.toThrow(/Failed query/);
	});
});
