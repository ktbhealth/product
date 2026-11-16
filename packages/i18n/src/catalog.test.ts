import { describe, expect, it } from "vitest";

import { createCatalogT } from "./catalog.ts";

describe("createCatalogT", () => {
	const t = createCatalogT(
		{
			"app.title": "Hello {name}",
			"app.items": "{count, plural, one {# item} other {# items}}",
		},
		"en",
	);

	it("renders params", () => {
		expect(t("app.title", { name: "Ana" })).toBe("Hello Ana");
	});

	it("renders plurals via Intl.PluralRules", () => {
		expect(t("app.items", { count: 1 })).toBe("1 item");
		expect(t("app.items", { count: 3 })).toBe("3 items");
	});

	it("missing key renders the namespace.key literal", () => {
		expect(t("app.missing")).toBe("app.missing");
	});
});
