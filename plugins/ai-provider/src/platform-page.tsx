import type { PanelPageContext } from "@ktb/kernel";

import type { AgentLinkRow, EndpointCard } from "./index.ts";
import { AgentsPage } from "./views/AgentsPage.tsx";
import { EndpointsPage } from "./views/EndpointsPage.tsx";

/** Panel wrapper — the host dispatcher hands the loader Effect's
 * result as `data`; the wrapper narrows it into the view's props. */
export function EndpointsPanelPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	return (
		<EndpointsPage
			endpoints={Array.isArray(data) ? (data as EndpointCard[]) : []}
			locale={ctx.locale}
		/>
	);
}

/** Agents panel wrapper — the loader packs `{links, endpoints}`;
 * anything else narrows to empty lists (F4). */
export function AgentsPanelPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const payload =
		typeof data === "object" && data !== null
			? (data as { links?: unknown; endpoints?: unknown })
			: {};
	return (
		<AgentsPage
			links={Array.isArray(payload.links) ? (payload.links as AgentLinkRow[]) : []}
			endpoints={Array.isArray(payload.endpoints) ? (payload.endpoints as EndpointCard[]) : []}
			locale={ctx.locale}
		/>
	);
}
