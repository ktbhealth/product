import type { PanelPageContext } from "@ktb/kernel";

import type { AdminPageRow, PagesAdminPageProps, RichTextDocRef } from "./views/PagesAdminPage.tsx";
import { PagesAdminPage } from "./views/PagesAdminPage.tsx";

const asRows = (data: unknown): readonly AdminPageRow[] =>
	Array.isArray(data)
		? data.filter(
				(row): row is AdminPageRow =>
					typeof row === "object" &&
					row !== null &&
					typeof (row as AdminPageRow).id === "number" &&
					typeof (row as AdminPageRow).path === "string",
			)
		: [];

const asDocs = (data: unknown): readonly RichTextDocRef[] =>
	Array.isArray(data)
		? data.filter(
				(doc): doc is RichTextDocRef =>
					typeof doc === "object" &&
					doc !== null &&
					typeof (doc as RichTextDocRef).id === "number" &&
					typeof (doc as RichTextDocRef).title === "string",
			)
		: [];

const asData = (
	data: unknown,
): {
	pages: readonly AdminPageRow[];
	docs: readonly RichTextDocRef[];
	richTextEnabled: boolean;
} => {
	if (typeof data !== "object" || data === null) {
		return { pages: [], docs: [], richTextEnabled: false };
	}
	const d = data as { pages?: unknown; docs?: unknown; richTextEnabled?: unknown };
	return {
		pages: asRows(d.pages),
		docs: asDocs(d.docs),
		richTextEnabled: d.richTextEnabled === true,
	};
};

/**
 * `panel.pages` component for /platform/pages (T-083): the host
 * dispatcher hands the loader Effect's result (`{ pages, docs }` — every
 * `custom_pages` row, drafts included, plus the rich-text document
 * picker options) as `data`; this wrapper narrows it into the view's
 * props. The admin gate already ran in the page `guard` and inside
 * every `CustomPages.admin*` method.
 */
export function PagesAdminConsolePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const { pages, docs, richTextEnabled } = asData(data);
	const props: PagesAdminPageProps = {
		pages,
		docs,
		richTextEnabled,
		i18n: ctx.i18n,
		locale: ctx.locale,
	};
	return <PagesAdminPage {...props} />;
}
