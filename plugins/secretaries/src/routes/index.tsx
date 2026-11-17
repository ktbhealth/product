import { redirect } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

import { listSecretariesFn, sessionUserFn } from "../fns.ts";

// A doctor's secretaries moved inside the doctor portal
// (/portal/doctor/secretaries). The old app route stays only as a
// redirect: anonymous visitors to /login, accounts without a doctor
// profile of their own to the profile chooser — like before.
export const Route = createPluginFileRoute("secretaries.routes")("/secretaries/")({
	beforeLoad: async () => {
		if (!(await sessionUserFn())) throw redirect({ href: "/login/doctor" });
	},
	loader: async () => {
		if ((await listSecretariesFn()) === null) throw redirect({ to: "/doctors/select" });
		throw redirect({ href: "/portal/doctor/secretaries" });
	},
	component: () => null,
});
