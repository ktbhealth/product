import { describe, expect, it } from "vitest";

import { createCatalogT } from "@ktb/i18n";

import { emailCatalogT, verificationEmail } from "./emails.ts";

const url = "http://localhost:3000/api/auth/verify-email?token=t";

/** Catalog `t` over a fake resolved slice — mirrors what platform.ts
 * injects at send time (request locale → enabled-locale chain). */
const catalogT = (entries: Record<string, string>, locale = "en") => emailCatalogT(entries, locale);

const PT_BR: Record<string, string> = {
	"app.email_verify_subject": "Confirme seu e-mail — KTB Health",
	"app.email_verify_greeting": "Olá, {name}.",
	"app.email_verify_greeting_anon": "Olá.",
	"app.email_verify_body":
		"Confirme seu endereço de e-mail para concluir a configuração da sua conta KTB Health:",
	"app.email_verify_ignore": "Se você não criou esta conta, pode ignorar esta mensagem.",
};

describe("verificationEmail", () => {
	it("greets by name and carries the link (English fallback, no catalog)", () => {
		const mail = verificationEmail({ name: "Ana", url });
		expect(mail.subject).toBe("Confirm your email — KTB Health");
		expect(mail.text.split("\n")).toEqual([
			"Hello, Ana.",
			"",
			"Confirm your email address to finish setting up your KTB Health account:",
			url,
			"",
			"If you did not create this account, you can ignore this message.",
		]);
	});

	it("falls back to an anonymous greeting", () => {
		expect(verificationEmail({ name: null, url }).text).toMatch(/^Hello\.\n/);
	});

	it("renders catalog copy for the resolved locale", () => {
		const pt = verificationEmail({ name: "Ana", url }, catalogT(PT_BR, "pt-BR"));
		expect(pt.subject).toBe("Confirme seu e-mail — KTB Health");
		expect(pt.text).toContain("Olá, Ana.");
	});

	it("falls back to English literals for keys missing from the catalog", () => {
		const t = createCatalogT({}, "pt-BR");
		const mail = verificationEmail({ name: "Ana", url }, (key, params) => t(key, params));
		expect(mail.subject).toBe("Confirm your email — KTB Health");
		expect(mail.text).toContain("Hello, Ana.");
	});
});
