import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	VAULT_LOCALES,
	vaultMessages,
	isVaultLocale,
	type VaultMessages,
} from "./i18n.ts";

/** Every string leaf of a catalog (functions are exercised separately). */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

/** Every function leaf of a catalog. */
const functionsOf = (
	node: unknown,
	out: Array<(...args: any[]) => unknown> = [],
): Array<(...args: any[]) => unknown> => {
	if (typeof node === "function") out.push(node as (...args: any[]) => unknown);
	else if (node !== null && typeof node === "object")
		for (const value of Object.values(node)) functionsOf(value, out);
	return out;
};

describe("vault catalogs", () => {
	it("resolves known locales and falls back to the base locale", () => {
		expect(isVaultLocale("pt-BR")).toBe(true);
		expect(isVaultLocale("es")).toBe(true);
		expect(isVaultLocale("fr")).toBe(false);
		expect(vaultMessages("fr")).toBe(vaultMessages(BASE_LOCALE));
		expect(vaultMessages(undefined)).toBe(vaultMessages(BASE_LOCALE));
		expect(vaultMessages("en").title).toBe("Clinic vault");
	});

	it("has no blank copy in any locale", () => {
		for (const locale of VAULT_LOCALES) {
			const catalog: VaultMessages = vaultMessages(locale);
			for (const leaf of leaves(catalog)) {
				expect(leaf.trim().length, `${locale} blank copy`).toBeGreaterThan(0);
			}
		}
	});

	it("function leaves interpolate in every locale", () => {
		for (const locale of VAULT_LOCALES) {
			const catalog = vaultMessages(locale);
			for (const fn of functionsOf(catalog)) {
				const out = fn("member-1");
				expect(typeof out, `${locale} function leaf`).toBe("string");
				expect((out as string).includes("member-1")).toBe(true);
			}
		}
	});
});
