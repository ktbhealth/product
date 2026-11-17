import { redirect } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

import { doctorContextFn } from "../fns.ts";

// Legacy profile-chooser URL, kept as a redirect: the chooser itself is
// a portal page now (/portal/{doctor,secretary}/switch-doctor) and the
// first directory profile auto-resolves, so this route only funnels
// callers to where they belong — anonymous visitors to the doctor
// sign-in, accounts with no doctor side to the patient portal, the
// rest into their clinical portal (owners to doctor, delegated-only
// accounts to secretary). Claims pending invites first, like before.
export const Route = createPluginFileRoute("doctors.routes")("/doctors/select")({
	loader: async () => {
		const context = await doctorContextFn();
		if (!context) throw redirect({ href: "/login/doctor" });
		if (context.profiles.length === 0) throw redirect({ to: "/portal/patient" });
		const instance = context.profiles.some((p) => p.role === "owner") ? "doctor" : "secretary";
		throw redirect({ href: `/portal/${instance}` });
	},
	component: () => null,
});
