import { describe, expect, it } from "vitest";

import { aiModelMessages } from "./i18n.ts";

describe("aiModelMessages", () => {
	it("returns a catalog for every supported locale", () => {
		for (const locale of ["en", "pt-BR", "es"]) {
			const m = aiModelMessages(locale);
			expect(m.title.length).toBeGreaterThan(0);
			expect(m.add.length).toBeGreaterThan(0);
			expect(m.confirmDelete.length).toBeGreaterThan(0);
		}
	});

	it("localizes per locale and falls back to English", () => {
		expect(aiModelMessages("pt-BR").title).not.toBe(aiModelMessages("en").title);
		expect(aiModelMessages("es").title).not.toBe(aiModelMessages("en").title);
		expect(aiModelMessages("fr")).toBe(aiModelMessages("en"));
		expect(aiModelMessages("en-US")).toBe(aiModelMessages("en"));
	});
});
