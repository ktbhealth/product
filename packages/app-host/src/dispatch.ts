import { findPortalInstance, portalInstanceIdForPath, type PortalInstanceEntry } from "./pages.ts";

/**
 * Shared page-dispatch contracts (client-safe): the root-splat target
 * classification and the page-data wire result both client dispatchers
 * and server fns speak. Kept dependency-free so `@ktb/app-host/client`
 * and `@ktb/app-host/server` share one source.
 */

/**
 * Root-splat dispatch target (route collapse): every path the static
 * file routes don't claim lands on the host splat route; this
 * classifies it into the shell that owns it. Precedence mirrors the
 * deleted file routes:
 *
 * - "/platform" + "/platform/*" → the platform console instance
 *   (portalInstanceIdForPath's contract).
 * - "/portal/<instance>…" where <instance> is a contributed portal →
 *   that portal's shell. Unknown instance ids fall THROUGH to app
 *   pages, so plugins may still own paths like "/portal/login".
 * - everything else → app-shell page lookup; "/" is the landing.
 */
export type DispatchKind = "landing" | "platform" | "portal" | "app";

export interface DispatchTarget {
	readonly kind: DispatchKind;
	/** Absolute request path — also the page-registry lookup key for
	 * portal contexts ("/platform/x", "/portal/<id>/y"). */
	readonly path: string;
	/** Portal instance id for kind "portal"/"platform". */
	readonly instanceId?: string;
}

/**
 * Classify `path` against the contributed portal instances. `"/"` is
 * always the landing; "/platform*" always the console; a
 * "/portal/<id>" path dispatches to a portal shell only when `<id>`
 * resolves in `portalEntries` — unknown ids fall through to app pages.
 */
export const classifyDispatchTarget = (
	path: string,
	portalEntries: readonly PortalInstanceEntry[],
): DispatchTarget => {
	if (path === "/") return { kind: "landing", path };
	const instanceId = portalInstanceIdForPath(path);
	if (instanceId === "platform") return { kind: "platform", path, instanceId };
	if (instanceId !== undefined && findPortalInstance(portalEntries, instanceId) !== undefined) {
		return { kind: "portal", path, instanceId };
	}
	return { kind: "app", path };
};

/**
 * Result of the page data server fns (`portalPageDataFn`,
 * `appPageDataFn`): a discriminated union so the route loader can tell
 * "page denied/missing" apart from a loader that legitimately returned
 * `null`/`undefined` data. Server-fn errors do not round-trip as
 * router `notFound()`, so denial is data, not a throw — the route maps
 * `notfound` to `throw notFound()`.
 */
export type PageDataResult =
	// `data` is `any`, not `unknown`: loader results are plugin-defined
	// at the kernel boundary ("whatever each page's loader returns"),
	// and strict server-fn typing only accepts the serializable wire
	// shape through `any`.
	| { readonly status: "ok"; readonly data: any }
	| { readonly status: "notfound" }
	| { readonly status: "redirect"; readonly to: string };
