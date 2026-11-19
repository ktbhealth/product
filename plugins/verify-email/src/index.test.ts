import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { Email } from "@ktb/email";

import { plugins, verifyEmailPagesPlugin } from "./index.ts";
import { verifyEmailHead } from "./head.tsx";

describe("verify-email pages plugin", () => {
	it("exports the single pages plugin", () => {
		expect(plugins).toEqual([verifyEmailPagesPlugin]);
		expect(verifyEmailPagesPlugin.id).toBe("verify-email.pages");
	});

	it("contributes the public /verify-email app page", () => {
		const page = verifyEmailPagesPlugin.pages?.[0];
		expect(page?.id).toBe("verify-email.page");
		expect(page?.path).toBe("/verify-email");
		expect(page?.context).toBe("app");
		expect((page as { guard?: unknown }).guard).toBeUndefined();
		expect(page?.head).toBe(verifyEmailHead);
	});

	it("loader reports emailEnabled from the Email service", async () => {
		const page = verifyEmailPagesPlugin.pages?.[0];
		if (page?.loader === undefined) throw new Error("verify-email page must have a loader");
		const loader = page.loader as () => Effect.Effect<unknown>;

		await expect(
			Effect.runPromise(loader().pipe(Effect.provideService(Email, null))),
		).resolves.toEqual({ emailEnabled: false });
		await expect(
			Effect.runPromise(loader().pipe(Effect.provideService(Email, { send: async () => {} }))),
		).resolves.toEqual({ emailEnabled: true });
	});

	it("head sets the localized meta title from the i18n slice", () => {
		const head = verifyEmailHead as unknown as (ctx: {
			i18n?: { locale: string; catalog: Record<string, string> };
		}) => { meta: { title: string }[] };
		expect(head({}).meta[0]!.title).toBe("Verify email | KTB Health");
		expect(
			head({
				i18n: { locale: "pt-BR", catalog: {} },
			}).meta[0]!.title,
		).toBe("Verificar e-mail | KTB Health");
		expect(
			head({
				i18n: {
					locale: "en",
					catalog: { "verify-email.metaTitle": "Custom title" },
				},
			}).meta[0]!.title,
		).toBe("Custom title");
	});
});
