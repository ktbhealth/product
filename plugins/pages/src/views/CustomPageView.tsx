import { useEffect, useState } from "react";
import { useSearch } from "@tanstack/react-router";

import type { PageContext } from "@ktb/kernel";
import { RichTextView } from "@ktb/rich-text/views";

import { validatePageSearchFn } from "../fns.ts";

/** Wire shape the wildcard loader returns — the published
 * `custom_pages` row plus `content`, the resolved rich-text document
 * value (Plate node array) or null. Only the rendered fields are
 * required; the rest (id, flags, timestamps) rides along unused.
 * `searchSchemaId` marks the page whose URL search params the view
 * validates through `validatePageSearchFn`. */
export interface CustomPageData {
	readonly path?: unknown;
	readonly title?: unknown;
	readonly content?: unknown;
	readonly searchSchemaId?: unknown;
}

const asPage = (
	data: unknown,
): {
	title: string;
	content: unknown;
	path: string;
	searchSchemaId: number | null;
} | null => {
	if (typeof data !== "object" || data === null) return null;
	const d = data as CustomPageData;
	if (typeof d.title !== "string") return null;
	// `content` is the parsed rich-text value — an array of nodes, or
	// null/absent when the page has no document (or the service is off).
	if (d.content !== undefined && d.content !== null && !Array.isArray(d.content)) return null;
	return {
		title: d.title,
		content: d.content ?? null,
		path: typeof d.path === "string" ? d.path : "",
		searchSchemaId: typeof d.searchSchemaId === "number" ? d.searchSchemaId : null,
	};
};

/**
 * `pages` component for DB-stored custom pages (T-083): every custom
 * page renders through this single component — the wildcard descriptor
 * at "/*" supplies per-path `data` from the loader. The body is the
 * rich-text document referenced by the row (`@ktb/rich-text`), rendered
 * by `RichTextView`; `ctx.locale` is available but the page body is
 * user-authored content, so there is no plugin copy to localize.
 *
 * When the row binds a `searchSchemaId`, the view validates the raw
 * URL search through `validatePageSearchFn` (the kernel loader only
 * receives the path, never the query) and exposes the cleaned params
 * as `data-validated-search` on the article — the consumption seam for
 * schema-driven page params. Pages without a schema skip the call.
 */
export function CustomPageView({ data }: { data: unknown; ctx: PageContext }) {
	const page = asPage(data);
	const search = useSearch({ strict: false }) as Record<string, unknown>;
	const [validatedSearch, setValidatedSearch] = useState<Record<string, unknown> | null>(null);
	// The router hands a fresh search object per navigation; the
	// serialized key is the stable effect dependency.
	const searchKey = JSON.stringify(search);
	useEffect(() => {
		if (page === null || page.searchSchemaId === null) {
			setValidatedSearch(null);
			return;
		}
		let cancelled = false;
		validatePageSearchFn({ data: { path: page.path, search } })
			.then((result) => {
				if (!cancelled) setValidatedSearch(result.search);
			})
			.catch(() => {
				// Transport failure — params pass through unchecked.
				if (!cancelled) setValidatedSearch(search);
			});
		return () => {
			cancelled = true;
		};
		// `search` rides `searchKey`; page fields are primitives.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [page?.path, page?.searchSchemaId, searchKey]);
	if (page === null) return null;
	return (
		<article
			className="mx-auto w-full max-w-3xl"
			data-validated-search={validatedSearch === null ? undefined : JSON.stringify(validatedSearch)}
		>
			<h1 className="text-3xl font-bold tracking-tight">{page.title}</h1>
			<div className="mt-6">
				<RichTextView value={page.content} />
			</div>
		</article>
	);
}
