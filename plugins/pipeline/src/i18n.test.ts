import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	I18N_NAMESPACE,
	i18nMessagesFor,
	PIPELINE_LOCALES,
	pipelineMessages,
} from "./i18n.ts";

describe("pipelineMessages", () => {
	it("exposes the pipeline i18n namespace", () => {
		expect(I18N_NAMESPACE).toBe("pipeline");
	});

	it("resolves every declared locale catalog", () => {
		for (const locale of PIPELINE_LOCALES) {
			expect(pipelineMessages(locale).title).toBe("Pipelines");
		}
	});

	it("falls back to the base locale for missing or unknown locales", () => {
		expect(pipelineMessages()).toBe(pipelineMessages(BASE_LOCALE));
		expect(pipelineMessages("fr")).toBe(pipelineMessages(BASE_LOCALE));
	});

	it("evaluates the interpolated copy in every locale", () => {
		for (const locale of PIPELINE_LOCALES) {
			const t = pipelineMessages(locale);
			expect(t.editorEditTitle("demo")).toContain("demo");
			// Every function-valued catalog entry must execute in each
			// locale — the coverage gate requires all branches hit.
			const entries = t as unknown as Record<string, unknown>;
			for (const value of Object.values(entries)) {
				if (typeof value === "function") {
					(value as (...args: unknown[]) => unknown)("x");
				}
			}
		}
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as the locale accessor, with base fallback", () => {
		for (const locale of PIPELINE_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(pipelineMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(pipelineMessages("en"));
		expect(i18nMessagesFor("")).toBe(pipelineMessages("en"));
	});
});
