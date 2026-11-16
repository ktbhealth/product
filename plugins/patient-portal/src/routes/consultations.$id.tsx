import { redirect } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

import { portalSessionFn } from "../fns.ts";

// Legacy consultation deep link, kept as a redirect to its portal
// instance twin. Anonymous visitors keep landing on the patient
// sign-in page; the target page's own guard decides whether the
// consultation is visible, exactly like the old route's 404.
export const Route = createPluginFileRoute("patient-portal.routes")("/portal/consultations/$id")({
	beforeLoad: async ({ params }) => {
		const { signedIn } = await portalSessionFn();
		if (!signedIn) throw redirect({ href: "/login/patient" });
		throw redirect({ href: `/portal/patient/consultations/${params.id}` });
	},
	component: () => null,
});
