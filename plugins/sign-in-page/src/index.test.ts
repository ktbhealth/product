import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { Email } from "@ktb/email";

import { patientSignInHead, signInPickerHead } from "./page-head.tsx";
import { plugins, signInPagesPlugin } from "./index.ts";

describe("sign-in-page pages plugin", () => {
	it("exports the single pages plugin", () => {
		expect(plugins).toEqual([signInPagesPlugin]);
		expect(signInPagesPlugin.id).toBe("sign-in-page.pages");
	});

	it("contributes the public /login picker and /login/patient app pages", () => {
		const [picker, patient] = signInPagesPlugin.pages ?? [];
		expect(picker?.id).toBe("sign-in-page.picker");
		expect(picker?.path).toBe("/login");
		expect(picker?.context).toBe("app");
		expect((picker as { guard?: unknown }).guard).toBeUndefined();
		expect((picker as { loader?: unknown }).loader).toBeUndefined();
		expect(picker?.head).toBe(signInPickerHead);

		expect(patient?.id).toBe("sign-in-page.patient");
		expect(patient?.path).toBe("/login/patient");
		expect(patient?.context).toBe("app");
		expect((patient as { guard?: unknown }).guard).toBeUndefined();
		expect(patient?.head).toBe(patientSignInHead);
	});

	it("patient loader reports emailEnabled from the Email service", async () => {
		const patient = signInPagesPlugin.pages?.[1];
		if (patient?.loader === undefined) throw new Error("patient page must have a loader");
		const loader = patient.loader as () => Effect.Effect<unknown>;

		await expect(
			Effect.runPromise(loader().pipe(Effect.provideService(Email, null))),
		).resolves.toEqual({ emailEnabled: false });
		await expect(
			Effect.runPromise(loader().pipe(Effect.provideService(Email, { send: async () => {} }))),
		).resolves.toEqual({ emailEnabled: true });
	});

	it("head hooks set the localized meta titles from the i18n slice", () => {
		const asHead = (hook: unknown) =>
			hook as unknown as (ctx: { i18n?: { locale: string; catalog: Record<string, string> } }) => {
				meta: { title: string }[];
			};
		expect(asHead(signInPickerHead)({}).meta[0]!.title).toBe("Sign in | KTB Health");
		expect(asHead(patientSignInHead)({}).meta[0]!.title).toBe("Patient sign in | KTB Health");
		expect(
			asHead(signInPickerHead)({ i18n: { locale: "pt-BR", catalog: {} } }).meta[0]!.title,
		).toBe("Entrar | KTB Health");
		expect(
			asHead(patientSignInHead)({
				i18n: {
					locale: "en",
					catalog: { "sign-in-page.patientMetaTitle": "Custom title" },
				},
			}).meta[0]!.title,
		).toBe("Custom title");
	});
});
