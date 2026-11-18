import type { FindQuery } from "@ktb/document-store";

import type { ViewDef, ViewFilter } from "./definition.ts";

/**
 * Pure query planning for `Views.load`/`Views.query`: turns a
 * {@link ViewDef}'s declared filters/sort/pageSize plus caller-supplied
 * filter values into a `DocumentStore.find` {@link FindQuery}. Kept
 * UI-free and Effect-free so every rule is unit-testable.
 */

/** Default list page size when a def doesn't declare `pageSize`. */
export const VIEW_PAGE_SIZE_DEFAULT = 25;

/** Caller-supplied interactive filter values, keyed by the filter's
 * `param` (default: its `field`). Values are RAW strings exactly as
 * they arrive from URL search params / the server fn — parsing happens
 * here so the wire stays JSON-simple. */
export interface ViewQueryInput {
	readonly offset?: number;
	readonly values?: Readonly<Record<string, string | undefined>>;
}

/** The param name an interactive filter binds to. */
export const filterParam = (filter: ViewFilter): string => filter.param ?? filter.field;

/** Interactive filters only — fixed filters (`value` present) are
 * always applied and never rendered as controls. */
export const interactiveFilters = (def: ViewDef): readonly ViewFilter[] =>
	(def.filters ?? []).filter((f) => !("value" in f));

/** Fixed filters only — the always-applied scoping conditions. */
export const fixedFilters = (def: ViewDef): readonly ViewFilter[] =>
	(def.filters ?? []).filter((f) => "value" in f);

/**
 * Parse one raw filter input: JSON first (so `5`, `true`, `null`,
 * `["a"]`, `{"a":1}` keep their types), falling back to the raw string
 * for anything that isn't valid JSON (e.g. `hello world`).
 */
export const parseFilterInput = (raw: string): unknown => {
	const trimmed = raw.trim();
	if (trimmed === "") return raw;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return raw;
	}
};

/**
 * Build the `DocumentFilter` for a def: fixed filters always apply;
 * interactive filters apply only when the caller supplied a non-empty
 * value for their param. Multiple conditions are wrapped in `$and` so
 * two filters can target the same field without key collisions.
 */
export const buildFilter = (
	def: ViewDef,
	values: ViewQueryInput["values"],
): FindQuery["filter"] => {
	const conditions: Record<string, unknown>[] = [];
	for (const filter of fixedFilters(def)) {
		conditions.push({ [filter.field]: { [filter.op]: filter.value } });
	}
	for (const filter of interactiveFilters(def)) {
		const raw = values?.[filterParam(filter)];
		if (raw === undefined) continue;
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		conditions.push({ [filter.field]: { [filter.op]: parseFilterInput(raw) } });
	}
	if (conditions.length === 0) return undefined;
	if (conditions.length === 1) return conditions[0] as Record<string, unknown>;
	return { $and: conditions };
};

export interface PlannedFind {
	readonly find: FindQuery;
	/** Resolved page size (def override or {@link VIEW_PAGE_SIZE_DEFAULT}). */
	readonly pageSize: number;
	/** Resolved non-negative offset. */
	readonly offset: number;
}

/**
 * The full plan for a list render: declared filter conditions, declared
 * sort, `pageSize` (def override or {@link VIEW_PAGE_SIZE_DEFAULT}) and
 * the caller's offset (clamped non-negative; the store re-clamps
 * limit/offset defensively). `pageSize`/`offset` are returned resolved
 * so the wire can echo them without re-deriving.
 */
export const planFind = (def: ViewDef, input: ViewQueryInput = {}): PlannedFind => {
	const filter = buildFilter(def, input.values);
	const sort = def.sort ?? [];
	const pageSize = def.pageSize ?? VIEW_PAGE_SIZE_DEFAULT;
	const offset = Math.max(0, Math.trunc(input.offset ?? 0));
	return {
		find: {
			...(filter === undefined ? {} : { filter }),
			...(sort.length === 0 ? {} : { sort }),
			limit: pageSize,
			offset,
		},
		pageSize,
		offset,
	};
};
