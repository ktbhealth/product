import { describe, expect, it } from "vitest";

import { EVAL_LOCALES, evalMessages, isEvalLocale, i18nMessagesFor } from "./i18n.ts";

describe("eval i18n catalog", () => {
	it("exposes the three locales and narrows correctly", () => {
		expect(EVAL_LOCALES).toEqual(["en", "pt-BR", "es"]);
		expect(isEvalLocale("pt-BR")).toBe(true);
		expect(isEvalLocale("fr")).toBe(false);
	});

	it("resolves each catalog and falls back to en on unknown locales", () => {
		expect(evalMessages("en").title).toBe("Run eval");
		expect(evalMessages("pt-BR").title).toBe("Rodar eval");
		expect(evalMessages("fr").runEval).toBe("Run eval");
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as the locale accessor, with base fallback", () => {
		for (const locale of EVAL_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(evalMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(evalMessages("en"));
		expect(i18nMessagesFor("")).toBe(evalMessages("en"));
	});
});
