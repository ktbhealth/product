import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import {
	entryEnabled,
	middlewareStageInfo,
	orderMiddlewareEntries,
	type MiddlewareRouteInfo,
	type MiddlewareScope,
	type MiddlewareStageEntry,
	type PackagedPlugin,
} from "@ktb/kernel";

import { PluginStates } from "./plugin-states.ts";

/**
 * Middleware registry read port (PL-015 / P-110): the serializable
 * view of the request-middleware pipeline for admin surfaces — the
 * /platform/middleware page reads `stages()` (ordered, with the
 * package-granular `enabled` flag resolved live against
 * `PluginStates`, same contract as page/CQRS gates) and `routes()`
 * (the registered page paths the per-route chain inspector resolves
 * against). Stage handlers never cross this boundary — only display
 * metadata does.
 *
 * Provided unconditionally by the composition root (@ktb/app-host)
 * from the discovered plugin registry plus the app's built-in stages;
 * consumers degrade via `Effect.serviceOption`.
 */

/** One stage row: display metadata + live enablement. */
export interface MiddlewareStageRow {
	readonly id: string;
	readonly order?: number;
	readonly scope?: MiddlewareScope;
	readonly pluginId: string;
	readonly pkg?: string;
	readonly origin: "plugin" | "builtin";
	readonly enabled: boolean;
}

export interface MiddlewareStagesShape {
	/** Every collected stage in effective run order (order → plugin
	 * topo → declaration), each flagged with its current package-
	 * granular enablement. Built-ins report `enabled: true` — host
	 * infrastructure is not disableable. Requires `PluginStates`
	 * (core provides it) for the live enablement read. */
	readonly stages: () => Effect.Effect<readonly MiddlewareStageRow[], never, PluginStates>;
	/** Registered page routes (path + dispatch context + descriptor
	 * routeKey) the inspector resolves effective chains for. */
	readonly routes: () => Effect.Effect<readonly MiddlewareRouteInfo[]>;
}

export class MiddlewareStages extends Context.Service<MiddlewareStages, MiddlewareStagesShape>()(
	"@ktb/platform/MiddlewareStages",
) {}

/**
 * Build the registry view over the collected stage entries. `plugins`
 * is the discovered registry (for package-granular membership);
 * `stages` the output of `collectMiddlewareStages` (handlers are
 * stripped here — `middlewareStageInfo` keeps only display fields);
 * `routes` the page-registry projection the host computed at
 * composition time.
 */
export const makeMiddlewareStages = (input: {
	readonly plugins: readonly PackagedPlugin[];
	readonly stages: readonly MiddlewareStageEntry[];
	readonly routes: readonly MiddlewareRouteInfo[];
}): MiddlewareStagesShape => {
	// Effective run order is static composition data — sort once.
	const ordered = orderMiddlewareEntries(input.stages);
	return {
		stages: () =>
			Effect.gen(function* () {
				const states = yield* PluginStates;
				const enabled = yield* states.enabledIds();
				return ordered.map((entry) => {
					// Sort internals stay server-side — the row is the
					// wire/display contract.
					const { pluginIndex: _pi, entryIndex: _ei, ...info } = middlewareStageInfo(entry);
					return {
						...info,
						enabled:
							entry.origin === "builtin" ? true : entryEnabled(input.plugins, enabled, entry),
					};
				});
			}),
		routes: () => Effect.succeed(input.routes),
	};
};
