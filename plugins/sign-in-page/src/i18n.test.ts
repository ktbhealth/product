import { describe, expect, it } from "vitest";

import {
	I18N_NAMESPACE,
	SIGN_IN_LOCALES,
	i18nMessagesFor,
	isSignInLocale,
	signInMessages,
} from "./i18n.ts";

describe("sign-in-page i18n catalog", () => {
	it("declares the sign-in-page DB namespace", () => {
		expect(I18N_NAMESPACE).toBe("sign-in-page");
	});

	it("covers every supported locale in full", () => {
		for (const locale of SIGN_IN_LOCALES) {
			const messages = signInMessages(locale);
			expect(messages.pickerMetaTitle.length).toBeGreaterThan(0);
			expect(messages.patientMetaTitle.length).toBeGreaterThan(0);
			expect(messages.pickerHeading.length).toBeGreaterThan(0);
			expect(messages.patientHeadingIn.length).toBeGreaterThan(0);
			expect(messages.submitIn.length).toBeGreaterThan(0);
			expect(messages.doctorLink.length).toBeGreaterThan(0);
		}
	});

	it("falls back to English for unknown locales", () => {
		expect(signInMessages("fr")).toBe(signInMessages("en"));
		expect(signInMessages("")).toBe(signInMessages("en"));
		expect(i18nMessagesFor("pt-BR")).toBe(signInMessages("pt-BR"));
		expect(isSignInLocale("es")).toBe(true);
		expect(isSignInLocale("de")).toBe(false);
	});

	it("mirrors the host app.login_*/portal_login_* copy in English", () => {
		const en = signInMessages("en");
		expect(en.pickerMetaTitle).toBe("Sign in | KTB Health");
		expect(en.pickerHeading).toBe("Sign in");
		expect(en.pickerDesc).toBe("Choose your role to continue.");
		expect(en.patientMetaTitle).toBe("Patient sign in | KTB Health");
		expect(en.patientHeadingIn).toBe("Patient portal");
		expect(en.patientHeadingUp).toBe("Create patient account");
		expect(en.patientDescIn).toBe("Sign in to see your consultations.");
		expect(en.tabIn).toBe("Sign in");
		expect(en.tabUp).toBe("Create account");
		expect(en.name).toBe("Full name");
		expect(en.confirmPassword).toBe("Confirm password");
		expect(en.email).toBe("Email");
		expect(en.password).toBe("Password");
		expect(en.forgotPassword).toBe("Forgot your password?");
		expect(en.errorPasswordMismatch).toBe("Passwords do not match.");
		expect(en.errorFallback).toBe("Could not sign in. Please try again.");
		expect(en.pending).toBe("Please wait…");
		expect(en.submitIn).toBe("Sign in");
		expect(en.submitUp).toBe("Create account");
		expect(en.doctorLink).toBe("I am a doctor");
	});
});
