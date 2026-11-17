import { redirect } from "@tanstack/react-router";

import { createPluginFileRoute } from "@ktb/server-fns";

/**
 * /secretaries/login — legacy secretary sign-in, moved to
 * /login/secretary. Kept as a redirect for invite emails already
 * sent. Gated on `secretaries.routes` like the canonical page.
 */
export const Route = createPluginFileRoute("secretaries.routes")("/secretaries/login")({
	beforeLoad: () => {
		throw redirect({ href: "/login/secretary" });
	},
	component: () => null,
});
