import { describe, expect, it } from "vitest";

import {
	I18N_NAMESPACE,
	VERIFY_EMAIL_LOCALES,
	i18nMessagesFor,
	verifyEmailMessages,
} from "./i18n.ts";

describe("verify-email i18n catalog", () => {
	it("declares the verify-email DB namespace", () => {
		expect(I18N_NAMESPACE).toBe("verify-email");
	});

	it("covers every supported locale in full", () => {
		for (const locale of VERIFY_EMAIL_LOCALES) {
			const messages = verifyEmailMessages(locale);
			expect(messages.metaTitle.length).toBeGreaterThan(0);
			expect(messages.heading.length).toBeGreaterThan(0);
			expect(messages.submit.length).toBeGreaterThan(0);
			expect(messages.descSigned("a@b.c")).toContain("a@b.c");
			expect(messages.doneDesc("a@b.c")).toContain("a@b.c");
		}
	});

	it("falls back to English for unknown locales", () => {
		expect(verifyEmailMessages("fr")).toBe(verifyEmailMessages("en"));
		expect(verifyEmailMessages("")).toBe(verifyEmailMessages("en"));
		expect(i18nMessagesFor("pt-BR")).toBe(verifyEmailMessages("pt-BR"));
	});

	it("mirrors the host app.verify_* copy in English", () => {
		const en = verifyEmailMessages("en");
		expect(en.metaTitle).toBe("Verify email | KTB Health");
		expect(en.heading).toBe("Verify your email");
		expect(en.submit).toBe("Resend verification link");
		expect(en.sent).toBe(
			"If this address has an account awaiting verification, a new link is on its way.",
		);
		expect(en.errorFallback).toBe("Could not send the link. Please try again.");
		expect(en.doneHeading).toBe("Email verified");
		expect(en.descAnon).toBe("Enter your account email and we will send a new verification link.");
	});
});
