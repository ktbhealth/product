import { siteBuilderEnabled } from "@ktb/builder";
import type { PanelPageContext } from "@ktb/kernel";

import { collectProvidedPages } from "./provided-pages.ts";
import type {
	AdminPageRow,
	LayoutRef,
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

const asLayouts = (data: unknown): readonly LayoutRef[] =>
	Array.isArray(data)
		? data.filter(
				(layout): layout is LayoutRef =>
					typeof layout === "object" &&
					layout !== null &&
					typeof (layout as LayoutRef).id === "number" &&
					typeof (layout as LayoutRef).name === "string" &&
					((layout as LayoutRef).description === null ||
						typeof (layout as LayoutRef).description === "string"),
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
	layouts: readonly LayoutRef[];
	layoutEnabled: boolean;
} => {
	if (typeof data !== "object" || data === null) {
		return {
			pages: [],
			docs: [],
			richTextEnabled: false,
			schemas: [],
			searchSchemaEnabled: false,
			layouts: [],
			layoutEnabled: false,
		};
	}
	const d = data as {
		pages?: unknown;
		docs?: unknown;
		richTextEnabled?: unknown;
		schemas?: unknown;
		searchSchemaEnabled?: unknown;
		layouts?: unknown;
		layoutEnabled?: unknown;
	};
	return {
		pages: asRows(d.pages),
		docs: asDocs(d.docs),
		richTextEnabled: d.richTextEnabled === true,
		schemas: asSchemas(d.schemas),
		searchSchemaEnabled: d.searchSchemaEnabled === true,
		layouts: asLayouts(d.layouts),
		layoutEnabled: d.layoutEnabled === true,
	};
};

/**
 * `panel.pages` component for /platform/pages (T-083): the host
 * dispatcher hands the loader Effect's result (`{ pages, docs }` — every
 * `pages` row, drafts included, plus the rich-text document
 * picker options) as `data`; this wrapper narrows it into the view's
 * props. The admin gate already ran in the page `guard` and inside
 * every `Pages.admin*` method.
 */
export function PagesAdminConsolePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const { pages, docs, richTextEnabled, schemas, searchSchemaEnabled, layouts, layoutEnabled } =
		asData(data);
	// Plugin-contributed pages (P-104): the console lists every reachable
	// descriptor alongside the pages rows, read-only. Enabled
	// state comes from ctx.pluginStates (package-granular, same gate the
	// dispatchers apply); absent it every descriptor is listed.
	const providedPages = collectProvidedPages(
		ctx.plugins,
		ctx.pluginStates === undefined ? undefined : new Set(ctx.pluginStates.enabled),
	);
	// PL-014: the "Open in builder" row action appears only while the
	// site-builder package is installed and enabled.
	const builderEnabled = siteBuilderEnabled(ctx.plugins, ctx.pluginStates?.enabled);
	const props: PagesAdminPageProps = {
		pages,
		providedPages,
		docs,
		richTextEnabled,
		schemas,
		searchSchemaEnabled,
		layouts,
		layoutEnabled,
		builderEnabled,
		i18n: ctx.i18n,
		locale: ctx.locale,
	};
	return <PagesAdminPage {...props} />;
}
