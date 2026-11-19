import type { PanelPageContext } from "@ktb/kernel";

import type {
	AdminPageRow,
	PagesAdminPageProps,
	RichTextDocRef,
	SchemaRef,
} from "./views/PagesAdminPage.tsx";
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

const asSchemas = (data: unknown): readonly SchemaRef[] =>
	Array.isArray(data)
		? data.filter(
				(schema): schema is SchemaRef =>
					typeof schema === "object" &&
					schema !== null &&
					typeof (schema as SchemaRef).id === "number" &&
					typeof (schema as SchemaRef).name === "string" &&
					((schema as SchemaRef).description === null ||
						typeof (schema as SchemaRef).description === "string"),
			)
		: [];

const asData = (
	data: unknown,
): {
	pages: readonly AdminPageRow[];
	docs: readonly RichTextDocRef[];
	richTextEnabled: boolean;
	schemas: readonly SchemaRef[];
	searchSchemaEnabled: boolean;
} => {
	if (typeof data !== "object" || data === null) {
		return {
			pages: [],
			docs: [],
			richTextEnabled: false,
			schemas: [],
			searchSchemaEnabled: false,
		};
	}
	const d = data as {
		pages?: unknown;
		docs?: unknown;
		richTextEnabled?: unknown;
		schemas?: unknown;
		searchSchemaEnabled?: unknown;
	};
	return {
		pages: asRows(d.pages),
		docs: asDocs(d.docs),
		richTextEnabled: d.richTextEnabled === true,
		schemas: asSchemas(d.schemas),
		searchSchemaEnabled: d.searchSchemaEnabled === true,
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
	const { pages, docs, richTextEnabled, schemas, searchSchemaEnabled } = asData(data);
	const props: PagesAdminPageProps = {
		pages,
		docs,
		richTextEnabled,
		schemas,
		searchSchemaEnabled,
		i18n: ctx.i18n,
		locale: ctx.locale,
	};
	return <PagesAdminPage {...props} />;
}
