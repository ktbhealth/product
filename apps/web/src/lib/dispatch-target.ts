import { findPortalInstance, portalInstanceIdForPath, portalInstances } from "./registry.ts";

/**
 * Root-splat dispatch target (route collapse): every path the static
 * file routes don't claim lands on `/$`; this classifies it into the
 * shell that owns it. Precedence mirrors the deleted file routes:
 *
 * - "/platform" + "/platform/*" → the platform console instance
 *   (portalInstanceIdForPath's contract).
 * - "/portal/<instance>…" where <instance> is a contributed portal →
 *   that portal's shell. Unknown instance ids fall THROUGH to app
 *   pages, so plugins may still own paths like "/portal/login"
 *   (previously a host redirect route).
 * - everything else → app-shell page lookup; "/" is the landing.
 */
type DispatchKind = "landing" | "platform" | "portal" | "app";

export interface DispatchTarget {
	readonly kind: DispatchKind;
	/** Absolute request path — also the page-registry lookup key for
	 * portal contexts ("/platform/x", "/portal/<id>/y"). */
	readonly path: string;
	/** Portal instance id for kind "portal"/"platform". */
	readonly instanceId?: string;
}

export const dispatchTarget = (path: string): DispatchTarget => {
	if (path === "/") return { kind: "landing", path };
	const instanceId = portalInstanceIdForPath(path);
	if (instanceId === "platform") return { kind: "platform", path, instanceId };
	if (instanceId !== undefined && findPortalInstance(portalInstances, instanceId) !== undefined) {
		return { kind: "portal", path, instanceId };
	}
	return { kind: "app", path };
};
