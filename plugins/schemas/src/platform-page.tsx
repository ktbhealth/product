import type { PanelPageContext } from "@ktb/kernel";

import type { SchemaRow, SchemasAdminPageProps } from "./views/SchemasAdminPage.tsx";
import { SchemasAdminPage } from "./views/SchemasAdminPage.tsx";

const asRows = (data: unknown): readonly SchemaRow[] =>
	Array.isArray(data)
		? data.filter(
				(row): row is SchemaRow =>
					typeof row === "object" &&
					row !== null &&
					typeof (row as SchemaRow).id === "number" &&
					typeof (row as SchemaRow).name === "string" &&
					typeof (row as SchemaRow).updatedAt === "string",
			)
		: [];

/**
 * `panel.pages` component for /platform/schemas: the host dispatcher
 * hands the loader Effect's result (every `schemas` row's meta with an
 * ISO `updatedAt`) as `data`; this wrapper narrows it into the view's
 * props. The admin gate already ran in the page `guard` and inside every
 * `Schemas.admin*` method.
 */
export function SchemasAdminConsolePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const props: SchemasAdminPageProps = {
		schemas: asRows(data),
		i18n: ctx.i18n,
		locale: ctx.locale,
	};
	return <SchemasAdminPage {...props} />;
}
