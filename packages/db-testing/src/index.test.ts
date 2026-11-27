import { describe, expect, it } from "vitest";

import { groups } from "@ktb/db/schema";

import { makeTestD1, makeTestDb, TEST_MIGRATIONS_DIR } from "./index.ts";

describe("makeTestD1", () => {
	it("applies the real migrations", async () => {
		const d1 = makeTestD1();
		const tables = await d1
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all<{ name: string }>();
		const names = tables.results.map((t) => t.name);
		// Spot-check tables owned by different plugins plus host-owned ones.
		expect(names).toEqual(
			expect.arrayContaining([
				"__ktb_migrations",
				"admin_audit",
				"groups",
				"patients",
				"relation_tuples",
				"roles",
				"user",
			]),
		);
		// Every migration file was applied and tracked.
		const applied = await d1.prepare("SELECT count(*) AS c FROM __ktb_migrations").first<{
			c: number;
		}>();
		expect(applied?.c).toBeGreaterThan(0);
	});

	it("execs extra fixture SQL after migrating", async () => {
		const d1 = makeTestD1(
			"INSERT INTO groups (name, slug, kind, created_at, updated_at) VALUES ('Clinic', 'clinic', 'clinic', 0, 0);",
		);
		const row = await d1.prepare("SELECT slug FROM groups WHERE name = 'Clinic'").first<{
			slug: string;
		}>();
		expect(row?.slug).toBe("clinic");
	});

	it("leaves foreign keys OFF by default (makeD1 parity)", async () => {
		const d1 = makeTestD1();
		// group_members.group_id REFERENCES groups(id) — an orphan insert
		// succeeds while enforcement is off.
		await d1
			.prepare(
				"INSERT INTO group_members (group_id, member_kind, member_id, created_at) " +
					"VALUES (999, 'user', 'ghost', 0)",
			)
			.run();
		const row = await d1
			.prepare("SELECT member_id FROM group_members WHERE group_id = 999")
			.first<{ member_id: string }>();
		expect(row?.member_id).toBe("ghost");
	});

	it("enforces foreign keys when foreignKeys: true", async () => {
		const d1 = makeTestD1("", { foreignKeys: true });
		await expect(
			d1
				.prepare(
					"INSERT INTO group_members (group_id, member_kind, member_id, created_at) " +
						"VALUES (999, 'user', 'ghost', 0)",
				)
				.run(),
		).rejects.toThrow(/FOREIGN KEY/i);
	});
});

describe("makeTestDb", () => {
	it("returns a working drizzle client over the migrated schema", async () => {
		const { db, d1, close } = makeTestDb(
			"INSERT INTO groups (name, slug, kind, created_at, updated_at) VALUES ('Clinic', 'clinic', 'clinic', 0, 0);",
		);
		const rows = await db.select({ slug: groups.slug }).from(groups);
		expect(rows).toEqual([{ slug: "clinic" }]);
		// The raw handle sees the same data.
		const raw = await d1.prepare("SELECT count(*) AS c FROM groups").first<{ c: number }>();
		expect(raw?.c).toBe(1);
		close();
	});
});

describe("TEST_MIGRATIONS_DIR", () => {
	it("points at the drizzle migrations directory", () => {
		expect(TEST_MIGRATIONS_DIR).toMatch(/packages\/db\/drizzle\/?$/);
	});
});
