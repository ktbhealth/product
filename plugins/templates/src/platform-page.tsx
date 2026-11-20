import type { PanelPageContext } from "@ktb/kernel";

import type {
	TemplateKindInfo,
	TemplateRow,
	TemplatesAdminPageProps,
} from "./views/TemplatesAdminPage.tsx";
import { TemplatesAdminPage } from "./views/TemplatesAdminPage.tsx";

const asRows = (data: unknown): readonly TemplateRow[] => {
	const rows = typeof data === "object" && data !== null ? (data as { rows?: unknown }).rows : null;
	return Array.isArray(rows)
		? rows.filter(
				(row): row is TemplateRow =>
					typeof row === "object" &&
					row !== null &&
					typeof (row as TemplateRow).id === "number" &&
					typeof (row as TemplateRow).kind === "string" &&
					typeof (row as TemplateRow).name === "string" &&
					typeof (row as TemplateRow).updatedAt === "string",
			)
		: [];
};

const asKinds = (data: unknown): readonly TemplateKindInfo[] => {
	const kinds =
		typeof data === "object" && data !== null ? (data as { kinds?: unknown }).kinds : null;
	return Array.isArray(kinds)
		? kinds.filter(
				(kind): kind is TemplateKindInfo =>
					typeof kind === "object" &&
					kind !== null &&
					typeof (kind as TemplateKindInfo).kind === "string" &&
					typeof (kind as TemplateKindInfo).label === "string",
			)
		: [];
};

/**
 * `panel.pages` component for /platform/templates: the host dispatcher
 * hands the loader Effect's result (`{rows, kinds}` — every template
 * meta with ISO timestamps plus the registered kind ids/labels) as
 * `data`; this wrapper narrows it into the view's props. The admin
 * gate already ran in the page `guard` and inside every `Templates.*`
 * method.
 */
export function TemplatesAdminConsolePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const props: TemplatesAdminPageProps = {
		rows: asRows(data),
		kinds: asKinds(data),
		i18n: ctx.i18n,
		locale: ctx.locale,
	};
	return <TemplatesAdminPage {...props} />;
}
