import { siteBuilderEnabled } from "@ktb/builder";
import type { PanelPageContext } from "@ktb/kernel";

import type { LayoutRow, LayoutsAdminPageProps } from "./views/LayoutsAdminPage.tsx";
import { LayoutsAdminPage } from "./views/LayoutsAdminPage.tsx";

const asRows = (data: unknown): readonly LayoutRow[] =>
	Array.isArray(data)
		? data.filter(
				(row): row is LayoutRow =>
					typeof row === "object" &&
					row !== null &&
					typeof (row as LayoutRow).id === "number" &&
					typeof (row as LayoutRow).name === "string" &&
					typeof (row as LayoutRow).updatedAt === "string",
			)
		: [];

/**
 * `panel.pages` component for /platform/layouts: the host dispatcher
 * hands the loader Effect's result (every `layouts` row's meta with an
 * ISO `updatedAt` and the section count) as `data`; this wrapper
 * narrows it into the view's props. The admin gate already ran in the
 * page `guard` and inside every `Layouts.admin*` method.
 */
export function LayoutsAdminConsolePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const props: LayoutsAdminPageProps = {
		layouts: asRows(data),
		plugins: ctx.plugins,
		// PL-014: "Open in builder" row action — only while the
		// site-builder package is installed and enabled.
		builderEnabled: siteBuilderEnabled(ctx.plugins, ctx.pluginStates?.enabled),
		i18n: ctx.i18n,
		locale: ctx.locale,
	};
	return <LayoutsAdminPage {...props} />;
}
