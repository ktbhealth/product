import {
	collectMiddlewareStages,
	effectiveMiddlewareChain,
	entryEnabled,
	middlewareContinue,
	type MiddlewareContext,
	type MiddlewareStageEntry,
	type MiddlewareVerdict,
} from "@ktb/kernel";

import { cachedEnabledIds } from "./enabled-ids.ts";
import { run, runAs, serverPlugins } from "./platform.ts";
import { builtinMiddlewareStages } from "./middleware-stages.ts";

/**
 * Request-middleware runner (PL-015 / P-110): resolves the effective
 * stage chain for a page-dispatch request — host built-ins plus every
 * plugin-contributed `middleware` stage whose scope claims it — and
 * executes them LINEARLY with early return. Each stage runs as an
 * Effect through the app runtime: unbound (`run`) until the principal
 * stage stores `ctx.state.user`, then bound (`runAs`) so Principal +
 * Tenant are in scope for every later stage — the same binding the
 * page guard/loader get afterwards.
 *
 * Scope of v1: the pipeline runs inside `pageData` (fns.ts) — the
 * per-route dispatch seam where session/enablement/audience policy
 * already lived. Raw HTTP edge stages (rate-limit, captcha on
 * /api/auth/*) are Phase 5 work; the contract supports them but no
 * transport invokes handlers outside page dispatch yet.
 *
 * Enablement: plugin-contributed stages are gated package-granular
 * (P-058) — a disabled plugin's stages are SKIPPED, not denied; the
 * `ktb.plugin.enabled` built-in still owns the page-owner verdict.
 * The predicate is the same `entryEnabled` the MiddlewareStages admin
 * view reports, over the same `PluginStates.enabledIds()` set
 * (TTL-cached per isolate — lib/enabled-ids.ts), so inspector and
 * pipeline agree. Built-ins always run.
 */

let entries: readonly MiddlewareStageEntry[] | undefined;

/** Collected chain, memoized — the registry is static per isolate. */
const allEntries = (): readonly MiddlewareStageEntry[] =>
	(entries ??= collectMiddlewareStages(serverPlugins, builtinMiddlewareStages));

const invokeStage = (
	entry: MiddlewareStageEntry,
	ctx: MiddlewareContext,
): Promise<MiddlewareVerdict> => {
	const effect = entry.handler(ctx);
	const user = ctx.state.user;
	// runAs binds Principal + Tenant for the stage; before the
	// principal stage resolves a user (or on public app pages) stages
	// run unbound — services that need a principal fail Forbidden,
	// exactly like the pre-pipeline dispatch.
	return user === null || user === undefined
		? run(effect)
		: runAs(
				user as { readonly id: string; readonly email?: string; readonly actorId?: string },
				effect,
			);
};

/**
 * Run the effective middleware chain for `ctx`. Returns the first
 * non-`continue` verdict; stage Effect failures propagate to the
 * caller (500), matching how the inline gate failures behaved —
 * except `ktb.portal.audience`, which denies on failure internally.
 */
export const runPageMiddleware = async (ctx: MiddlewareContext): Promise<MiddlewareVerdict> => {
	// `ctx.plugins` is the discovered registry the dispatch edge always
	// supplies; absent, pkg-scoped checks fail closed (same contract as
	// the ktb.plugin.enabled stage).
	const plugins = ctx.plugins ?? [];
	// The enabled-id set resolves lazily — at most once per request,
	// and only when a plugin-contributed stage is actually in scope.
	let enabled: ReadonlySet<string> | undefined;
	for (const entry of effectiveMiddlewareChain(allEntries(), ctx)) {
		const gated =
			entry.origin === "plugin" &&
			!entryEnabled(plugins, (enabled ??= await run(cachedEnabledIds())), entry);
		if (gated) continue;
		const verdict = await invokeStage(entry, ctx);
		if (verdict.type !== "continue") return verdict;
	}
	return middlewareContinue();
};
