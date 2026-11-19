import { sliceMessages } from "@ktb/i18n";
import type { PageHead } from "@ktb/kernel";

import { I18N_NAMESPACE, signInMessages } from "./i18n.ts";

/**
 * Page `head` hooks shared by the server (./index.ts) and client
 * (./client.ts) manifests — the client/server parity test compares
 * hook references, so both sides must import THESE functions (never
 * per-manifest copies). `ctx.i18n` is the route-scoped DB catalog
 * slice the splat dispatcher resolves from the root match — it
 * already honors `?locale=`; no extra server roundtrip (same
 * contract the retired host routes documented).
 */
export const signInPickerHead: PageHead = (ctx) => ({
	meta: [
		{
			title: sliceMessages(ctx.i18n, I18N_NAMESPACE, signInMessages(ctx.i18n?.locale ?? "en"))
				.pickerMetaTitle,
		},
	],
});

export const patientSignInHead: PageHead = (ctx) => ({
	meta: [
		{
			title: sliceMessages(ctx.i18n, I18N_NAMESPACE, signInMessages(ctx.i18n?.locale ?? "en"))
				.patientMetaTitle,
		},
	],
});
