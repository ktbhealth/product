import { doctorContextFn } from "@ktb/doctors/fns";
import { createPluginFileRoute, pluginEnabledFn } from "@ktb/server-fns";

import { emailEnabledFn, localeFn } from "../fns.ts";
import { secretaryMessages } from "../i18n.ts";
import { SecretaryLoginPage, type SecretaryLoginApi } from "../views/index.ts";

const api: SecretaryLoginApi = {
	// Claims pending invites for the caller's verified email first, so a
	// freshly verified secretary sees the doctor right after signing in.
	context: () => doctorContextFn(),
};

/**
 * /login/secretary — the staff entry point the invite email points
 * to. Sign-in leads to the doctor-profile chooser; sign-up creates a
 * plain account (never a doctor profile — unlike the doctor screen)
 * and waits on email verification for the delegation to activate.
 * Gated on `secretaries.routes` like the management page.
 */
export const Route = createPluginFileRoute("secretaries.routes")("/login/secretary")({
	loader: async () => ({
		locale: await localeFn(),
		emailEnabled: await emailEnabledFn(),
		// The doctor cross-link follows the /login picker's rule (P-058):
		// the clinical portal and the doctors package must be live.
		doctorLoginEnabled: (
			await Promise.all(
				["doctors.routes", "clinician.portal"].map((id) => pluginEnabledFn({ data: id })),
			)
		).every(Boolean),
	}),
	head: ({ loaderData }) => ({
		meta: [{ title: secretaryMessages(loaderData?.locale ?? "en").login.metaTitle }],
	}),
	component: function SecretaryLoginRoute() {
		const data = Route.useLoaderData();
		return (
			<SecretaryLoginPage
				locale={data?.locale ?? "en"}
				emailEnabled={data?.emailEnabled ?? false}
				doctorLoginEnabled={data?.doctorLoginEnabled ?? true}
				api={api}
			/>
		);
	},
});
