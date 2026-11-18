import { describe, expect, it } from "vitest";

import {
	I18N_NAMESPACE,
	i18nMessagesFor,
	VIEWS_LOCALES,
	viewsMessages,
	type ViewMessages,
} from "./i18n.ts";

describe("views i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = viewsMessages("en");
		for (const locale of VIEWS_LOCALES) {
			const catalog: ViewMessages = viewsMessages(locale);
			for (const key of Object.keys(en) as (keyof ViewMessages)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown locales", () => {
		expect(viewsMessages("de")).toBe(viewsMessages("en"));
		expect(viewsMessages("")).toBe(viewsMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		for (const locale of VIEWS_LOCALES) {
			const m = viewsMessages(locale);
			expect(m.pageInfo(2, 9)).toContain("2");
			expect(m.backToView("T")).toContain("T");
		}
	});

	it("exposes the DB namespace and locale accessor", () => {
		expect(I18N_NAMESPACE).toBe("views");
		for (const locale of VIEWS_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(viewsMessages(locale));
		}
		expect(i18nMessagesFor("de")).toBe(viewsMessages("en"));
	});
});
