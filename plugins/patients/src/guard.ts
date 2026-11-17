import { redirect } from "@tanstack/react-router";

import { clinicalPortalFn, doctorAccessFn } from "./fns.ts";

/**
 * The patients workspace lives inside the clinical portals now — the
 * flat /patients URLs are kept only as funnels: anonymous visitors go
 * to the doctor sign-in, signed-in accounts with no doctor profile to
 * the chooser, everyone else to the matching surface under their
 * portal instance. Data endpoints stay protected independently —
 * server fns and api handlers enforce the acting doctor themselves.
 */
export async function redirectToPortal(subpath: string): Promise<never> {
	const access = await doctorAccessFn();
	if (access === "anonymous") throw redirect({ href: "/login/doctor" });
	if (access === "no-doctor") throw redirect({ to: "/doctors/select" });
	const instance = await clinicalPortalFn();
	throw redirect({ href: `/portal/${instance ?? "doctor"}${subpath}` });
}
