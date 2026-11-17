import type { PanelPageContext } from "@ktb/kernel";

import type { I18nPageData } from "./views/I18nPage.tsx";
import { I18nPage } from "./views/I18nPage.tsx";

const EMPTY: I18nPageData = { namespaces: [], locales: [] };

/**
 * `panel.pages` component for /platform/i18n (PL-008 Phase 3): the host
 * dispatcher hands the loader Effect's result as `data`; this wrapper
 * narrows it into the view's props. Guard/loader run server-side in
 * ./index.ts under the session principal.
 */
export function I18nPlatformPage({ data }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<I18nPageData>;
	return (
		<I18nPage
			data={{
				namespaces: Array.isArray(d.namespaces) ? d.namespaces : EMPTY.namespaces,
				locales: Array.isArray(d.locales) ? d.locales : EMPTY.locales,
			}}
		/>
	);
}
