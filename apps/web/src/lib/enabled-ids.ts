import * as Effect from "effect/Effect";

import { PluginStates } from "@ktb/platform/plugin-states";

/**
 * Short-TTL per-isolate cache for `PluginStates.enabledIds` — the
 * service read is an uncached `plugin_state` select (global rows, no
 * tenant scoping) and EVERY page dispatch now resolves it: the
 * middleware enablement gate (lib/middleware.ts) plus the root
 * loader's pluginStatesFn/i18nRouteFn (fns.ts). Admin toggles are the
 * only writers, so the same staleness trade-off as the locale list
 * applies (up to the TTL for an in-flight isolate; no invalidation is
 * wired on the admin write path). Rejections are never cached.
 */
const ENABLED_IDS_TTL_MS = 15_000;

let enabledIdsCache: { readonly at: number; readonly ids: ReadonlySet<string> } | undefined;

/** TTL-cached enabled plugin-id set — see the module doc. */
export const cachedEnabledIds = (): Effect.Effect<ReadonlySet<string>, never, PluginStates> =>
	Effect.gen(function* () {
		const now = Date.now();
		if (enabledIdsCache !== undefined && now - enabledIdsCache.at < ENABLED_IDS_TTL_MS) {
			return enabledIdsCache.ids;
		}
		const states = yield* PluginStates;
		const ids = yield* states.enabledIds();
		enabledIdsCache = { at: now, ids };
		return ids;
	});
