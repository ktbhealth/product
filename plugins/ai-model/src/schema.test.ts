import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { groups } from "../../groups/src/schema.ts";
import { aiModel } from "./schema.ts";

describe("ai-model schema", () => {
	it("ai_model carries scope/tenant/endpoint columns and the catalog indexes", () => {
		const cfg = getTableConfig(aiModel);
		expect(cfg.name).toBe("ai_model");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"scope",
			"tenant_id",
			"endpoint_id",
			"name",
			"model_id",
			"kind",
			"capabilities",
			"context_tokens",
			"cost_tier",
			"is_default",
			"enabled",
			"created_at",
			"updated_at",
		]);
		expect(cfg.indexes.map((i) => i.config.name)).toEqual([
			"ai_model_scope_name_idx",
			"ai_model_tenant_idx",
			"ai_model_endpoint_idx",
			"ai_model_kind_idx",
		]);
	});

	it("tenant_id FKs groups.id with cascade via the lazy reference", () => {
		const cfg = getTableConfig(aiModel);
		const fk = cfg.foreignKeys[0]!;
		// reference() evaluates the lazy `() => groups.id` callback.
		const ref = fk.reference();
		expect(ref.foreignTable).toBe(groups);
		expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
		expect(fk.onDelete).toBe("cascade");
	});
});
