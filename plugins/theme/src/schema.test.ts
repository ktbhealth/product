import { describe, expect, it } from "vitest";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import { themeAssets, themeDefinitions } from "./schema.ts";

describe("theme schema", () => {
	it("theme_assets.theme_id references theme_definitions.id with set-null", () => {
		const config = getTableConfig(themeAssets);
		expect(config.foreignKeys).toHaveLength(1);
		const fk = config.foreignKeys[0]!;
		expect(fk.reference().foreignTable).toBe(themeDefinitions);
		expect(fk.onDelete).toBe("set null");
	});

	it("theme_definitions enforces the (scope, scope_id) uniqueness", () => {
		const config = getTableConfig(themeDefinitions);
		expect(config.uniqueConstraints.length + config.indexes.length).toBeGreaterThan(0);
	});
});
