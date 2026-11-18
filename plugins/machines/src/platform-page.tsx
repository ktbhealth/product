import type { PanelPageContext } from "@ktb/kernel";

import { machinesApi } from "./apis.ts";
import type { MachineCard } from "./machines.ts";
import { MachinesPage } from "./views/MachinesPage.tsx";

export function MachinesPanelPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	return (
		<MachinesPage
			machines={Array.isArray(data) ? (data as MachineCard[]) : []}
			api={machinesApi}
			locale={ctx.locale}
		/>
	);
}
