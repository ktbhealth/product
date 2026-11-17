import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /login — bare front door: the patient sign-in is the primary CTA,
 * so it wins the short URL. Clinical entries live at /login/doctor
 * and /login/secretary; legacy /portal/login and /secretaries/login
 * remain as redirects.
 */
export const Route = createFileRoute("/login")({
	beforeLoad: () => {
		throw redirect({ href: "/login/patient" });
	},
	component: () => null,
});
