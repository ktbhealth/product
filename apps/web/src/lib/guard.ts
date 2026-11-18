import { redirect } from "@tanstack/react-router";

import { getSessionUserFn } from "#/lib/fns.ts";

/**
 * Route guard for authenticated pages: anonymous visitors are sent to
 * a sign-in page (`/login` by default — the front-door role picker;
 * the portal splat resolves the matching /login/<instance>). Data
 * endpoints stay protected independently — server fns and
 * api handlers enforce the session themselves.
 */
export async function requireSession(loginPath = "/login") {
	const user = await getSessionUserFn();
	if (!user) throw redirect({ href: loginPath });
}
