import type { PanelPageContext } from "@ktb/kernel";

import { FontProvidersPage, type FontProvidersPageData } from "./views/FontProvidersPage.tsx";
import { FontsPage, type FontsPageData } from "./views/FontsPage.tsx";

export type { FontProvidersPageData, FontsPageData };

/**
 * /platform/fonts/providers panel page: configured font sources —
 * add (kind picker from the registered adapters), enable toggle,
 * per-provider sync and delete. `data` is `{ providers, kinds }` from
 * the panel loader.
 */
export function FontProvidersPlatformPage({
	data,
	ctx,
}: {
	readonly data: unknown;
	readonly ctx: PanelPageContext;
}) {
	return <FontProvidersPage data={data} ctx={ctx} />;
}

/**
 * /platform/fonts panel page: the synced family catalog with a
 * provider filter and sync actions. `data` is `{ providers, families }`
 * from the panel loader.
 */
export function FontsPlatformPage({
	data,
	ctx,
}: {
	readonly data: unknown;
	readonly ctx: PanelPageContext;
}) {
	return <FontsPage data={data} ctx={ctx} />;
}
