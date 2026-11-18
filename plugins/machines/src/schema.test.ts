import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { groups } from "@ktb/db/schema";

import { machine } from "./schema.ts";

describe("machines schema", () => {
	it("exposes machine columns, scope/name uniqueness and tenant FK", () => {
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
		const unique = cfg.indexes.find((i) => i.config.unique);
		expect(unique?.config.name).toBe("machine_scope_name_idx");
		expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
			"scope",
			"name",
		]);
		const fk = cfg.foreignKeys[0]!;
		expect(fk.reference().foreignColumns[0]!.name).toBe("id");
		expect(fk.reference().columns[0]!.name).toBe("tenant_id");
		expect(fk.onDelete).toBe("cascade");
		// The FK target is the real groups table, not a lookalike.
		expect(fk.reference().foreignTable).toBe(groups);
	});
});
