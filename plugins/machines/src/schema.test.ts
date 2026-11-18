import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { groups } from "../../groups/src/schema.ts";
import { machine } from "./schema.ts";

describe("machines schema", () => {
	it("machine carries the registry columns and indexes", () => {
		const cfg = getTableConfig(machine);
		expect(cfg.name).toBe("machine");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"scope",
			"tenant_id",
			"name",
			"kind",
			"host",
			"port",
			"capabilities",
			"secret_ref",
			"health_url",
			"status",
			"last_seen_at",
			"last_check_at",
			"check_error",
			"enabled",
			"created_at",
			"updated_at",
		]);
		expect(cfg.indexes.map((i) => i.config.name)).toEqual([
			"machine_scope_name_idx",
			"machine_tenant_idx",
			"machine_status_idx",
		]);
	});

	it("tenant_id FKs groups.id with cascade via the lazy reference", () => {
		const cfg = getTableConfig(machine);
		const fk = cfg.foreignKeys[0]!;
		// reference() evaluates the lazy `() => groups.id` callback.
		const ref = fk.reference();
		expect(ref.foreignTable).toBe(groups);
		expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
		expect(fk.onDelete).toBe("cascade");
	});
});
