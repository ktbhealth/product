import type { PanelPageContext } from "@ktb/kernel";

import { modelsApi } from "./apis.ts";
import type { ModelCard } from "./models.ts";
import { ModelsPage } from "./views/ModelsPage.tsx";

export function ModelsPanelPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	return (
		<ModelsPage
			models={Array.isArray(data) ? (data as ModelCard[]) : []}
			api={modelsApi}
			locale={ctx.locale}
		/>
	);
}
