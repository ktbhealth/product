import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	INVITE_LOCALES,
	inviteMessages,
	isInviteLocale,
	i18nMessagesFor,
} from "./i18n.ts";
import { INVITE_KINDS } from "./schema.ts";

/** Every string leaf of a catalog (functions are exercised separately). */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

describe("invite catalogs", () => {
	it("has a complete, non-empty catalog per locale", () => {
		expect(INVITE_LOCALES).toEqual(["en", "pt-BR", "es"]);
		expect(BASE_LOCALE).toBe("en");
		const count = leaves(inviteMessages(BASE_LOCALE)).length;
		expect(count).toBeGreaterThan(0);
		for (const locale of INVITE_LOCALES) {
			const strings = leaves(inviteMessages(locale));
			expect(strings).toHaveLength(count);
			for (const value of strings) expect(value.trim()).not.toBe("");
		}
	});

	it("has a message for every failure in every locale", () => {
		for (const locale of INVITE_LOCALES) {
			expect(Object.keys(inviteMessages(locale).errors).sort()).toEqual([
				"account_exists",
				"failed",
				"invalid",
				"invalid_name",
				"invalid_password",
			]);
		}
	});

	it("names the inviter in a heading of its own per kind", () => {
		const headings = new Set<string>();
		for (const locale of INVITE_LOCALES) {
			const { heading } = inviteMessages(locale);
			expect(Object.keys(heading).sort()).toEqual([...INVITE_KINDS].sort());
			for (const kind of INVITE_KINDS) {
				expect(heading[kind]("Dra. Ana")).toContain("Dra. Ana");
				expect(heading[kind]("Dr. Caio")).not.toContain("Dra. Ana");
				headings.add(heading[kind]("Dra. Ana"));
			}
		}
		// Each locale and each kind has its own copy.
		expect(headings.size).toBe(INVITE_LOCALES.length * INVITE_KINDS.length);
	});

	it("names the address that already has an account", () => {
		const bodies = new Set<string>();
		for (const locale of INVITE_LOCALES) {
			const body = inviteMessages(locale).existsBody("sec@ktb.test");
			expect(body).toContain("sec@ktb.test");
			bodies.add(body);
		}
		expect(bodies.size).toBe(INVITE_LOCALES.length);
	});

	it("titles the page in each locale", () => {
		expect(INVITE_LOCALES.map((locale) => inviteMessages(locale).metaTitle)).toEqual([
			"Accept invitation | KTB Health",
			"Aceitar convite | KTB Health",
			"Aceptar invitación | KTB Health",
		]);
	});

	it("falls back to the base locale for unknown tags", () => {
		expect(isInviteLocale("es")).toBe(true);
		expect(isInviteLocale("pt-BR")).toBe(true);
		expect(isInviteLocale("pt")).toBe(false);
		expect(isInviteLocale("fr")).toBe(false);
		expect(inviteMessages("fr")).toBe(inviteMessages(BASE_LOCALE));
		expect(inviteMessages("es")).not.toBe(inviteMessages(BASE_LOCALE));
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as the locale accessor, with base fallback", () => {
		for (const locale of INVITE_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(inviteMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(inviteMessages("en"));
		expect(i18nMessagesFor("")).toBe(inviteMessages("en"));
	});
});
