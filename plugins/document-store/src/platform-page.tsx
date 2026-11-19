import type { PanelPageContext } from "@ktb/kernel";

import type { CollectionWire, DocumentsPageWire } from "./fns.ts";
import { AllDocumentsPage } from "./views/AllDocumentsPage.tsx";
import { CollectionsAdminPage } from "./views/CollectionsAdminPage.tsx";
import { DocumentsAdminPage } from "./views/DocumentsAdminPage.tsx";

const BASE = "/platform/document-store";

/** First path segment after the base — collection names never contain
 * "/" (see COLLECTION_NAME_RE in collection.ts), so exactly one
 * segment is a valid collection reference; anything deeper is not. */
export const collectionNameFromPath = (path: string): string | null => {
	const rest = path.startsWith(`${BASE}/`) ? path.slice(BASE.length + 1) : "";
	if (rest === "" || rest.includes("/")) return null;
	return rest;
};

const asCollections = (data: unknown): readonly CollectionWire[] =>
	Array.isArray(data)
		? data.filter(
				(row): row is CollectionWire =>
					typeof row === "object" &&
					row !== null &&
					typeof (row as CollectionWire).name === "string" &&
					typeof (row as CollectionWire).fields === "object",
			)
		: [];

interface CollectionPageData {
	readonly collection: CollectionWire | null;
	readonly page: DocumentsPageWire | null;
}

const asPageData = (data: unknown): CollectionPageData => {
	if (typeof data !== "object" || data === null) return { collection: null, page: null };
	const d = data as { collection?: unknown; page?: unknown };
	const collection =
		typeof d.collection === "object" && d.collection !== null
			? (d.collection as CollectionWire)
			: null;
	const page =
		typeof d.page === "object" &&
		d.page !== null &&
		Array.isArray((d.page as DocumentsPageWire).rows)
			? (d.page as DocumentsPageWire)
			: null;
	return { collection, page };
};

/**
 * `panel.pages` component for /platform/document-store: the host
 * dispatcher hands the loader Effect's result (every collection row)
 * as `data`; this wrapper narrows it into the view's props.
 */
export function DocumentStoreCollectionsPage({
	data,
	ctx,
}: {
	data: unknown;
	ctx: PanelPageContext;
}) {
	return (
		<CollectionsAdminPage collections={asCollections(data)} i18n={ctx.i18n} locale={ctx.locale} />
	);
}

interface DocumentsIndexData {
	readonly collections: readonly CollectionWire[] | null;
	readonly page: DocumentsPageWire | null;
}

const asDocumentsIndexData = (data: unknown): DocumentsIndexData => {
	if (typeof data !== "object" || data === null) {
		return { collections: null, page: null };
	}
	const d = data as { collections?: unknown; page?: unknown };
	const page =
		typeof d.page === "object" &&
		d.page !== null &&
		Array.isArray((d.page as DocumentsPageWire).rows)
			? (d.page as DocumentsPageWire)
			: null;
	return {
		collections: Array.isArray(d.collections) ? asCollections(d.collections) : null,
		page,
	};
};

/**
 * `panel.pages` component for /platform/documents: the cross-collection
 * browser. The loader returns the collections list (filter options)
 * plus the first unfiltered documents page.
 */
export function DocumentStoreDocumentsPage({
	data,
	ctx,
}: {
	data: unknown;
	ctx: PanelPageContext;
}) {
	const { collections, page } = asDocumentsIndexData(data);
	if (collections === null || page === null) return null;
	return (
		<AllDocumentsPage
			collections={collections}
			initialPage={page}
			i18n={ctx.i18n}
			locale={ctx.locale}
		/>
	);
}

/**
 * `panel.pages` component for /platform/document-store/*: the loader
 * resolves the collection named by the request path's first segment
 * plus the first documents page; the guard already 404'd unknown
 * names and non-admins.
 */
export function DocumentStoreCollectionPage({
	data,
	ctx,
}: {
	data: unknown;
	ctx: PanelPageContext;
}) {
	const { collection, page } = asPageData(data);
	if (collection === null || page === null) return null;
	return (
		<DocumentsAdminPage
			key={collection.name}
			collection={collection}
			initialPage={page}
			i18n={ctx.i18n}
			locale={ctx.locale}
		/>
	);
}
