import type { PanelPageContext } from "@ktb/kernel";

import { ThemePage, type ThemePageData } from "./views/ThemePage.tsx";

export type { ThemePageData };

/**
 * /platform/theme panel page (P-082/PL-006 phase 5): the admin theme
 * editor — scope picker, seed editors with live palette preview and
 * contrast report, font config, publish (upsert by scope) and the
 * cookie-based preview flow. `data` is `{ themes }` from the panel
 * loader; `ctx` carries locale + the plugin registry for portal
 * instance suggestions.
 */
export function ThemePlatformPage({
	data,
	ctx,
}: {
	readonly data: unknown;
	readonly ctx: PanelPageContext;
}) {
	return <ThemePage data={data} ctx={ctx} />;
}
