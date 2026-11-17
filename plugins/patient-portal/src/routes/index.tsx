import { redirect } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

import { portalSessionFn } from "../fns.ts";

// Legacy patient-portal home, kept as a redirect: signed-in visitors
// land on the /portal/patient instance, anonymous ones on the patient
// sign-in page — same funnel the portal had before it became a portal
// instance.
export const Route = createPluginFileRoute("patient-portal.routes")("/portal/")({
	beforeLoad: async () => {
		const { signedIn } = await portalSessionFn();
		throw redirect({ href: signedIn ? "/portal/patient" : "/login/patient" });
	},
	component: () => null,
});
