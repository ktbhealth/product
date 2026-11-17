import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	PATIENT_ACCESS_LOCALES,
	isPatientAccessLocale,
	patientAccessMessages,
	i18nMessagesFor,
} from "./i18n.ts";
import { PATIENT_ACCESS_RELATIONS, PATIENT_ACCESS_STATUSES } from "./schema.ts";

/** Flattened `path → string` view of a catalog's plain strings
 * (function-valued messages are exercised separately). */
const flatten = (value: unknown, path = ""): Record<string, string> => {
	if (typeof value === "function") return {};
	if (typeof value === "string") return { [path]: value };
	return Object.assign(
		{},
		...Object.entries(value as Record<string, unknown>).map(([key, child]) =>
			flatten(child, path ? `${path}.${key}` : key),
		),
	);
};

describe("patient-access catalogs", () => {
	it("has a complete, non-empty catalog per locale", () => {
		const keys = Object.keys(flatten(patientAccessMessages(BASE_LOCALE))).sort();
		for (const locale of PATIENT_ACCESS_LOCALES) {
			const catalog = flatten(patientAccessMessages(locale));
			expect(Object.keys(catalog).sort()).toEqual(keys);
			for (const text of Object.values(catalog)) expect(text.trim()).not.toBe("");
		}
	});

	it("labels every relation and every status a doctor can see", () => {
		for (const locale of PATIENT_ACCESS_LOCALES) {
			const t = patientAccessMessages(locale);
			expect(Object.keys(t.relation).sort()).toEqual([...PATIENT_ACCESS_RELATIONS].sort());
			// Revoked links are history: they are never listed, so never labelled.
			expect(Object.keys(t.status).sort()).toEqual(
				PATIENT_ACCESS_STATUSES.filter((status) => status !== "revoked").sort(),
			);
		}
	});

	it("titles the page with the patient's name", () => {
		expect(patientAccessMessages("en").title("Ana")).toBe("Portal access — Ana");
		expect(patientAccessMessages("pt-BR").title("Ana")).toBe("Acesso ao portal — Ana");
		expect(patientAccessMessages("es").title("Ana")).toBe("Acceso al portal — Ana");
	});

	it("composes the invite email around the doctor, the patient and the link", () => {
		const url = "https://app.ktb.test/portal/login";
		const subjects = new Set<string>();
		const bodies = new Set<string>();
		for (const locale of PATIENT_ACCESS_LOCALES) {
			const { subject, body } = patientAccessMessages(locale).inviteEmail;
			expect(subject("Dra. Bia")).toContain("Dra. Bia");
			const text = body("Dra. Bia", "Ana", url, false);
			// The accept variant — for an invitee who still has to create an
			// account — carries the same facts around a different instruction.
			const accept = body("Dra. Bia", "Ana", url, true);
			expect(accept).not.toBe(text);
			expect(accept).toContain("Dra. Bia");
			expect(accept).toContain("Ana");
			expect(accept.split("\n")).toContain(url);
			expect(text).toContain("Dra. Bia");
			expect(text).toContain("Ana");
			// The link stands on a line of its own, so mail clients linkify it whole.
			expect(text.split("\n")).toContain(url);
			subjects.add(subject("Dra. Bia"));
			bodies.add(text);
		}
		// Each locale has its own copy.
		expect(subjects.size).toBe(PATIENT_ACCESS_LOCALES.length);
		expect(bodies.size).toBe(PATIENT_ACCESS_LOCALES.length);
	});

	it("composes a metadata-only body when the patient name is withheld (ZK)", () => {
		const url = "https://app.ktb.test/portal/login";
		const bodies = new Set<string>();
		for (const locale of PATIENT_ACCESS_LOCALES) {
			const { body } = patientAccessMessages(locale).inviteEmail;
			const text = body("Dra. Bia", null, url, false);
			expect(text).toContain("Dra. Bia");
			expect(text.split("\n")).toContain(url);
			// No name slot is left dangling in the generic copy.
			expect(text).not.toContain("null");
			bodies.add(text);
		}
		expect(bodies.size).toBe(PATIENT_ACCESS_LOCALES.length);
	});

	it("translates instead of copying the base catalog", () => {
		expect(patientAccessMessages("pt-BR").description).not.toBe(
			patientAccessMessages("en").description,
		);
		expect(patientAccessMessages("es").description).not.toBe(
			patientAccessMessages("en").description,
		);
	});

	it("falls back to the base locale for unknown tags", () => {
		expect(isPatientAccessLocale("pt-BR")).toBe(true);
		expect(isPatientAccessLocale("fr")).toBe(false);
		expect(patientAccessMessages("fr")).toBe(patientAccessMessages(BASE_LOCALE));
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as the locale accessor, with base fallback", () => {
		for (const locale of PATIENT_ACCESS_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(patientAccessMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(patientAccessMessages("en"));
		expect(i18nMessagesFor("")).toBe(patientAccessMessages("en"));
	});
});
