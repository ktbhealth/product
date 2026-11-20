import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	i18nMessagesFor,
	I18N_NAMESPACE,
	isMiddlewareLocale,
	MIDDLEWARE_LOCALES,
	middlewareMessages,
	type MiddlewareMessages,
} from "./i18n.ts";

/** Every string leaf of a catalog (functions are exercised separately). */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

describe("middleware catalogs", () => {
	it("covers the three locales", () => {
		expect(MIDDLEWARE_LOCALES).toEqual(["en", "pt-BR", "es"]);
	});

	it("resolves known locales and falls back to the base locale", () => {
		expect(isMiddlewareLocale("pt-BR")).toBe(true);
		expect(isMiddlewareLocale("es")).toBe(true);
		expect(isMiddlewareLocale("fr")).toBe(false);
		expect(middlewareMessages("fr")).toBe(middlewareMessages(BASE_LOCALE));
		expect(middlewareMessages("pt-BR").title).toBe("Middleware");
		expect(middlewareMessages("es").title).toBe("Middleware");
	});

	it("has no empty strings in any locale", () => {
		for (const locale of MIDDLEWARE_LOCALES) {
			for (const leaf of leaves(middlewareMessages(locale))) {
				expect(leaf.length).toBeGreaterThan(0);
			}
		}
	});

	it("parametrized counters render with args", () => {
		const m: MiddlewareMessages = middlewareMessages("en");
		expect(m.stageCount(3)).toContain("3");
		expect(m.stageCount(1)).toContain("1");
		expect(m.routeCount(2)).toContain("2");
		const pt = middlewareMessages("pt-BR");
		expect(pt.stageCount(3)).toContain("3");
		expect(pt.routeCount(1)).toContain("1");
	});

	it("exports a namespace and locale→messages accessor for the baseline importer", () => {
		expect(I18N_NAMESPACE).toBe("middleware");
		const flat = i18nMessagesFor("en");
		expect(typeof flat.title).toBe("string");
		expect(typeof flat.stagesTitle).toBe("string");
	});
});
