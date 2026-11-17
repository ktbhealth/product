import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { groups } from "@ktb/db/schema";

import { adminAudit } from "./schema.ts";

describe("admin_audit schema", () => {
	it("exposes the audit columns", () => {
		const cfg = getTableConfig(adminAudit);
		expect(cfg.name).toBe("admin_audit");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"actor_user_id",
			"actor_email",
			"action",
			"target_type",
			"target_id",
			"detail",
			"tenant_id",
			"prev_hash",
			"created_at",
		]);
	});

	it("indexes created_at, action, actor_user_id, (tenant_id, created_at) and the read-dedupe composite, FKs tenant_id to groups", () => {
		const cfg = getTableConfig(adminAudit);
		expect(cfg.indexes).toHaveLength(5);
		const names = cfg.indexes.map((i) => i.config.name);
		expect(names).toContain("admin_audit_tenant_created_idx");
		// P-087 D3: the coalescing probe's composite index.
		expect(names).toContain("admin_audit_dedupe_idx");
		for (const fk of cfg.foreignKeys) {
			expect(fk.onDelete).toBe("set null");
			// reference() evaluates the lazy `() => groups.id` callback.
			const ref = fk.reference();
			expect(ref.foreignTable).toBe(groups);
			expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
		}
	});
});
