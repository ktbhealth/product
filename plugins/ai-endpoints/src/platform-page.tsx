import type { PanelPageContext } from "@ktb/kernel";

import type { EndpointCard } from "./index.ts";
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
