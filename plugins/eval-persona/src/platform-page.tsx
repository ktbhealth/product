import type { PanelPageContext } from "@ktb/kernel";

import type { EndpointCard } from "@ktb/ai-endpoints";

import type { InstanceCard, PersonaDefCard } from "./index.ts";
import { InstancesPage } from "./views/InstancesPage.tsx";
import { PersonasPage } from "./views/PersonasPage.tsx";

/** Panel wrappers — the host dispatcher hands the loader Effect's
 * result as `data`; wrappers narrow it into each view's props. */
export function PersonasPanelPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	return (
		<PersonasPage
			defs={Array.isArray(data) ? (data as PersonaDefCard[]) : []}
			locale={ctx.locale}
		/>
	);
}

export function InstancesPanelPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const d =
		typeof data === "object" && data !== null
			? (data as {
					instances?: InstanceCard[];
					defs?: PersonaDefCard[];
					endpoints?: EndpointCard[];
				})
			: {};
	return (
		<InstancesPage
			instances={d.instances ?? []}
			defs={d.defs ?? []}
			endpoints={d.endpoints ?? []}
			locale={ctx.locale}
		/>
	);
}
