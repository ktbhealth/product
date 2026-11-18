import { describe, expect, it } from "vitest";

import { i18nMessagesFor, machineMessages } from "./i18n.ts";

describe("machineMessages", () => {
	it("serves every shipped locale", () => {
		expect(machineMessages("en").title).toBeTruthy();
		expect(machineMessages("pt-BR").title).toBeTruthy();
		expect(machineMessages("es").title).toBeTruthy();
	});

	it("falls back to en for unknown locales", () => {
		expect(machineMessages("fr")).toEqual(machineMessages("en"));
	});

	it("i18nMessagesFor delegates to machineMessages", () => {
		expect(i18nMessagesFor("pt-BR")).toEqual(machineMessages("pt-BR"));
		expect(i18nMessagesFor("xx")).toEqual(machineMessages("en"));
	});
});
