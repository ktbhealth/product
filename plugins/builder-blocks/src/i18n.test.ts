import { describe, expect, it } from "vitest";

import {
	builderBlocksMessages,
	BUILDER_BLOCKS_LOCALES,
	I18N_NAMESPACE,
	i18nMessagesFor,
	isBuilderBlocksLocale,
} from "./i18n.ts";

describe("builder-blocks i18n", () => {
	it("ships en/pt-BR/es catalogs implementing the full message shape", () => {
		const en = builderBlocksMessages("en");
		for (const locale of BUILDER_BLOCKS_LOCALES) {
			const messages = builderBlocksMessages(locale);
			expect(messages.title.length).toBeGreaterThan(0);
			expect(messages.kindCount(2)).toContain("2");
		}
		expect(en.title).toBe("Components");
		expect(builderBlocksMessages("pt-BR").title).toBe("Componentes");
		expect(builderBlocksMessages("es").title).toBe("Componentes");
	});

	it("falls back to the base locale for unknown tags", () => {
		expect(builderBlocksMessages("de")).toEqual(builderBlocksMessages("en"));
		expect(builderBlocksMessages(undefined)).toEqual(builderBlocksMessages("en"));
	});

	it("isBuilderBlocksLocale recognizes shipped locales only", () => {
		expect(isBuilderBlocksLocale("en")).toBe(true);
		expect(isBuilderBlocksLocale("pt-BR")).toBe(true);
		expect(isBuilderBlocksLocale("es")).toBe(true);
		expect(isBuilderBlocksLocale("fr")).toBe(false);
		expect(isBuilderBlocksLocale("")).toBe(false);
	});

	it("i18nMessagesFor resolves the catalog for the importer", () => {
		expect(i18nMessagesFor("en")).toEqual(builderBlocksMessages("en"));
		expect(I18N_NAMESPACE).toBe("builder-blocks");
	});
});
