import { describe, expect, it } from "vitest";

import { aiModelMessages } from "./i18n.ts";

describe("aiModelMessages", () => {
	it("serves every shipped locale", () => {
		expect(aiModelMessages("en").title).toBeTruthy();
		expect(aiModelMessages("pt-BR").title).toBeTruthy();
		expect(aiModelMessages("es").title).toBeTruthy();
	});

	it("matches locale prefixes for regional variants", () => {
		expect(aiModelMessages("pt")).toEqual(aiModelMessages("pt-BR"));
		expect(aiModelMessages("es-MX")).toEqual(aiModelMessages("es"));
	});

	it("falls back to en for unknown locales", () => {
		expect(aiModelMessages("fr")).toEqual(aiModelMessages("en"));
		expect(aiModelMessages("")).toEqual(aiModelMessages("en"));
	});
});
