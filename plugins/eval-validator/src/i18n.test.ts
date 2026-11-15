import { describe, expect, it } from "vitest";

import { EVAL_LOCALES, evalMessages, isEvalLocale } from "./i18n.ts";

describe("eval i18n catalog", () => {
	it("exposes the three locales and narrows correctly", () => {
		expect(EVAL_LOCALES).toEqual(["en", "pt-BR", "es"]);
		expect(isEvalLocale("pt-BR")).toBe(true);
		expect(isEvalLocale("fr")).toBe(false);
	});

	it("resolves each catalog and falls back to en on unknown locales", () => {
		expect(evalMessages("en").title).toBe("Eval validator");
		expect(evalMessages("pt-BR").title).toBe("Validador de eval");
		expect(evalMessages("fr").generate).toBe("Generate personas");
	});
});
