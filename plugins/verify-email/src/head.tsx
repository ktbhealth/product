import { sliceMessages } from "@ktb/i18n";
import type { PageHead } from "@ktb/kernel";

import { I18N_NAMESPACE, verifyEmailMessages } from "./i18n.ts";

/**
 * Page `head` hook shared by the server (./index.ts) and client
 * (./client.ts) manifests — the client/server parity test compares
 * hook references, so both sides must import THIS function (never a
 * per-manifest copy). `ctx.i18n` is the route-scoped DB catalog slice
 * the splat dispatcher resolves from the root match — it already
 * honors `?locale=`; no extra server roundtrip (same contract the
 * retired host route documented).
 */
export const verifyEmailHead: PageHead = (ctx) => ({
	meta: [
		{
			title: sliceMessages(ctx.i18n, I18N_NAMESPACE, verifyEmailMessages(ctx.i18n?.locale ?? "en"))
				.metaTitle,
		},
	],
});
