import { createPluginFileRoute } from "@ktb/server-fns";

import { emailEnabledFn, localeFn } from "../fns.ts";
import { authMessages } from "../i18n.ts";
import { ForgotPasswordPage } from "../views/ForgotPasswordPage.tsx";

/**
 * /forgot-password — asks for the account email and mails a reset
 * link through the auth API. The loader attaches the active locale
 * plus whether this deployment can send email (without it the page
 * shows the unavailable notice instead of a dead form). Gated on
 * `auth.routes` like the sign-in page.
 */
export const Route = createPluginFileRoute("auth.routes")("/forgot-password")({
	loader: async () => ({ locale: await localeFn(), emailEnabled: await emailEnabledFn() }),
	head: ({ loaderData }) => ({
		meta: [{ title: authMessages(loaderData?.locale ?? "en").forgotMetaTitle }],
	}),
	component: function ForgotPasswordRoute() {
		const data = Route.useLoaderData();
		return (
			<ForgotPasswordPage
				locale={data?.locale ?? "en"}
				emailEnabled={data?.emailEnabled ?? false}
			/>
		);
	},
});
