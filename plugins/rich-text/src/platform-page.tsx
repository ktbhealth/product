import type { PanelPageContext } from "@ktb/kernel";

import type { RichTextAdminPageProps, RichTextDocRow } from "./views/RichTextAdminPage.tsx";
import { RichTextAdminPage } from "./views/RichTextAdminPage.tsx";

const asRows = (data: unknown): readonly RichTextDocRow[] =>
	Array.isArray(data)
		? data.filter(
				(row): row is RichTextDocRow =>
					typeof row === "object" &&
					row !== null &&
					typeof (row as RichTextDocRow).id === "number" &&
					typeof (row as RichTextDocRow).title === "string" &&
					typeof (row as RichTextDocRow).updatedAt === "string",
			)
		: [];

/**
 * `panel.pages` component for /platform/rich-text: the host dispatcher
 * hands the loader Effect's result (every `rich_text` row's meta with an
 * ISO `updatedAt`) as `data`; this wrapper narrows it into the view's
 * props. The admin gate already ran in the page `guard` and inside every
 * `RichTexts.admin*` method.
 */
export function RichTextAdminConsolePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const props: RichTextAdminPageProps = {
		docs: asRows(data),
		plugins: ctx.plugins,
		i18n: ctx.i18n,
		locale: ctx.locale,
	};
	return <RichTextAdminPage {...props} />;
}
