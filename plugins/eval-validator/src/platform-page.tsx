import type { PanelPageContext } from "@ktb/kernel";

import type { BatchSummary } from "./index.ts";
import { EvalValidatorPage as View } from "./views/EvalValidatorPage.tsx";

/**
 * `panel.pages` component for /platform/eval (P-081): the host
 * dispatcher hands the loader Effect's result as `data`; this wrapper
 * narrows it into the view's props (the permission gate already ran in
 * the page `guard` and inside the service). `ctx.locale` feeds the
 * view's catalog.
 */
export function EvalValidatorPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	return (
		<View
			batches={Array.isArray(data) ? (data as BatchSummary[]) : []}
			i18n={ctx.i18n}
			locale={ctx.locale}
		/>
	);
}
