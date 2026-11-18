import * as Context from "effect/Context";
import type { Json, JsonObject } from "effect/Schema";

import {
	collectKindContributions,
	GENERIC_CONTRIBUTION_SLOT,
	type ContributionKindDescriptor,
	type Plugin,
	type PluginContribution,
} from "@ktb/kernel";
import { QUERY_OPERATORS, type QueryOperator, type SortTerm } from "@ktb/document-store";

/**
 * View definitions as DATA — the `view.def` contribution kind.
 *
 * A plugin contributes a read view over a document-store collection by
 * putting a `viewDefContribution(def)` entry in its manifest's generic
 * `contributions` array; the payload is plain JSON
 * (`PluginContribution.meta` is `JsonObject`), so no kernel changes
 * are needed. `@ktb/views` owns the kind descriptor, the def
 * validator, the query planner (./plan.ts) and the `/v/*` wildcard
 * page that renders table/cards/detail layouts without per-collection
 * UI code.
 *
 * The wildcard descriptor's loader resolves defs SERVER-side through
 * the `ViewDefinitions` service — the app host collects every
 * contributed definition once at composition time
 * (`collectViewDefinitions` over the topo-ordered registry) and
 * provides them next to `DocumentCollections` (same injection
 * pattern). Unlike `form.def`/`wizard.def`, defs do NOT need a
 * `src/client.ts` mirror to be renderable: the wire payload embeds
 * the resolved def. Emitters may still mirror `contributions` in
 * client.ts when other client surfaces need to enumerate defs.
 */

/** The registered contribution kind for view definitions. */
export const VIEW_DEF_KIND: ContributionKindDescriptor = {
	id: "view.def",
	slot: GENERIC_CONTRIBUTION_SLOT,
	// app-host.server: the /v/* loader resolves defs through
	// ViewDefinitions. app-host.client/plugin-manager: defs are JSON
	// data other client surfaces may enumerate via ctx.plugins.
	consumers: ["app-host.server", "app-host.client", "plugin-manager"],
	ordering: "topo",
};

/** View ids double as URL segments — keep them slug-safe. */
export const VIEW_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mount path prefix every view lives under — the `/v/*` wildcard
 * descriptor claims the whole subtree. */
export const VIEW_PATH_PREFIX = "/v/";

/** A custom `path` must stay inside the wildcard subtree and carry a
 * single slug segment as its key (`/v/reports` → key "reports"). */
export const VIEW_PATH_PATTERN = /^\/v\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Same shape document-store collection names use (mirrored — the
 * constant is private to that package). */
const COLLECTION_NAME_RE = /^[a-z][a-z0-9._-]{0,99}$/;

/** Dotted field path into a record's `data` document. Segments are
 * identifier-shaped (field names) or numeric (array indices, per
 * document-store's getPath); prototype-polluting segments are refused
 * for hygiene even though reads cannot mutate. */
const FIELD_PATH_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

/** URL/search-param names for interactive filters — keep them
 * slug-safe so they round-trip through query strings untouched. */
const FILTER_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Permission strings use the rbac catalog spelling
 * (`"resource.action"`, e.g. `"patient.read"`, `"audit.read"`). */
const PERMISSION_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

export const VIEW_FIELD_FORMATS = ["text", "date", "enum", "ref", "boolean", "json"] as const;
export type ViewFieldFormat = (typeof VIEW_FIELD_FORMATS)[number];

