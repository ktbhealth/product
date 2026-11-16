import { redirect } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

import { portalSessionFn } from "../fns.ts";

// Legacy activity page, kept as a redirect: the patient-facing access
// log now lives inside the portal instance at /portal/patient/activity.
// Same funnel as the other legacy paths — anonymous visitors land on
// the patient sign-in page.
export const Route = createPluginFileRoute("patient-portal.routes")("/portal/activity")({
	beforeLoad: async () => {
		const { signedIn } = await portalSessionFn();
		throw redirect({ href: signedIn ? "/portal/patient/activity" : "/login/patient" });
	},
	component: () => null,
});
