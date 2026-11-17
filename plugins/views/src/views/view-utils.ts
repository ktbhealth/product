import type { PageI18nSlice } from "@ktb/kernel";

import type { ViewField, ViewFilter } from "../definition.ts";
import { filterParam } from "../plan.ts";

/**
 * Pure helpers shared by the view components: dotted-path reads,
 * value formatting per field format, URL search-param encoding for
 * declared filters, and i18n-key-or-literal resolution. Kept UI-free
 * (no React) so every rule is unit-testable.
 */

const EMPTY_CELL = "—";

/** Dotted-path read over a record's `data` document — same semantics
 * as document-store's query `getPath` (numeric segments index into
 * arrays), mirrored locally so this module stays free of the store's
 * server graph for the client bundle. */
export const getPath = (data: unknown, path: string): unknown => {
	let current: unknown = data;
	for (const segment of path.split(".")) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			current = current[index];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
};

const JSON_PREVIEW_MAX = 80;

/** Scalar → display text (no refs/locale) — used for ref target
 * labels and as the fallback inside {@link formatViewValue}. */
export const viewScalarText = (value: unknown): string => {
	if (value === undefined || value === null) return EMPTY_CELL;
	if (typeof value === "object") {
		const text = JSON.stringify(value);
		return text.length > JSON_PREVIEW_MAX ? `${text.slice(0, JSON_PREVIEW_MAX)}…` : text;
	}
	return String(value as string | number | boolean);
};

/**
 * Format one cell/field value for display.
 *
 * - `date`: epoch-ms numbers render via `toLocaleString(locale)`
 *   (document-store `date` fields store ms); anything else prints raw.
 * - `boolean`: `true`/`false` literals.
 * - `ref`: looks up `"<refCollection>:<id>"` in `refs`; falls back to
 *   `#<id>` when the target wasn't resolved (missing, capped, or no
 *   `refCollection` declared).
 * - `enum`/`text`: scalar text.
 * - `json`: compact JSON, truncated at {@link JSON_PREVIEW_MAX}.
 */
export const formatViewValue = (
	field: ViewField,
	value: unknown,
	options: { readonly locale?: string; readonly refs?: Readonly<Record<string, string>> } = {},
): string => {
	if (value === undefined || value === null) return EMPTY_CELL;
	switch (field.format) {
		case "date":
			return typeof value === "number" && Number.isFinite(value)
				? new Date(value).toLocaleString(options.locale)
				: String(value as string);
		case "boolean":
			return value === true ? "true" : "false";
		case "ref": {
			if (typeof value !== "number") return viewScalarText(value);
			const label =
				field.refCollection === undefined
					? undefined
					: options.refs?.[`${field.refCollection}:${value}`];
			return label ?? `#${value}`;
		}
		case "json":
			return viewScalarText(value);
		default:
			return viewScalarText(value);
	}
};

/** Last `.`-separated segment of a field path — split() always yields
 * at least one element, so the fallback is only for the type system. */
const lastSegment = (path: string): string => {
	const parts = path.split(".");
	/* v8 ignore next -- split() always yields at least one element */
	return parts[parts.length - 1] ?? path;
};

/** Human-readable field label: explicit `label`, else the last path
 * segment (so `patient.name` reads "name"). */
export const fieldLabel = (field: ViewField): string => field.label ?? lastSegment(field.field);

/** Human-readable filter label: explicit `label`, else the field's
 * last segment. */
export const filterLabel = (filter: ViewFilter): string =>
	filter.label ?? lastSegment(filter.field);

/**
 * Read declared interactive-filter values out of a URL search string
 * (`"?a=1&b=2"` or `"a=1&b=2"`). Only params the def declares are
 * returned — undeclared query params never reach the store.
 */
export const filterValuesFromSearch = (
	def: { readonly filters?: readonly ViewFilter[] },
	search: string,
): Record<string, string> => {
	const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
	const values: Record<string, string> = {};
	for (const filter of def.filters ?? []) {
		if ("value" in filter) continue;
		const param = filterParam(filter);
		const raw = params.get(param);
		if (raw !== null) values[param] = raw;
	}
	return values;
};

/**
 * Serialize interactive-filter values back into a search string
 * (no leading `?`), preserving declaration order and dropping empty
 * values — the inverse of {@link filterValuesFromSearch}.
 */
export const filterSearchFromValues = (
	def: { readonly filters?: readonly ViewFilter[] },
	values: Readonly<Record<string, string>>,
): string => {
	const params = new URLSearchParams();
	for (const filter of def.filters ?? []) {
		if ("value" in filter) continue;
		const param = filterParam(filter);
		const raw = values[param];
		if (raw !== undefined && raw.trim() !== "") params.set(param, raw);
	}
	return params.toString();
};

/** Merge a filter-values object into a path's existing search string
 * — used to keep the URL in sync without a router navigation. */
export const withFilterSearch = (path: string, search: string): string => {
	if (search === "") {
		const q = path.indexOf("?");
		return q === -1 ? path : path.slice(0, q);
	}
	const q = path.indexOf("?");
	const base = q === -1 ? path : path.slice(0, q);
	return `${base}?${search}`;
};

/** Current URL search string — "" during SSR/tests without a DOM. */
export const currentSearch = (): string =>
	typeof window === "undefined" ? "" : window.location.search;

/** Write filter values into the URL via replaceState — no router
 * navigation, so the page loader does NOT rerun; the component
 * refetches through `viewQueryFn` itself. SSR-safe no-op. */
export const replaceFilterSearch = (search: string): void => {
	if (typeof window === "undefined") return;
	window.history.replaceState(null, "", withFilterSearch(window.location.pathname, search));
};

/**
 * Resolve a def-supplied title/label: when the string matches a key
 * in the route's DB catalog slice (`ctx.i18n.catalog`, PL-008) the
 * catalog template wins; anything else renders literally. Catalog
 * templates here are plain strings — `renderMessage` is applied by
 * the slice layer upstream, so a raw lookup is enough for
 * parameter-free view copy.
 */
export const resolveViewText = (i18n: PageI18nSlice | undefined, text: string): string =>
	i18n?.catalog[text] ?? text;
