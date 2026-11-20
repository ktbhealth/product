import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { middlewareContinue, middlewareDeny, packageLive, type MiddlewareStage } from "@ktb/kernel";
import { PortalAudience } from "@ktb/portal";
import { portalAdmits } from "@ktb/portal/rules";
import { PluginStates } from "@ktb/platform/plugin-states";

import { getDoctorUser, getSessionUser } from "./auth.ts";

/**
 * Built-in request-middleware stages (PL-015 / P-110): the page-dispatch
 * gates that used to be inline checks in `pageData` (fns.ts), now
 * expressed as ordered pipeline stages. They are HOST stages — session
 * resolution is a composition-root concern plugin contributions cannot
 * reach — so they arrive via `AppOptions.middleware`, not the plugin
 * registry. The same list is handed to createApp for the
 * MiddlewareStages admin view AND executed by lib/middleware.ts,
 * keeping inspector and pipeline in lockstep.
 *
 * Registry facts stages need (plugin list for package-granular
 * enablement, the resolved portal instance for the audience rule)
 * arrive on `MiddlewareContext` — populated by the dispatch edge from
 * the same `serverPlugins` registry the rest of fns.ts uses, so tests
 * mocking #/lib/platform.ts stay consistent.
 *
 * Order contract: built-ins occupy orders < MIDDLEWARE_ORDER_DEFAULT
 * (100); plugin-contributed stages default after them and page
 * `guard`/`loader` still run last (guard stays the escape hatch).
 */

/**
 * Principal/session resolution (order 10): resolves the session user —
 * or the doctor-resolved acting user when `ctx.subject === "doctor"`
 * (portal instances declaring `subject: "doctor"`) — into
 * `ctx.state.user` for every later stage AND for the guard/loader
 * dispatch (`runAs` binds Principal + Tenant per stage invocation).
 * Portal contexts deny anonymous requests; app contexts stay public.
 */
export const principalStage: MiddlewareStage = {
	id: "ktb.principal.session",
	order: 10,
	handler: (ctx) =>
		Effect.promise(async () => {
			const user = ctx.subject === "doctor" ? await getDoctorUser() : await getSessionUser();
			ctx.state.user = user;
			if (ctx.context === "portal" && user === null) {
				return middlewareDeny("unauthenticated");
			}
			return middlewareContinue();
		}),
};

/**
 * Plugin enablement gate (order 20): the matched route's owning
 * package must be live — package-granular like the CQRS/page gates
 * (a package stays live while ANY member plugin id is enabled;
 * entries without a `pkg` stamp keep the per-id check). Requests
 * without a resolved page owner pass through.
 */
export const pluginEnabledStage: MiddlewareStage = {
	id: "ktb.plugin.enabled",
	order: 20,
	handler: (ctx) =>
		Effect.gen(function* () {
			const owner = ctx.owner;
			if (owner === undefined) return middlewareContinue();
			const states = yield* PluginStates;
			const on =
				owner.pkg === undefined
					? yield* states.isEnabled(owner.pluginId)
					: packageLive(ctx.plugins ?? [], yield* states.enabledIds(), owner.pkg);
			return on ? middlewareContinue() : middlewareDeny("plugin-disabled");
		}),
};

/**
 * Portal audience gate (order 30, portal contexts only): the path's
 * portal instance must have resolved (`ctx.portalInstance`) and the
 * bound principal must satisfy its `audience` rule (absent rule =
 * member). The `superadmin` wildcard admits every instance via
 * `portalAdmits`. Failures deny — same contract the inline check had
 * (a directory or service hiccup hides the page rather than 500ing
 * the dispatch).
 */
export const portalAudienceStage: MiddlewareStage = {
	id: "ktb.portal.audience",
	order: 30,
	scope: { context: "portal" },
	handler: (ctx) =>
		Effect.gen(function* () {
			if (ctx.portalInstance === undefined) return middlewareDeny("unknown-portal");
			const audience = yield* Effect.serviceOption(PortalAudience);
			// portal services plugin absent → check skipped (test/dev
			// compositions); page guards and service authz still apply.
			if (Option.isNone(audience)) return middlewareContinue();
			return portalAdmits(ctx.portalInstance, yield* audience.value.audiences())
				? middlewareContinue()
				: middlewareDeny("portal-audience");
		}).pipe(Effect.catchCause(() => Effect.succeed(middlewareDeny("portal-audience")))),
};

/** The built-in chain — passed to `createApp` for the admin view AND
 * executed by lib/middleware.ts. */
export const builtinMiddlewareStages: readonly MiddlewareStage[] = [
	principalStage,
	pluginEnabledStage,
	portalAudienceStage,
];
