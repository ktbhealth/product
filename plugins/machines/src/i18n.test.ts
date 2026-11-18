import { describe, expect, it } from "vitest";

import { i18nMessagesFor, MACHINE_LOCALES, machineMessages } from "./i18n.ts";

describe("machineMessages", () => {
	it("returns a catalog for every supported locale", () => {
		for (const locale of MACHINE_LOCALES) {
			const m = machineMessages(locale);
			expect(m.title.length).toBeGreaterThan(0);
			expect(m.confirmDelete.length).toBeGreaterThan(0);
		}
	});

	it("localizes per locale and falls back to English", () => {
		expect(machineMessages("pt-BR").title).not.toBe(machineMessages("en").title);
		expect(machineMessages("es").title).not.toBe(machineMessages("en").title);
		expect(machineMessages("fr")).toBe(machineMessages("en"));
	});

	it("i18nMessagesFor mirrors machineMessages", () => {
		expect(i18nMessagesFor("es")).toBe(machineMessages("es"));
		expect(i18nMessagesFor("de")).toBe(machineMessages("en"));
	});
});
