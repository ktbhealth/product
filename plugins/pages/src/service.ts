import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, asc, eq, ne } from "drizzle-orm";

import { Forbidden } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";
import {
	RichTextDeleteHooks,
	type RichTextDeleteHook,
	type RichTextReferencerItem,
} from "@ktb/rich-text/delete-hooks";
import { Schemas } from "@ktb/schemas/service";

import { page, type PageRow } from "./schema.ts";

export type { PageRow } from "./schema.ts";

/**
 * Pages domain service (T-083): DB-backed pages rendered through
 * the generic `pages` contribution — one "/*" wildcard descriptor whose
 * guard/loader call `publishedByPath` with the request path. Admin
 * methods re-check the `PlatformAdmin` gate inside the service (defense
 * in depth — the /platform layout and the server fns gate too); public
 * reads (`publishedByPath`, `navList`) need no principal so anonymous
 * visitors can render published pages.
 */

/** Page path rejected by `normalizePagePath` — surfaced to admin fns as
 * a handled failure (they translate it to `null`, like `Forbidden`). */
export class InvalidPagePath extends Data.TaggedError("InvalidPagePath")<{
	readonly path: string;
}> {}

/** `path` already taken by another page — unique index backstop plus a
 * friendly pre-check so the admin UI gets a handled failure. */
export class DuplicatePagePath extends Data.TaggedError("DuplicatePagePath")<{
	readonly path: string;
}> {}

/** `adminUpdate`/`adminRemove` targeted a missing row. */
export class PageNotFound extends Data.TaggedError("PageNotFound")<{
	readonly id: number;
}> {}

/** `builderJson` is not valid JSON or not a JSON object — same
 * handled-failure contract as `InvalidPagePath`. */
export class InvalidBuilderDoc extends Data.TaggedError("InvalidBuilderDoc")<{
	readonly id: number;
}> {}

/** `richTextId` is not a positive integer — same handled-failure
 * contract as `InvalidPagePath` (admin fns map it to `null`). */
export class InvalidPageInput extends Data.TaggedError("InvalidPageInput")<{
	readonly field: string;
	readonly value: unknown;
}> {}

export type PageError =
	| Forbidden
	| InvalidPagePath
	| DuplicatePagePath
	| PageNotFound
	| InvalidPageInput
	| InvalidBuilderDoc;

/** Admin-facing write payload; booleans/order default when absent and
 * `richTextId` (the @ktb/rich-text document this page renders) defaults
 * to null — the page then renders with no body. `searchSchemaId` (the
 * @ktb/schemas row whose JSON Schema validates the page's URL search
 * params) and `layoutId` (the @ktb/layouts row whose ordered sections
 * compose the page body instead of the single document) follow the
 * same contract. */
export interface PageInput {
	readonly path: string;
	readonly title: string;
	readonly richTextId?: number | null;
	readonly searchSchemaId?: number | null;
	readonly layoutId?: number | null;
	readonly published?: boolean;
	readonly showInNav?: boolean;
	readonly sortOrder?: number;
}

const PATH_MAX = 200;

/**
 * Normalize + validate an admin-supplied page path. Returns the
 * canonical path (leading "/", no trailing slash except root) or null
 * when invalid. Rejected: empty/non-"/" paths, whitespace, URL
 * sigils (`?`, `#`, `*`), overlong paths, and the /platform console
 * namespace — console paths belong to `panel.pages`, an app-context
 * page claiming one is a contract violation the host would ignore.
 */
