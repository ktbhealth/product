import type { PanelPageContext } from "@ktb/kernel";

import type { KvAdminPageData } from "./views/KvAdminPage.tsx";
import { KvAdminPage } from "./views/KvAdminPage.tsx";

const EMPTY: KvAdminPageData = { items: [], total: 0, namespaces: [] };

const asEntry = (row: unknown): KvAdminPageData["items"][number] | null => {
	if (typeof row !== "object" || row === null) return null;
	const r = row as Record<string, unknown>;
	return typeof r.namespace === "string" &&
		typeof r.key === "string" &&
		typeof r.version === "number"
		? (r as unknown as KvAdminPageData["items"][number])
		: null;
};

const asNamespace = (row: unknown): KvAdminPageData["namespaces"][number] | null => {
	if (typeof row !== "object" || row === null) return null;
	const r = row as Record<string, unknown>;
	return typeof r.namespace === "string" && typeof r.count === "number"
		? { namespace: r.namespace, count: r.count }
		: null;
};

/**
 * `panel.pages` component for /platform/kv (P-090): the host
 * dispatcher hands the loader Effect's result (`{ items, total,
 * namespaces }` — first page of entries across all scopes plus the
 * namespace overview) as `data`; this wrapper narrows it into the
 * view's props. The admin gate already ran in the page `guard` and
 * inside every `KvAdmin` method.
 */
export function KvAdminConsolePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<KvAdminPageData>;
	const items = Array.isArray(d.items)
		? d.items.map(asEntry).filter((e): e is NonNullable<typeof e> => e !== null)
		: EMPTY.items;
	const namespaces = Array.isArray(d.namespaces)
		? d.namespaces.map(asNamespace).filter((n): n is NonNullable<typeof n> => n !== null)
		: EMPTY.namespaces;
	return (
		<KvAdminPage
			data={{
				items,
				total: typeof d.total === "number" ? d.total : items.length,
				namespaces,
			}}
			i18n={ctx.i18n}
			locale={ctx.locale}
		/>
	);
}