export const VIEW_KINDS = ["table", "cards", "detail"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export const VIEW_CONTEXTS = ["app", "portal"] as const;
export type ViewContext = (typeof VIEW_CONTEXTS)[number];

/**
 * One rendered column/field. `field` is a dotted path into the
 * record's `data`; `format` picks the cell renderer ("ref" resolves
 * the stored id to a display label via `refCollection` — see
 * service.ts for the bounded N+1 contract). `width` is a CSS width
 * (e.g. `"10rem"`) applied to the table column.
 */
export interface ViewField {
	readonly field: string;
	readonly label?: string;
	readonly format?: ViewFieldFormat;
	readonly width?: string;
	/** `format: "ref"` target collection — required for label
	 * resolution; without it the cell falls back to `#<id>`. */
	readonly refCollection?: string;
	/** Dotted path inside the referenced record used as its display
	 * label; defaults to `#<id>`. */
	readonly refLabelField?: string;
}

/**
 * A declared filter — two shapes share this entry:
 *
 * - FIXED: `value` present → the condition `{field: {[op]: value}}` is
 *   always ANDed into every query (scoping filters, e.g. a tenant or
 *   status pin). Not rendered as a control.
 * - INTERACTIVE: `value` absent → the filter bar renders an input
 *   bound to the URL search param `param` (default: `field`); the
 *   user-supplied text is JSON-parsed when possible (so `5`, `true`,
 *   `["a","b"]` keep their types) and applied as `{[op]: parsed}`.
 *
 * `op` comes from the document-store query operator set
 * (`QUERY_OPERATORS`) — the same vocabulary `DocumentStore.find`
 * validates.
 */
export interface ViewFilter {
	readonly field: string;
	readonly op: QueryOperator;
	readonly param?: string;
	readonly label?: string;
	/** Fixed operand (JSON) — presence selects the fixed-vs-interactive
	 * shape; typed `Json` so server-fn serialization checks accept the
	 * def riding inside wire payloads. */
	readonly value?: Json;
}

/** A view definition — the unit plugins contribute. */
export interface ViewDef {
	/** Unique view id — also the default URL key under /v/. */
	readonly id: string;
	/** Display title — an i18n key (`namespace.key`, resolved against
	 * the route's DB catalog slice) or a literal string. */
	readonly title: string;
	/** Document-store collection name the view reads. */
	readonly collection: string;
	/** Optional mount path inside the /v/ subtree (e.g. "/v/reports").
	 * When omitted the view mounts at `/v/<id>`. v1 serves every view
	 * through the single `/v/*` wildcard — `context: "portal"` is
	 * accepted for forward compatibility but all views currently
	 * dispatch through the app shell. */
	readonly path?: string;
	readonly context?: ViewContext;
	/** Optional `"resource.action"` permission (rbac catalog spelling)
	 * required to view — checked through the optional `Permissions`
	 * port; absent service or denied grant hides the view (404). */
	readonly permission?: string;
	readonly kind: ViewKind;
	/** Ordered fields — table columns / card body / detail rows. */
	readonly fields: readonly ViewField[];
	readonly filters?: readonly ViewFilter[];
	readonly sort?: readonly SortTerm[];
	readonly pageSize?: number;
	/** Detail layout — defaults to `fields` when absent. */
	readonly detailFields?: readonly ViewField[];
	/** `cards` kind: the field used as each card's title (falls back
	 * to the first field, then the record id). */
	readonly cardTitleField?: string;
	/** Owning plugin id — stamped from the contributing plugin when the
	 * manifest omits it. */
	readonly owner?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isFieldPath = (value: unknown): value is string =>
	typeof value === "string" &&
	FIELD_PATH_RE.test(value) &&
	!value.split(".").some((seg) => FORBIDDEN_PATH_SEGMENTS.has(seg));

const assertField = (value: unknown, context: string, what: string): ViewField => {
	if (!isRecord(value)) {
		throw new Error(`${context}: ${what} must be an object`);
	}
	const { field, label, format, width, refCollection, refLabelField } = value;
	if (!isFieldPath(field)) {
		throw new Error(`${context}: ${what}.field must be a dotted field path`);
	}
	if (label !== undefined && typeof label !== "string") {
		throw new Error(`${context}: ${what}.label must be a string`);
	}
	if (format !== undefined && !VIEW_FIELD_FORMATS.includes(format as ViewFieldFormat)) {
		throw new Error(`${context}: ${what}.format ${JSON.stringify(format)} is not supported`);
	}
	if (width !== undefined && typeof width !== "string") {
		throw new Error(`${context}: ${what}.width must be a string`);
	}
	if (refCollection !== undefined && !COLLECTION_NAME_RE.test(refCollection as string)) {
		throw new Error(`${context}: ${what}.refCollection is not a valid collection name`);
	}
	if (format === "ref" && refCollection === undefined) {
		throw new Error(`${context}: ${what} uses format "ref" without refCollection`);
	}
	if (refLabelField !== undefined && !isFieldPath(refLabelField)) {
		throw new Error(`${context}: ${what}.refLabelField must be a dotted field path`);
	}
	return value as unknown as ViewField;
};

const assertFieldList = (value: unknown, context: string, what: string): readonly ViewField[] => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${context}: ${what} must be a non-empty array`);
	}
	return value.map((entry, i) => assertField(entry, context, `${what}[${i}]`));
};

const assertFilters = (value: unknown, context: string): readonly ViewFilter[] => {
	if (!Array.isArray(value)) {
		throw new Error(`${context}: filters must be an array`);
	}
	return value.map((entry, i) => {
		const at = `${context}: filters[${i}]`;
		if (!isRecord(entry)) throw new Error(`${at} must be an object`);
		const { field, op, param, label, value: fixed } = entry;
		if (!isFieldPath(field)) throw new Error(`${at}.field must be a dotted field path`);
		if (typeof op !== "string" || !QUERY_OPERATORS.includes(op as QueryOperator)) {
			throw new Error(`${at}.op ${JSON.stringify(op)} is not a document-store operator`);
		}
		if (param !== undefined && (typeof param !== "string" || !FILTER_PARAM_RE.test(param))) {
			throw new Error(`${at}.param must match ${FILTER_PARAM_RE}`);
		}
		if (label !== undefined && typeof label !== "string") {
			throw new Error(`${at}.label must be a string`);
		}
		// `value` is arbitrary JSON (fixed filters) — presence, not
		// type, selects the fixed-vs-interactive shape.
		void fixed;
		return entry as unknown as ViewFilter;
	});
};

const assertSort = (value: unknown, context: string): readonly SortTerm[] => {
	if (!Array.isArray(value)) {
		throw new Error(`${context}: sort must be an array`);
	}
	return value.map((entry, i) => {
		const at = `${context}: sort[${i}]`;
		if (!isRecord(entry)) throw new Error(`${at} must be an object`);
		if (!isFieldPath(entry.field)) throw new Error(`${at}.field must be a dotted field path`);
		if (entry.dir !== "asc" && entry.dir !== "desc") {
			throw new Error(`${at}.dir must be "asc" or "desc"`);
		}
		return entry as unknown as SortTerm;
	});
};

/**
 * Validate an untyped manifest payload as a {@link ViewDef}. Throws
 * with a caller-supplied context string — same packaging-bug contract
 * as `assertFormDefinition`/`assertCollectionDef`.
 */
export const assertViewDef = (value: unknown, context: string): ViewDef => {
	if (!isRecord(value)) {
		throw new Error(`${context}: view definition must be an object`);
	}
	const {
		id,
		title,
		collection,
		path,
		context: viewContext,
		permission,
		kind,
		fields,
		filters,
		sort,
		pageSize,
		detailFields,
		cardTitleField,
		owner,
	} = value;
	if (typeof id !== "string" || !VIEW_ID_PATTERN.test(id)) {
		throw new Error(`${context}: view id must match ${VIEW_ID_PATTERN}`);
	}
	if (typeof title !== "string" || title.length === 0) {
		throw new Error(`${context}: view "${id}" title must be a non-empty string`);
	}
	if (typeof collection !== "string" || !COLLECTION_NAME_RE.test(collection)) {
		throw new Error(`${context}: view "${id}" collection is not a valid collection name`);
	}
	if (path !== undefined) {
		if (typeof path !== "string" || !VIEW_PATH_PATTERN.test(path)) {
			throw new Error(
				`${context}: view "${id}" path must match ${VIEW_PATH_PATTERN} (inside the /v/ subtree)`,
			);
		}
	}
	if (viewContext !== undefined && !VIEW_CONTEXTS.includes(viewContext as ViewContext)) {
		throw new Error(`${context}: view "${id}" context must be "app" or "portal"`);
	}
	if (permission !== undefined) {
		if (typeof permission !== "string" || !PERMISSION_RE.test(permission)) {
			throw new Error(
				`${context}: view "${id}" permission must use the "resource.action" spelling`,
			);
		}
	}
	if (!VIEW_KINDS.includes(kind as ViewKind)) {
		throw new Error(`${context}: view "${id}" kind must be one of ${VIEW_KINDS.join(", ")}`);
	}
	const checked: ViewDef = {
		id,
		title,
		collection,
		...(path === undefined ? {} : { path }),
		...(viewContext === undefined ? {} : { context: viewContext as ViewContext }),
		...(permission === undefined ? {} : { permission }),
		kind: kind as ViewKind,
		fields: assertFieldList(fields, `view "${id}"`, "fields"),
		...(filters === undefined ? {} : { filters: assertFilters(filters, `view "${id}"`) }),
		...(sort === undefined ? {} : { sort: assertSort(sort, `view "${id}"`) }),
		...(pageSize === undefined ? {} : { pageSize: pageSize as number }),
		...(detailFields === undefined
			? {}
			: { detailFields: assertFieldList(detailFields, `view "${id}"`, "detailFields") }),
		...(cardTitleField === undefined ? {} : { cardTitleField: cardTitleField as string }),
		...(owner === undefined ? {} : { owner }),
	} as ViewDef;
	if (checked.pageSize !== undefined) {
		if (!Number.isInteger(checked.pageSize) || checked.pageSize < 1 || checked.pageSize > 500) {
			throw new Error(`${context}: view "${id}" pageSize must be an integer in [1, 500]`);
		}
	}
	if (checked.cardTitleField !== undefined && !isFieldPath(checked.cardTitleField)) {
		throw new Error(`${context}: view "${id}" cardTitleField must be a dotted field path`);
	}
	if (checked.owner !== undefined && typeof checked.owner !== "string") {
		throw new Error(`${context}: view "${id}" owner must be a string`);
	}
	return checked;
};

/**
 * Declare a view. Everything is data — the result is JSON-serializable
 * by construction so it can be dropped into `PluginContribution.meta`
 * unchanged.
 */
export const defineView = (def: ViewDef): ViewDef =>
	assertViewDef(def, `view "${String((def as { id?: unknown }).id)}"`);

/**
 * Build the manifest entry a plugin adds to `contributions`:
 *
 * ```ts
 * contributions: [viewDefContribution(myView)]
 * ```
 *
 * `meta` carries the whole definition (JSON data); `id` is the view id.
 */
export const viewDefContribution = (def: ViewDef): PluginContribution => ({
	kind: VIEW_DEF_KIND.id,
	id: def.id,
	version: "1",
	meta: def as unknown as JsonObject,
});

/** The URL key a def mounts under: the custom `path` segment when
 * present (`/v/reports` → "reports"), else the view id. */
export const viewKey = (def: ViewDef): string =>
	def.path === undefined ? def.id : def.path.slice(VIEW_PATH_PREFIX.length);

/** Mount path for a key — the inverse of {@link viewKey} for links. */
export const viewPathFor = (def: ViewDef): string => `${VIEW_PATH_PREFIX}${viewKey(def)}`;

/** Narrow a collected `PluginContribution` back to a definition.
 * Throws on malformed entries — same packaging-bug contract as
 * {@link assertViewDef}. `owner` falls back to the contributing
 * plugin id. */
export const toViewDefinition = (entry: PluginContribution, pluginId: string): ViewDef => {
	const def = assertViewDef(entry.meta, `plugin "${pluginId}" contribution "${entry.id}"`);
	return def.owner === undefined ? { ...def, owner: pluginId } : def;
};

/**
 * Collect every `view.def` contribution across `plugins` (expected in
 * topo order — pass the output of `orderPlugins`/`ctx.plugins`).
 * Duplicate URL keys are a packaging bug — this throws rather than
 * letting the first contribution silently shadow the rest.
 */
export const collectViewDefinitions = (plugins: readonly Plugin[]): readonly ViewDef[] => {
	const collected = collectKindContributions(plugins, VIEW_DEF_KIND).map(({ plugin, payload }) =>
		toViewDefinition(payload as PluginContribution, plugin.id),
	);
	const seen = new Set<string>();
	for (const def of collected) {
		const key = viewKey(def);
		if (seen.has(key)) {
			throw new Error(`duplicate view key "${key}" contributed by multiple plugins`);
		}
		seen.add(key);
	}
	return collected;
};

export interface ViewPathSegments {
	/** The view's URL key (id or custom path segment). */
	readonly key: string;
	/** Document id for detail mode; null on list paths. */
	readonly docId: number | null;
}

/**
 * Parse a `/v/<key>[/<docId>]` request path into its segments.
 * Returns null for anything outside the wildcard subtree, empty keys,
 * extra segments, or non-numeric doc ids. Trailing slashes and
 * surrounding whitespace are tolerated; query/hash suffixes are
 * stripped (the page loader only ever sees the path portion, but the
 * helper stays total for direct callers).
 */
export const parseViewPath = (path: string): ViewPathSegments | null => {
	const clean = path.trim().split(/[?#]/, 1).join("").replace(/\/+$/, "");
	if (!clean.startsWith(VIEW_PATH_PREFIX)) return null;
	const segments = clean.slice(VIEW_PATH_PREFIX.length).split("/");
	if (segments.length > 2) return null;
	/* v8 ignore next -- split() always yields at least one element */
	const key = segments[0] ?? "";
	if (key === "") return null;
	const docSegment = segments[1];
	if (docSegment === undefined) return { key, docId: null };
	if (!/^\d+$/.test(docSegment)) return null;
	const docId = Number(docSegment);
	if (!Number.isSafeInteger(docId) || docId <= 0) return null;
	return { key, docId };
};

/**
 * The ordered view registry the composition root provides to the
 * `Views` service — the layer @ktb/app-host merges into `core` next to
 * `makePluginStatesLive(plugins)`/`makeDocumentCollections(plugins)`.
 */
export class ViewDefinitions extends Context.Service<
	ViewDefinitions,
	{ readonly views: readonly ViewDef[] }
>()("@ktb/views/ViewDefinitions") {}

/** Build the `ViewDefinitions` service value for a plugin graph. */
export const makeViewDefinitions = (
	plugins: readonly Plugin[],
): { readonly views: readonly ViewDef[] } => ({
	views: collectViewDefinitions(plugins),
});
