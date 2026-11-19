import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	i18nMessagesFor,
	I18N_NAMESPACE,
	isPubSubLocale,
	PUBSUB_LOCALES,
	pubSubMessages,
	type PubSubMessages,
} from "./i18n.ts";

/** Every string leaf of a catalog (functions are exercised separately). */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

describe("pubsub catalogs", () => {
	it("covers the three locales", () => {
		expect(PUBSUB_LOCALES).toEqual(["en", "pt-BR", "es"]);
	});

	it("resolves known locales and falls back to the base locale", () => {
		expect(isPubSubLocale("pt-BR")).toBe(true);
		expect(isPubSubLocale("es")).toBe(true);
		expect(isPubSubLocale("fr")).toBe(false);
		expect(pubSubMessages("fr")).toBe(pubSubMessages(BASE_LOCALE));
		expect(pubSubMessages("pt-BR").title).toBe("Pub/sub");
		expect(pubSubMessages("es").title).toBe("Pub/sub");
	});

	it("has no empty strings and no untranslated English leaks in pt-BR/es", () => {
		for (const locale of PUBSUB_LOCALES) {
			for (const leaf of leaves(pubSubMessages(locale))) {
				expect(leaf.length).toBeGreaterThan(0);
			}
		}
		const pt = pubSubMessages("pt-BR") as unknown as Record<string, unknown>;
		const es = pubSubMessages("es") as unknown as Record<string, unknown>;
		const en = pubSubMessages("en") as unknown as Record<string, unknown>;
		// Spot-check keys that must differ from English.
		for (const key of ["topicsTitle", "publishTitle", "publishOk"]) {
			expect(pt[key]).not.toBe(en[key]);
			expect(es[key]).not.toBe(en[key]);
		}
	});

	it("parametrized messages render with args", () => {
		const m: PubSubMessages = pubSubMessages("en");
		expect(m.description(3)).toContain("3");
		expect(m.description(1)).toContain("1");
	});

	it("exports a namespace and locale→messages accessor for the baseline importer", () => {
		expect(I18N_NAMESPACE).toBe("pubsub");
		const flat = i18nMessagesFor("en");
		expect(typeof flat.title).toBe("string");
		expect(typeof flat.description).toBe("function");
	});
});
