import {
	enabledIdSet,
	entryEnabled,
	findPortalInstance,
	packageLive,
	portalInstances,
	type PluginStatesResult,
} from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";

/** The portal instance each sign-in flow lands on. */
export type LoginPortal = "patient" | "doctor" | "secretary";

// Packages beyond the destination instance that each flow needs live
// (P-058): /login/doctor creates the doctor profile via doctors fns;
// /login/secretary is route-gated on secretaries and claims pending
// invites through doctorContextFn.
const LOGIN_ROLE_PKGS: Record<LoginPortal, readonly string[]> = {
	patient: [],
	doctor: ["doctors"],
	secretary: ["secretaries", "doctors"],
};

/**
 * The sign-in flows a deployment actually offers. A role is live when
 * its destination portal instance passes the same `entryEnabled` gate
 * the /portal/$instance dispatcher applies, and every extra package
 * above is live — package-granular, like every P-058 surface. The
 * /login picker and the cross-links on each sign-in page share this
 * rule so a flow is offered everywhere or nowhere.
 */
export const visibleLoginPortals = (states: PluginStatesResult): ReadonlySet<LoginPortal> => {
	const enabled = enabledIdSet(states);
	const visible = new Set<LoginPortal>();
	for (const portal of Object.keys(LOGIN_ROLE_PKGS) as LoginPortal[]) {
		const entry = findPortalInstance(portalInstances, portal);
		if (entry === undefined || !entryEnabled(plugins, enabled, entry)) continue;
		if (!LOGIN_ROLE_PKGS[portal].every((pkg) => packageLive(plugins, enabled, pkg))) continue;
		visible.add(portal);
	}
	return visible;
};
