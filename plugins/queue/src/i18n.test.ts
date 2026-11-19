import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	i18nMessagesFor,
	I18N_NAMESPACE,
	isQueueLocale,
	QUEUE_LOCALES,
	queueMessages,
	type QueueMessages,
} from "./i18n.ts";

/** Every string leaf of a catalog (functions are exercised separately). */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

describe("queue catalogs", () => {
	it("covers the three locales", () => {
		expect(QUEUE_LOCALES).toEqual(["en", "pt-BR", "es"]);
	});

	it("resolves known locales and falls back to the base locale", () => {
		expect(isQueueLocale("pt-BR")).toBe(true);
		expect(isQueueLocale("es")).toBe(true);
		expect(isQueueLocale("fr")).toBe(false);
		expect(queueMessages("fr")).toBe(queueMessages(BASE_LOCALE));
		expect(queueMessages("pt-BR").title).toBe("Fila");
		expect(queueMessages("es").title).toBe("Cola");
	});

	it("has no empty strings and no untranslated English leaks in pt-BR/es", () => {
		for (const locale of QUEUE_LOCALES) {
			for (const leaf of leaves(queueMessages(locale))) {
				expect(leaf.length).toBeGreaterThan(0);
			}
		}
		const pt = queueMessages("pt-BR") as unknown as Record<string, unknown>;
		const es = queueMessages("es") as unknown as Record<string, unknown>;
		const en = queueMessages("en") as unknown as Record<string, unknown>;
		// Spot-check keys that must differ from English.
		for (const key of ["title", "queuesTitle", "runsTitle", "enqueueTitle"]) {
			expect(pt[key]).not.toBe(en[key]);
			expect(es[key]).not.toBe(en[key]);
		}
	});

	it("parametrized messages render with args", () => {
		const m: QueueMessages = queueMessages("en");
		expect(m.description(3)).toContain("3");
		expect(m.description(1)).toContain("1");
	});

	it("exports a namespace and locale→messages accessor for the baseline importer", () => {
		expect(I18N_NAMESPACE).toBe("queue");
		const flat = i18nMessagesFor("en");
		expect(typeof flat.title).toBe("string");
		expect(typeof flat.description).toBe("function");
	});
});
