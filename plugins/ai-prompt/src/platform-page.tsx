import type { PanelPageContext } from "@ktb/kernel";

import { promptsApi } from "./apis.ts";
import type { PromptCard } from "./prompts.ts";
import { PromptsPage } from "./views/PromptsPage.tsx";

export function PromptsPanelPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	return (
		<PromptsPage
			prompts={Array.isArray(data) ? (data as PromptCard[]) : []}
			api={promptsApi}
			locale={ctx.locale}
		/>
	);
}
