import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /portal/login — legacy patient sign-in, moved to /login/patient.
 * Kept as a redirect for access emails and bookmarks already sent.
 */
export const Route = createFileRoute("/portal/login")({
	beforeLoad: () => {
		throw redirect({ href: "/login/patient" });
	},
	component: () => null,
});
