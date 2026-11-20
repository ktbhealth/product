import { BuilderDocument, collectElementKinds } from "@ktb/builder";
import type { PageContext } from "@ktb/kernel";
import { RichTextView } from "@ktb/rich-text/views";

/** Wire shape the wildcard loader returns — the published
 * `pages` row plus `content`, the resolved rich-text document
 * value (Plate node array) or null, `layoutSections`, the resolved
 * layout sections (ordered `{id, title, content}` records) or null,
 * `layoutBuilderJson`, the bound layout's Puck document (PL-014) or
 * null, and `builderJson`, the page's own Puck document or null.
 * Only the rendered fields are required; the rest (id, flags,
 * timestamps) rides along unused. `search` is the loader-cleaned URL
 * search record — present only on schema-bound pages
 * (`searchSchemaId` set), absent otherwise. */
export interface PageData {
	readonly path?: unknown;
	readonly title?: unknown;
	readonly content?: unknown;
	readonly layoutSections?: unknown;
	readonly layoutBuilderJson?: unknown;
	readonly builderJson?: unknown;
	readonly search?: unknown;
}

/** Plain-object records only — the loader emits a record or omits
 * the field; anything else is treated as absent (null-safe for
 * render paths that bypass the loader). */
const asSearchRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** One resolved layout section as the loader emits it — `title` is
 * required, `content` is the slot's rich-text value (the loader only
 * emits resolved sections, so it is always present; anything else is
 * treated as an empty body). */
interface LayoutSectionView {
	readonly title: string;
	readonly content: unknown;
}

/** Layout sections are an array (possibly empty) when the page binds a
 * layout; null/absent/malformed means "no layout" → the single-doc
 * path. An empty array still wins over `content`: a layout-bound page
 * with no resolvable slots renders an empty body, not the fallback
 * document. */
const asLayoutSections = (value: unknown): readonly LayoutSectionView[] | null => {
	if (!Array.isArray(value)) return null;
	return value
		.filter(
			(section): section is LayoutSectionView & { title: string } =>
				typeof section === "object" &&
				section !== null &&
				typeof (section as LayoutSectionView).title === "string",
		)
		.map((section) => ({ title: section.title, content: section.content ?? null }));
};

const asPage = (
	data: unknown,
): {
	title: string;
	content: unknown;
	layoutSections: readonly LayoutSectionView[] | null;
	layoutBuilderJson: string | null;
	builderJson: string | null;
	search: Record<string, unknown> | null;
} | null => {
	if (typeof data !== "object" || data === null) return null;
	const d = data as PageData;
	if (typeof d.title !== "string") return null;
	// `content` is the parsed rich-text value — an array of nodes, or
	// null/absent when the page has no document (or the service is off).
	if (d.content !== undefined && d.content !== null && !Array.isArray(d.content)) return null;
	return {
		title: d.title,
		content: d.content ?? null,
		layoutSections: asLayoutSections(d.layoutSections),
		layoutBuilderJson: typeof d.layoutBuilderJson === "string" ? d.layoutBuilderJson : null,
		builderJson: typeof d.builderJson === "string" ? d.builderJson : null,
		search: asSearchRecord(d.search),
	};
};

/**
 * `pages` component for DB-stored pages (T-083): every DB
 * page renders through this single component — the wildcard descriptor
 * at "/*" supplies per-path `data` from the loader. The body is either
 * the layout's ordered sections (each a title + the rich-text document
 * bound to its slot, resolved by `Layouts.resolveForPage`) when the
 * row binds a `layoutId`, or the single rich-text document referenced
 * by the row — both rendered by `RichTextView`; `ctx.locale` is
 * available but the page body is user-authored content, so there is no
 * plugin copy to localize.
 *
 * When the row binds a `searchSchemaId`, the loader has already
 * validated the URL search through `Pages.validatedSearch` —
 * the cleaned params arrive as `data.search` and are exposed as
 * `data-validated-search` on the article, the consumption seam for
 * schema-driven page params. Pages without a schema carry no `search`
 * field and skip the attribute.
 */
export function PageView({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const page = asPage(data);
	if (page === null) return null;
	// Builder precedence (PL-014): the page's own Puck document wins;
	// then the bound layout's Puck document; then the legacy
	// layout-sections / single-document path. `collectElementKinds`
	// reads the client elementKinds manifest off ctx.plugins — the
	// same registry the /platform/components catalog compiles.
	const elementKinds = collectElementKinds(ctx.plugins);
	const builderJson = page.builderJson ?? page.layoutBuilderJson;
	return (
		<article
			className="mx-auto w-full max-w-3xl"
			data-validated-search={page.search === null ? undefined : JSON.stringify(page.search)}
		>
			<h1 className="text-3xl font-bold tracking-tight">{page.title}</h1>
			{builderJson !== null ? (
				<div className="mt-6">
					<BuilderDocument builderJson={builderJson} elementKinds={elementKinds} />
				</div>
			) : page.layoutSections !== null ? (
				<div className="mt-6 flex flex-col gap-8">
					{page.layoutSections.map((section, index) => (
						<section key={index}>
							<h2 className="text-xl font-semibold tracking-tight">{section.title}</h2>
							<div className="mt-3">
								<RichTextView value={section.content} />
							</div>
						</section>
					))}
				</div>
			) : (
				<div className="mt-6">
					<RichTextView value={page.content} />
				</div>
			)}
		</article>
	);
}