export const normalizePagePath = (raw: string): string | null => {
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.length > PATH_MAX) return null;
	if (!trimmed.startsWith("/")) return null;
	if (/[\s?#*]/.test(trimmed)) return null;
	const canonical = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
	if (canonical === "/platform" || canonical.startsWith("/platform/")) return null;
	return canonical;
};

/** Same normalization for request paths arriving at the wildcard
 * descriptor — already-URL-decoded by the router; trailing slashes are
 * ignored so "/about/" resolves the "/about" row. */
const normalizeRequestPath = (path: string): string => {
	const trimmed = path.trim();
	return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
};

/** Optional id reference: absent/undefined resolves to null; anything
 * that is not a positive integer is an `InvalidPageInput` (defensive —
 * the wire schema already types it `number | null`). */
const normalizeOptionalId = (
	value: number | null | undefined,
	field: string,
): Effect.Effect<number | null, InvalidPageInput> =>
	value === undefined || value === null
		? Effect.succeed(null)
		: Number.isInteger(value) && value > 0
			? Effect.succeed(value)
			: Effect.fail(new InvalidPageInput({ field, value }));

const normalizeRichTextId = (value: number | null | undefined) =>
	normalizeOptionalId(value, "richTextId");

const normalizeSearchSchemaId = (value: number | null | undefined) =>
	normalizeOptionalId(value, "searchSchemaId");

const normalizeLayoutId = (value: number | null | undefined) =>
	normalizeOptionalId(value, "layoutId");

/** Top-level search-param key an issue path blames — the segment
 * before the first "." or "[" ("filter.tag" → "filter"). "$" and
 * malformed/empty paths blame no single param and are ignored. */
const issueTopLevelKey = (issuePath: string): string | null => {
	if (issuePath === "" || issuePath === "$") return null;
	const end = issuePath.search(/[.[]/);
	const key = end === -1 ? issuePath : issuePath.slice(0, end);
	return key === "" ? null : key;
};

/** Drop every top-level param blamed by at least one validation issue;
 * params the issues don't name pass through untouched. */
const cleanSearchParams = (
	search: Record<string, unknown>,
	issues: readonly { readonly path: string }[],
): Record<string, unknown> => {
	const blamed = new Set<string>();
	for (const issue of issues) {
		const key = issueTopLevelKey(issue.path);
		if (key !== null) blamed.add(key);
	}
	if (blamed.size === 0) return search;
	return Object.fromEntries(Object.entries(search).filter(([key]) => !blamed.has(key)));
};

export class Pages extends Context.Service<
	Pages,
	{
		/** Every page, admin view — path order. */
		readonly adminList: () => Effect.Effect<readonly PageRow[], Forbidden>;
		/** One page by id (full row incl. `builderJson`); null when
		 * missing. Admin-gated — the site-builder editor loads through
		 * this. */
		readonly adminGet: (id: number) => Effect.Effect<PageRow | null, PageError>;
		/** Write the page's `builderJson` (PL-014): `null` clears the
		 * builder document (page falls back to the legacy render path),
		 * a string must parse to a JSON object (the versioned
		 * `{version, data}` wrapper is validated by the writer — this
		 * service only guarantees JSON-object shape). `PageNotFound`
		 * when missing, `InvalidBuilderDoc` on malformed input. */
		readonly adminSetBuilderJson: (
			id: number,
			builderJson: string | null,
		) => Effect.Effect<PageRow, PageError>;
		/** Insert a page; `DuplicatePagePath` when the path is taken. */
		readonly adminCreate: (input: PageInput) => Effect.Effect<PageRow | null, PageError>;
		/** Update a page by id; `PageNotFound` when missing. */
		readonly adminUpdate: (id: number, input: PageInput) => Effect.Effect<PageRow, PageError>;
		/** Delete a page by id; `PageNotFound` when missing. */
		readonly adminRemove: (id: number) => Effect.Effect<void, PageError>;
		/** The published page at `path`, or null — public read used by
		 * the wildcard page's guard/loader. */
		readonly publishedByPath: (path: string) => Effect.Effect<PageRow | null>;
		/** Published pages flagged for nav, ordered for display — public
		 * read used by the app-header chrome component. */
		readonly navList: () => Effect.Effect<readonly PageRow[]>;
		/** Validate `search` against the published page's bound
		 * `searchSchemaId` schema and return the cleaned params.
		 * Infallible passthrough: missing/unpublished page, no bound
		 * schema, absent Schemas service or a validation failure all
		 * return `search` unchanged. */
		readonly validatedSearch: (
			path: string,
			search: Record<string, unknown>,
		) => Effect.Effect<Record<string, unknown>>;
	}
>()("@ktb/pages/Pages") {}

/**
 * Rich-text delete-hook participation: this plugin owns
 * `pages.rich_text_id`, so it reports referencing pages to the
 * delete dialog (`usage`) and executes the admin's choice (`cleanup`).
 * "pages.unlink-unpublish" keeps every page as an unpublished draft
 * with no document; "pages.delete-pages" removes the rows outright.
 * Action ids owned by other plugins are a silent no-op so one dialog
 * choice can cascade through several hooks.
 */
export const pagesRichTextDeleteHook = (db: DbClient): RichTextDeleteHook => ({
	id: "pages",
	usage: (docId) =>
		Effect.promise(() =>
			db
				.select({ id: page.id, title: page.title, path: page.path })
				.from(page)
				.where(eq(page.richTextId, docId)),
		).pipe(Effect.map((rows): readonly RichTextReferencerItem[] => rows)),
	cleanup: (docId, actionId) =>
		actionId === "pages.unlink-unpublish"
			? Effect.promise(() =>
					db
						.update(page)
						.set({ richTextId: null, published: false, updatedAt: new Date() })
						.where(eq(page.richTextId, docId)),
				).pipe(Effect.asVoid)
			: actionId === "pages.delete-pages"
				? Effect.promise(() => db.delete(page).where(eq(page.richTextId, docId))).pipe(
						Effect.asVoid,
					)
				: Effect.void,
});

export const PagesLive = Layer.effect(
	Pages,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		// Optional edge: the rich-text plugin's delete-hook registry is
		// absent when rich-text (or its service layer) is not installed —
		// pages then simply register nothing. The `optionalDeps` edge on
		// pages.services keeps the registry built first when present.
		const deleteHooks = yield* Effect.serviceOption(RichTextDeleteHooks);
		if (Option.isSome(deleteHooks)) {
			yield* deleteHooks.value.register(pagesRichTextDeleteHook(db));
		}
		// Optional edge: the schemas plugin's registry is absent when it
		// (or its service layer) is not installed — validatedSearch then
		// passes params through unchecked. The `optionalDeps` edge on
		// pages.services keeps the registry built first when present.
		const schemaService = yield* Effect.serviceOption(Schemas);

		const requireAdmin = platformAdmin.requireAdmin();

		const byId = (id: number) => eq(page.id, id);
		const byPath = (path: string) => eq(page.path, path);

		return Pages.of({
			adminList: Effect.fn("Pages.adminList")(function* () {
				yield* requireAdmin;
				return yield* Effect.promise(() =>
					db.select().from(page).orderBy(asc(page.sortOrder), asc(page.path)),
				);
			}),
			adminGet: Effect.fn("Pages.adminGet")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() => db.select().from(page).where(byId(id)).limit(1));
				return rows[0] ?? null;
			}),
			adminSetBuilderJson: Effect.fn("Pages.adminSetBuilderJson")(function* (
				id: number,
				builderJson: string | null,
			) {
				yield* requireAdmin;
				if (builderJson !== null) {
					let parsed: unknown;
					try {
						parsed = JSON.parse(builderJson);
					} catch {
						return yield* new InvalidBuilderDoc({ id });
					}
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						return yield* new InvalidBuilderDoc({ id });
					}
				}
				const rows = yield* Effect.promise(() =>
					db.update(page).set({ builderJson, updatedAt: new Date() }).where(byId(id)).returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new PageNotFound({ id });
				return row;
			}),
			adminCreate: Effect.fn("Pages.adminCreate")(function* (input: PageInput) {
				yield* requireAdmin;
				const path = normalizePagePath(input.path);
				if (path === null) return yield* new InvalidPagePath({ path: input.path });
				const existing = yield* Effect.promise(() =>
					db.select({ id: page.id }).from(page).where(byPath(path)).limit(1),
				);
				if (existing.length > 0) return yield* new DuplicatePagePath({ path });
				const richTextId = yield* normalizeRichTextId(input.richTextId);
				const searchSchemaId = yield* normalizeSearchSchemaId(input.searchSchemaId);
				const layoutId = yield* normalizeLayoutId(input.layoutId);
				const rows = yield* Effect.promise(() =>
					db
						.insert(page)
						.values({
							path,
							title: input.title,
							richTextId,
							searchSchemaId,
							layoutId,
							published: input.published ?? false,
							showInNav: input.showInNav ?? false,
							sortOrder: input.sortOrder ?? 0,
							createdAt: new Date(),
							updatedAt: new Date(),
						})
						.returning(),
				);
				return rows[0] ?? null;
			}),
			adminUpdate: Effect.fn("Pages.adminUpdate")(function* (id: number, input: PageInput) {
				yield* requireAdmin;
				const path = normalizePagePath(input.path);
				if (path === null) return yield* new InvalidPagePath({ path: input.path });
				const clash = yield* Effect.promise(() =>
					db
						.select({ id: page.id })
						.from(page)
						.where(and(byPath(path), ne(page.id, id)))
						.limit(1),
				);
				if (clash.length > 0) return yield* new DuplicatePagePath({ path });
				const richTextId = yield* normalizeRichTextId(input.richTextId);
				const searchSchemaId = yield* normalizeSearchSchemaId(input.searchSchemaId);
				const layoutId = yield* normalizeLayoutId(input.layoutId);
				const rows = yield* Effect.promise(() =>
					db
						.update(page)
						.set({
							path,
							title: input.title,
							richTextId,
							searchSchemaId,
							layoutId,
							published: input.published ?? false,
							showInNav: input.showInNav ?? false,
							sortOrder: input.sortOrder ?? 0,
							updatedAt: new Date(),
						})
						.where(byId(id))
						.returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new PageNotFound({ id });
				return row;
			}),
			adminRemove: Effect.fn("Pages.adminRemove")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.delete(page).where(byId(id)).returning({ id: page.id }),
				);
				if (rows.length === 0) return yield* new PageNotFound({ id });
			}),
			publishedByPath: Effect.fn("Pages.publishedByPath")(function* (path: string) {
				const rows = yield* Effect.promise(() =>
					db
						.select()
						.from(page)
						.where(and(eq(page.path, normalizeRequestPath(path)), eq(page.published, true)))
						.limit(1),
				);
				return rows[0] ?? null;
			}),
			navList: Effect.fn("Pages.navList")(function* () {
				return yield* Effect.promise(() =>
					db
						.select()
						.from(page)
						.where(and(eq(page.published, true), eq(page.showInNav, true)))
						.orderBy(asc(page.sortOrder), asc(page.title)),
				);
			}),
			validatedSearch: Effect.fn("Pages.validatedSearch")(function* (
				path: string,
				search: Record<string, unknown>,
			) {
				const rows = yield* Effect.promise(() =>
					db
						.select({ searchSchemaId: page.searchSchemaId })
						.from(page)
						.where(and(eq(page.path, normalizeRequestPath(path)), eq(page.published, true)))
						.limit(1),
				);
				const schemaId = rows[0]?.searchSchemaId ?? null;
				if (schemaId === null || Option.isNone(schemaService)) return search;
				const result = yield* schemaService.value
					.validate(schemaId, search)
					.pipe(
						Effect.catch((error) =>
							Effect.logWarning(
								"Pages.validatedSearch: schema validation failed; passing search through",
								{ path, schemaId, error },
							).pipe(Effect.as(null)),
						),
					);
				if (result === null || result.valid) return search;
				return cleanSearchParams(search, result.issues);
			}),
		});
	}),
);

/**
 * Test-only DDL mirroring the `pages` migration — re-exported for
 * sibling test files (same convention as `AUDIT_TEST_DDL` in
 * plugins/audit). Never used by production code.
 */
export const PAGES_TEST_DDL = `
CREATE TABLE pages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	path TEXT NOT NULL,
	title TEXT NOT NULL,
	rich_text_id INTEGER,
	search_schema_id INTEGER,
	layout_id INTEGER,
	builder_json TEXT,
	published INTEGER NOT NULL DEFAULT 0,
	show_in_nav INTEGER NOT NULL DEFAULT 0,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX pages_path_idx ON pages (path);
CREATE INDEX pages_nav_idx ON pages (published, show_in_nav);
`;
