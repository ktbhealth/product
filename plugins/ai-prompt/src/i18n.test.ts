import { describe, expect, it } from "vitest";

import { aiPromptMessages } from "./i18n.ts";

describe("aiPromptMessages", () => {
	it("serves every shipped locale", () => {
		expect(aiPromptMessages("en").title).toBeTruthy();
		expect(aiPromptMessages("pt-BR").title).toBeTruthy();
		expect(aiPromptMessages("es").title).toBeTruthy();
	});

	it("prefix-matches pt and es locales", () => {
		expect(aiPromptMessages("pt")).toEqual(aiPromptMessages("pt-BR"));
		expect(aiPromptMessages("es-MX")).toEqual(aiPromptMessages("es"));
	});

	it("falls back to en for unknown locales", () => {
		expect(aiPromptMessages("fr")).toEqual(aiPromptMessages("en"));
		expect(aiPromptMessages("")).toEqual(aiPromptMessages("en"));
	});
});
