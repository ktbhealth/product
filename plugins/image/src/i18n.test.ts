import { describe, expect, it } from "vitest";

import { i18nMessagesFor, isImageLocale, imageMessages, IMAGE_LOCALES } from "./i18n.ts";

describe("image i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = imageMessages("en");
		for (const locale of IMAGE_LOCALES) {
			const catalog = imageMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(imageMessages("de")).toBe(imageMessages("en"));
		expect(imageMessages(undefined)).toBe(imageMessages("en"));
		expect(imageMessages("")).toBe(imageMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(imageMessages("en").deleteBody("Pic")).toContain("Pic");
		expect(imageMessages("pt-BR").deleteBody("Pic")).toContain("Pic");
		expect(imageMessages("es").deleteBody("Pic")).toContain("Pic");
	});

	it("isImageLocale matches declared locales only", () => {
		expect(isImageLocale("en")).toBe(true);
		expect(isImageLocale("pt-BR")).toBe(true);
		expect(isImageLocale("es")).toBe(true);
		expect(isImageLocale("de")).toBe(false);
		expect(isImageLocale("")).toBe(false);
	});

	it("i18nMessagesFor resolves catalogs by locale tag", () => {
		expect(i18nMessagesFor("pt-BR").title).toBe("Imagens");
		expect(i18nMessagesFor("fr").title).toBe("Images");
	});
});
