import { describe, expect, it } from "vitest";

import { aiPromptMessages } from "./i18n.ts";

describe("aiPromptMessages", () => {
	it("returns a catalog for every supported locale", () => {
		for (const locale of ["en", "pt-BR", "es"]) {
			const m = aiPromptMessages(locale);
			expect(m.title.length).toBeGreaterThan(0);
			expect(m.add.length).toBeGreaterThan(0);
			expect(m.confirmDelete.length).toBeGreaterThan(0);
		}
	});

	it("localizes per locale and falls back to English", () => {
		expect(aiPromptMessages("pt-BR").title).not.toBe(aiPromptMessages("en").title);
		expect(aiPromptMessages("es").title).not.toBe(aiPromptMessages("en").title);
		expect(aiPromptMessages("fr")).toBe(aiPromptMessages("en"));
		expect(aiPromptMessages("en-US")).toBe(aiPromptMessages("en"));
	});
});
