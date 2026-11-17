import type { PanelPageContext } from "@ktb/kernel";
import type { PluginStateEntry } from "@ktb/platform/plugin-states";

import { DashboardPage } from "./views/DashboardPage.tsx";

interface DashboardData {
	readonly pluginStates?: readonly PluginStateEntry[];
}

/**
 * `panel.pages` component for /platform (P-050): the host dispatcher
 * hands the loader Effect's result as `data` and the discovered plugin
 * registry as `ctx.plugins` — the dashboard's plugin-cards section
 * needs it and plugins cannot import the app host themselves.
 * `ctx.locale` feeds the view's catalog. Domain data no longer flows
 * through the loader: each domain plugin contributes its own
 * portal.dashboard.* chrome slots, fed by contexts the /platform
 * layout provides (T-125).
 */
export function DashboardPlatformPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const d = data as DashboardData;
	return (
		<DashboardPage
			plugins={ctx.plugins}
			pluginStates={d.pluginStates}
			i18n={ctx.i18n}
			locale={ctx.locale}
			user={ctx.user}
		/>
	);
}
