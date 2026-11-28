import type { MiddlewareContext, MiddlewareVerdict } from "@ktb/kernel";

import { cachedEnabledIds } from "./enabled-ids.ts";
import { run, runAs, serverPlugins } from "./platform.ts";
import { builtinMiddlewareStages } from "./middleware-stages.ts";
import { makePageMiddlewareRunner } from "@ktb/app-host/server";

/**
 * Request-middleware runner binding (PL-015 / P-110): the generic
 * pipeline lives in @ktb/app-host/server (`makePageMiddlewareRunner`);
 * this module binds it to the app runtime — the discovered server
 * registry, the host built-in stages (lib/middleware-stages.ts) and
 * the TTL-cached enabled-id set (lib/enabled-ids.ts).
 *
 * Scope of v1: the pipeline runs inside `pageData` (fns.ts) — the
 * per-route dispatch seam where session/enablement/audience policy
 * already lived. Raw HTTP edge stages (rate-limit, captcha on
 * /api/auth/*) are Phase 5 work; the contract supports them but no
 * transport invokes handlers outside page dispatch yet.
 */

const runMiddleware = makePageMiddlewareRunner({
	plugins: serverPlugins,
	builtinStages: builtinMiddlewareStages,
	enabledIds: cachedEnabledIds(),
	run,
	runAs,
});

/**
 * Run the effective middleware chain for `ctx`. Returns the first
 * non-`continue` verdict; stage Effect failures propagate to the
 * caller (500), matching how the inline gate failures behaved —
 * except `ktb.portal.audience`, which denies on failure internally.
 */
export const runPageMiddleware = (ctx: MiddlewareContext): Promise<MiddlewareVerdict> =>
	runMiddleware(ctx);
