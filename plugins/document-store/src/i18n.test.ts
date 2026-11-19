import { describe, expect, it } from "vitest";

import {
	documentStoreMessages,
	i18nMessagesFor,
	isDocumentStoreLocale,
	DOCUMENT_STORE_LOCALES,
} from "./i18n.ts";

describe("document-store i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = documentStoreMessages("en");
		for (const locale of DOCUMENT_STORE_LOCALES) {
			const catalog = documentStoreMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(documentStoreMessages("de")).toBe(documentStoreMessages("en"));
		expect(documentStoreMessages(undefined)).toBe(documentStoreMessages("en"));
		expect(documentStoreMessages("")).toBe(documentStoreMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(documentStoreMessages("en").deleteBody("7")).toContain("7");
		expect(documentStoreMessages("pt-BR").deleteBody("7")).toContain("7");
		expect(documentStoreMessages("es").deleteBody("7")).toContain("7");
		expect(documentStoreMessages("en").pageInfo(2, 9)).toContain("2");
		expect(documentStoreMessages("en").deleteInUse("a.b")).toContain("a.b");
		expect(documentStoreMessages("en").scopeTenant(3)).toContain("3");
		expect(documentStoreMessages("en").scopeOwner("u1")).toContain("u1");
		expect(documentStoreMessages("pt-BR").scopeTenant(3)).toContain("3");
		expect(documentStoreMessages("pt-BR").scopeOwner("u1")).toContain("u1");
		expect(documentStoreMessages("es").scopeTenant(3)).toContain("3");
		expect(documentStoreMessages("es").scopeOwner("u1")).toContain("u1");
	});

	it("isDocumentStoreLocale matches declared locales only", () => {
		expect(isDocumentStoreLocale("en")).toBe(true);
		expect(isDocumentStoreLocale("pt-BR")).toBe(true);
		expect(isDocumentStoreLocale("es")).toBe(true);
		expect(isDocumentStoreLocale("en-US")).toBe(false);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as documentStoreMessages, with base fallback", () => {
		for (const locale of DOCUMENT_STORE_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(documentStoreMessages(locale));
		}
		expect(i18nMessagesFor("de")).toBe(documentStoreMessages("en"));
	});
});
