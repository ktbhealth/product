import type { PanelPageContext } from "@ktb/kernel";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";

import type { PluginStateEntry } from "@ktb/platform/plugin-states";

import { PluginsPage } from "./views/PluginsPage.tsx";
import { RoutesPage, type RouteRow } from "./views/RoutesPage.tsx";

interface ManagerPageData {
	states: readonly PluginStateEntry[];
}

const configObject = (config: unknown): Record<string, unknown> =>
	typeof config === "object" && config !== null && !Array.isArray(config)
		? (config as Record<string, unknown>)
		: {};

/**
 * `panel.pages` component for /platform/plugins (P-058): the host
 * dispatcher hands the loader Effect's result as `data`; this wrapper
 * narrows it into the view's props. `ctx.plugins` is the FULL client
 * registry — the manager must see disabled plugins to re-enable them.
 * The page's own `meta.config` (`cascadeConfirm`) is read back here so
 * the dogfooded config field actually does something.
 */
export function ManagerPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const { states } = data as ManagerPageData;
	const map = new Map(states.map((s) => [s.pluginId, s] as const));
	const self = map.get("manager.panel");
	const cascadeConfirm = configObject(self?.config).cascadeConfirm !== false;
	return (
		// nuqs binds the page's screen state (tab/filters/map view) to
		// TanStack Router search params — links are shareable and
		// reload-safe. Mounted here at the composition boundary so the
		// views stay adapter-agnostic (tests use NuqsTestingAdapter).
		<NuqsAdapter>
			<PluginsPage
				plugins={ctx.plugins}
				states={map}
				i18n={ctx.i18n}
				locale={ctx.locale}
				cascadeConfirm={cascadeConfirm}
			/>
		</NuqsAdapter>
	);
}

const asRouteRows = (data: unknown): readonly RouteRow[] =>
	Array.isArray(data)
		? data.filter(
				(row): row is RouteRow =>
					typeof row === "object" &&
					row !== null &&
					typeof (row as RouteRow).key === "string" &&
					typeof (row as RouteRow).path === "string",
			)
		: [];

/** `panel.pages` component for /platform/routes (PL-011 phase 3):
 * read-only table of the route registry — the loader returns the
 * serializable `RouteDefinition` list, this wrapper narrows it. */
export function RoutesAdminPage({ data }: { data: unknown; ctx: PanelPageContext }) {
	return <RoutesPage routes={asRouteRows(data)} />;
}
