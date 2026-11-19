import { describe, expect, it } from "vitest";

import {
	devCaptureTestMessages,
	i18nMessagesFor,
	isDevCaptureTestLocale,
	DEV_CAPTURE_TEST_LOCALES,
	I18N_NAMESPACE,
} from "./i18n.ts";

describe("dev-capture-test i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = devCaptureTestMessages("en");
		for (const locale of DEV_CAPTURE_TEST_LOCALES) {
			const catalog = devCaptureTestMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(devCaptureTestMessages("de")).toBe(devCaptureTestMessages("en"));
		expect(devCaptureTestMessages(undefined)).toBe(devCaptureTestMessages("en"));
		expect(devCaptureTestMessages("")).toBe(devCaptureTestMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(devCaptureTestMessages("en").statusCapturing("tab-audio", "live")).toContain(
			"tab-audio",
		);
		expect(devCaptureTestMessages("pt-BR").level("12.3")).toContain("12.3");
		expect(devCaptureTestMessages("es").level("4.5")).toContain("4.5");
	});

	it("isDevCaptureTestLocale matches declared locales only", () => {
		expect(isDevCaptureTestLocale("en")).toBe(true);
		expect(isDevCaptureTestLocale("pt-BR")).toBe(true);
		expect(isDevCaptureTestLocale("es")).toBe(true);
		expect(isDevCaptureTestLocale("en-US")).toBe(false);
	});

	it("exposes the baseline-importer contract", () => {
		expect(I18N_NAMESPACE).toBe("dev-capture-test");
		expect(i18nMessagesFor("pt-BR")).toBe(devCaptureTestMessages("pt-BR"));
	});
});
