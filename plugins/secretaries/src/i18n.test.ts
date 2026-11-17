import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	SECRETARY_LOCALES,
	isSecretaryLocale,
	secretaryMessages,
	i18nMessagesFor,
} from "./i18n.ts";

/** Every string leaf of a catalog (functions are exercised separately). */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

describe("secretary catalogs", () => {
	it("has a complete, non-empty catalog per locale", () => {
		const count = leaves(secretaryMessages(BASE_LOCALE)).length;
		for (const locale of SECRETARY_LOCALES) {
			const strings = leaves(secretaryMessages(locale));
			expect(strings).toHaveLength(count);
			for (const value of strings) expect(value.trim()).not.toBe("");
		}
	});

	it("composes the invite email around the doctor and the link", () => {
		const url = "https://app.ktb.test/login";
		const subjects = new Set<string>();
		for (const locale of SECRETARY_LOCALES) {
			const { subject, body } = secretaryMessages(locale).inviteEmail;
			expect(subject("Dra. Ana")).toContain("Dra. Ana");
			// Two variants: the sign-in link, and the accept link for an
			// invitee who still has to create an account.
			for (const accept of [false, true]) {
				expect(body("Dra. Ana", url, accept)).toContain("Dra. Ana");
				expect(body("Dra. Ana", url, accept).split("\n")).toContain(url);
			}
			expect(body("Dra. Ana", url, true)).not.toBe(body("Dra. Ana", url, false));
			subjects.add(subject("Dra. Ana"));
		}
		// Each locale has its own copy.
		expect(subjects.size).toBe(SECRETARY_LOCALES.length);
	});

	it("falls back to the base locale for unknown tags", () => {
		expect(isSecretaryLocale("es")).toBe(true);
		expect(isSecretaryLocale("fr")).toBe(false);
		expect(secretaryMessages("fr")).toBe(secretaryMessages(BASE_LOCALE));
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as the locale accessor, with base fallback", () => {
		for (const locale of SECRETARY_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(secretaryMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(secretaryMessages("en"));
		expect(i18nMessagesFor("")).toBe(secretaryMessages("en"));
	});
});
