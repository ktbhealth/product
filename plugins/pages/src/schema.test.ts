import { getTableConfig } from "drizzle-orm/sqlite-core/utils";
import { describe, expect, it } from "vitest";

import { customPage, richText, schemas } from "@ktb/db/schema";

describe("custom_pages schema", () => {
	const cfg = getTableConfig(customPage);

	it("stores the custom page row", () => {
		expect(cfg.name).toBe("custom_pages");
		expect(cfg.columns.map((c) => c.name)).toEqual([
			"id",
			"path",
			"title",
			"rich_text_id",
			"search_schema_id",
			"layout_id",
			"published",
			"show_in_nav",
			"sort_order",
			"created_at",
			"updated_at",
		]);
	});

	it("keeps paths unique and indexes the nav listing", () => {
		const unique = cfg.indexes.find((i) => i.config.unique);
		expect(unique?.config.name).toBe("custom_pages_path_idx");
		expect(cfg.indexes.some((i) => i.config.name === "custom_pages_nav_idx")).toBe(true);
	});

	it("references rich_text for the body and schemas for search params", () => {
		// `fk.reference()` invokes the lazy `() => table.id` callbacks —
		// both FK targets must resolve to the right tables.
		const targets = cfg.foreignKeys.map((fk) => fk.reference().foreignTable);
		expect(targets).toContain(richText);
		expect(targets).toContain(schemas);
	});
});
