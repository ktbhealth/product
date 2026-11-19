import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	cronMessages,
	CRON_LOCALES,
	i18nMessagesFor,
	I18N_NAMESPACE,
	isCronLocale,
	type CronMessages,
} from "./i18n.ts";

/** Every string leaf of a catalog (functions are exercised separately). */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

describe("cron catalogs", () => {
	it("covers the three locales", () => {
		expect(CRON_LOCALES).toEqual(["en", "pt-BR", "es"]);
	});

	it("resolves known locales and falls back to the base locale", () => {
		expect(isCronLocale("pt-BR")).toBe(true);
		expect(isCronLocale("es")).toBe(true);
		expect(isCronLocale("fr")).toBe(false);
		expect(cronMessages("fr")).toBe(cronMessages(BASE_LOCALE));
		expect(cronMessages("pt-BR").title).toBe("Tarefas agendadas");
		expect(cronMessages("es").title).toBe("Tareas programadas");
	});

	it("has no empty strings and no untranslated English leaks in pt-BR/es", () => {
		for (const locale of CRON_LOCALES) {
			for (const leaf of leaves(cronMessages(locale))) {
				expect(leaf.length).toBeGreaterThan(0);
			}
		}
		const pt = cronMessages("pt-BR") as unknown as Record<string, unknown>;
		const es = cronMessages("es") as unknown as Record<string, unknown>;
		const en = cronMessages("en") as unknown as Record<string, unknown>;
		// Spot-check keys that must differ from English.
		for (const key of ["title", "jobsTitle", "runsTitle", "runNow"]) {
			expect(pt[key]).not.toBe(en[key]);
			expect(es[key]).not.toBe(en[key]);
		}
	});

	it("parametrized messages render with args", () => {
		const m: CronMessages = cronMessages("en");
		expect(m.description(3)).toContain("3");
		expect(m.description(1)).toContain("1");
		expect(m.runOk("2 reminders")).toContain("2 reminders");
	});

	it("exports a namespace and locale→messages accessor for the baseline importer", () => {
		expect(I18N_NAMESPACE).toBe("cron");
		const flat = i18nMessagesFor("en");
		expect(typeof flat.title).toBe("string");
		expect(typeof flat.description).toBe("function");
	});
});
