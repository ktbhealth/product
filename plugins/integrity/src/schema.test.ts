import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { recordVersions } from "./schema.ts";

describe("record_versions schema", () => {
	it("exposes the version columns", () => {
		const cfg = getTableConfig(recordVersions);
		expect(cfg.name).toBe("record_versions");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"entity_type",
			"entity_id",
			"version",
			"content_hash",
			"signature",
			"prev_hash",
			"payload",
			"blob_hash",
			"actor_user_id",
			"engine",
			"created_at",
		]);
	});

	it("indexes the entity pair and uniques (entity, version)", () => {
		const cfg = getTableConfig(recordVersions);
		expect(cfg.indexes).toHaveLength(2);
		const names = cfg.indexes.map((i) => i.config.name);
		expect(names).toContain("record_versions_entity_idx");
		expect(names).toContain("record_versions_entity_version_idx");
	});
});
