import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { wizardDefs, wizardRuns } from "./schema.ts";

describe("wizard_defs schema", () => {
	const cfg = getTableConfig(wizardDefs);

	it("stores the admin-authored definition row", () => {
		expect(cfg.name).toBe("wizard_defs");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"key",
			"title",
			"description",
			"definition_json",
			"published",
			"created_at",
			"updated_at",
		]);
	});

	it("keeps wizard keys unique", () => {
		const unique = cfg.indexes.find((i) => i.config.unique);
		expect(unique?.config.name).toBe("wizard_defs_key_idx");
	});
});

describe("wizard_runs schema", () => {
	const cfg = getTableConfig(wizardRuns);

	it("stores the run snapshot + lifecycle", () => {
		expect(cfg.name).toBe("wizard_runs");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"key",
			"definition_json",
			"status",
			"step_index",
			"answers_json",
			"owner_id",
			"created_at",
			"updated_at",
			"completed_at",
		]);
	});

	it("indexes runs by owner and status", () => {
		const idx = cfg.indexes.find((i) => i.config.name === "wizard_runs_owner_idx");
		expect(idx).toBeDefined();
	});
});
