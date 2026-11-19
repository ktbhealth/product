import type { PageContext } from "@ktb/kernel";
import { RichTextView } from "@ktb/rich-text/views";

/** Wire shape the wildcard loader returns — the published
 * `custom_pages` row plus `content`, the resolved rich-text document
 * value (Plate node array) or null. Only the rendered fields are
 * required; the rest (id, flags, timestamps) rides along unused. */
export interface CustomPageData {
	readonly path?: unknown;
	readonly title?: unknown;
	readonly content?: unknown;
}

const asPage = (data: unknown): { title: string; content: unknown } | null => {
	if (typeof data !== "object" || data === null) return null;
	const d = data as CustomPageData;
	if (typeof d.title !== "string") return null;
	// `content` is the parsed rich-text value — an array of nodes, or
	// null/absent when the page has no document (or the service is off).
	if (d.content !== undefined && d.content !== null && !Array.isArray(d.content)) return null;
	return { title: d.title, content: d.content ?? null };
};

/**
 * `pages` component for DB-stored custom pages (T-083): every custom
 * page renders through this single component — the wildcard descriptor
 * at "/*" supplies per-path `data` from the loader. The body is the
 * rich-text document referenced by the row (`@ktb/rich-text`), rendered
 * by `RichTextView`; `ctx.locale` is available but the page body is
 * user-authored content, so there is no plugin copy to localize.
 */
export function CustomPageView({ data }: { data: unknown; ctx: PageContext }) {
	const page = asPage(data);
	if (page === null) return null;
	return (
		<article className="mx-auto w-full max-w-3xl">
			<h1 className="text-3xl font-bold tracking-tight">{page.title}</h1>
			<div className="mt-6">
				<RichTextView value={page.content} />
			</div>
		</article>
	);
}
