import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { groups } from "@ktb/db/schema";

import { aiModel } from "./schema.ts";

describe("ai-model schema", () => {
	it("exposes ai_model columns, scope/name uniqueness and tenant FK", () => {
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
		const unique = cfg.indexes.find((i) => i.config.unique);
		expect(unique?.config.name).toBe("ai_model_scope_name_idx");
		expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
			"scope",
			"name",
		]);
		// Soft-ref indexes for the endpoint/kind lookups.
		const names = cfg.indexes.map((i) => i.config.name);
		expect(names).toEqual(
			expect.arrayContaining(["ai_model_tenant_idx", "ai_model_endpoint_idx", "ai_model_kind_idx"]),
		);
		const fk = cfg.foreignKeys[0]!;
		expect(fk.reference().foreignColumns[0]!.name).toBe("id");
		expect(fk.reference().columns[0]!.name).toBe("tenant_id");
		expect(fk.onDelete).toBe("cascade");
		// The FK target is the real groups table, not a lookalike.
		expect(fk.reference().foreignTable).toBe(groups);
	});
});
