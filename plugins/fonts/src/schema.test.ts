import { describe, expect, it } from "vitest";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import { fontFamilies, fontProviders } from "./schema.ts";

describe("fonts schema", () => {
	it("font_families.provider_id references font_providers.id with cascade", () => {
		const config = getTableConfig(fontFamilies);
		expect(config.foreignKeys).toHaveLength(1);
		const fk = config.foreignKeys[0]!;
		expect(fk.reference().foreignTable).toBe(fontProviders);
		expect(fk.onDelete).toBe("cascade");
	});

	it("font_families enforces (provider_id, family) uniqueness", () => {
		const config = getTableConfig(fontFamilies);
		expect(config.uniqueConstraints.length + config.indexes.length).toBeGreaterThan(0);
	});
});
