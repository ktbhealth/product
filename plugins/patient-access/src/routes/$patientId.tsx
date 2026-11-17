import { redirect } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

import { clinicalPortalFn, doctorAccessFn } from "../fns.ts";

// Legacy access page, kept as a redirect: the surface now lives inside
// the clinical portals (/portal/<instance>/patient-access/<id>). The
// old funnel still applies — anonymous visitors to /login, accounts
// with no doctor profile to the chooser; owners land on the doctor
// instance, delegated secretaries on their own.
export const Route = createPluginFileRoute("patient-access.routes")("/patient-access/$patientId")({
	beforeLoad: async ({ params }) => {
		const access = await doctorAccessFn();
		if (access === "anonymous") throw redirect({ href: "/login/doctor" });
		if (access === "no-doctor") throw redirect({ to: "/doctors/select" });
		const instance = await clinicalPortalFn();
		throw redirect({
			href: `/portal/${instance ?? "doctor"}/patient-access/${params.patientId}`,
		});
	},
	component: () => null,
});
