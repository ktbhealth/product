import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { groups } from "../../groups/src/schema.ts";
import { aiPrompt } from "./schema.ts";

describe("ai-prompt schema", () => {
	it("ai_prompt carries the versioned-prompt columns and indexes", () => {
		const cfg = getTableConfig(aiPrompt);
		expect(cfg.name).toBe("ai_prompt");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"scope",
			"tenant_id",
			"name",
			"version",
			"locale",
			"template",
			"variables",
			"model_hint",
			"is_system",
			"is_default",
			"enabled",
			"created_at",
			"updated_at",
		]);
		expect(cfg.indexes.map((i) => i.config.name)).toEqual([
			"ai_prompt_scope_name_version_locale_idx",
			"ai_prompt_tenant_idx",
			"ai_prompt_name_idx",
		]);
	});

	it("tenant_id FKs groups.id with cascade via the lazy reference", () => {
		const cfg = getTableConfig(aiPrompt);
		const fk = cfg.foreignKeys[0]!;
		// reference() evaluates the lazy `() => groups.id` callback.
		const ref = fk.reference();
		expect(ref.foreignTable).toBe(groups);
		expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
		expect(fk.onDelete).toBe("cascade");
	});
});
