import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { groups } from "@ktb/db/schema";

import { aiPrompt } from "./schema.ts";

describe("ai-prompt schema", () => {
	it("exposes ai_prompt columns, scope/name/version/locale uniqueness and tenant FK", () => {
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
		const unique = cfg.indexes.find((i) => i.config.unique);
		expect(unique?.config.name).toBe("ai_prompt_scope_name_version_locale_idx");
		expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
			"scope",
			"name",
			"version",
			"locale",
		]);
		const fk = cfg.foreignKeys[0]!;
		expect(fk.reference().foreignColumns[0]!.name).toBe("id");
		expect(fk.reference().columns[0]!.name).toBe("tenant_id");
		expect(fk.onDelete).toBe("cascade");
		// The FK target is the real groups table, not a lookalike.
		expect(fk.reference().foreignTable).toBe(groups);
	});
});
