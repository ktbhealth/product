import { createPluginFileRoute, pluginEnabledFn } from "@ktb/server-fns";

import { emailEnabledFn, localeFn } from "../fns.ts";
import { authMessages } from "../i18n.ts";
import { LoginPage } from "../views/LoginPage.tsx";

/**
 * /login/doctor — public sign-in/create-account page (moved from
 * apps/web/src/routes/login.tsx, P-062). The loader attaches the
 * active locale so the view resolves its own catalog (plugins cannot
 * import the host's Paraglide runtime) plus whether this deployment
 * can send email, which the sign-up flow needs to pick the next step;
 * `head` uses the same data for the localized document title. Gated
 * on `auth.routes` enable state — a system plugin, so the gate
 * always passes.
 */
export const Route = createPluginFileRoute("auth.routes")("/login/doctor")({
	loader: async () => ({
		locale: await localeFn(),
		emailEnabled: await emailEnabledFn(),
		// The secretary cross-link follows the /login picker's rule
		// (P-058): the invite route, the delegation domain and the
		// clinical portal must all be live — package-granular, like the
		// route gate above.
		secretaryLoginEnabled: (
			await Promise.all(
				["secretaries.routes", "doctors.routes", "clinician.portal"].map((id) =>
					pluginEnabledFn({ data: id }),
				),
			)
		).every(Boolean),
	}),
	head: ({ loaderData }) => ({
		meta: [{ title: authMessages(loaderData?.locale ?? "en").metaTitle }],
	}),
	component: function LoginRoute() {
		const data = Route.useLoaderData();
		return (
			<LoginPage
				locale={data?.locale ?? "en"}
				emailEnabled={data?.emailEnabled ?? false}
				secretaryLoginEnabled={data?.secretaryLoginEnabled ?? true}
			/>
		);
	},
});
