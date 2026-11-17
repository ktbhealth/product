/**
 * Query engine for `DocumentStore.find` (P-089) — v1 evaluates filters
 * in JS over the parsed `data` JSON of rows already fenced by SQL
 * (collection + tenant/owner scope). The tradeoff is deliberate: field
 * paths, operators and dotted sorts are schema-driven per collection,
 * so a generic SQL translation would need per-collection index
 * planning; record volumes per collection are expected to be small
 * (specialty packs, intake forms). If a collection outgrows this, the
 * escape hatch is a dedicated table — the DSL boundary stays the same.
 */

/** Operators recognized inside a field condition object. */
export const QUERY_OPERATORS = [
	"$eq",
	"$ne",
	"$gt",
	"$gte",
	"$lt",
	"$lte",
	"$in",
	"$nin",
	"$exists",
	"$regex",
] as const;

export type QueryOperator = (typeof QUERY_OPERATORS)[number];

/** Logical combinators — `$and`/`$or` take arrays of sub-filters and
 * may appear alongside field conditions (implicit AND). */
export const LOGICAL_KEYS = ["$and", "$or"] as const;

/** One sort term: dotted field path plus direction (default "asc"). */
export interface SortTerm {
	readonly field: string;
	readonly dir: "asc" | "desc";
}

/** A field condition: literal (implicit `$eq`) or an operator object
 * (`{ $gt: 3, $lt: 10 }`). */
export type FieldCondition = unknown;

/** Filter shape: `{ "a.b": cond, "$or": [ {...}, {...} ] }`. */
export type DocumentFilter = Readonly<Record<string, unknown>>;

export interface FindQuery {
	readonly filter?: DocumentFilter;
	readonly sort?: string | readonly (string | SortTerm)[];
	readonly limit?: number;
	readonly offset?: number;
}

const FIND_LIMIT_DEFAULT = 100;
export const FIND_LIMIT_MAX = 500;

/** Hard cap on rows a single `find` scans in JS (T-128). `find`
 * evaluates filters/sorts in memory over the caller's whole visible
 * slice; past this bound the honest answer is a typed
 * `InvalidDocumentQuery`, not a multi-second scan. Collections that
 * outgrow it should graduate to a dedicated table (see module doc). */
export const FIND_SCAN_MAX_ROWS = 10_000;

/** Filter-structure DoS bounds (T-128): `$and`/`$or` nesting deeper
 * than this or a filter with more total nodes than this is rejected
 * by `validateFilter` before any row is scanned. Node counting: each
 * filter object, each field condition, each operator entry and each
 * `$in`/`$nin` element costs one node. */
export const MAX_FILTER_DEPTH = 8;
export const MAX_FILTER_NODES = 100;

/** Clamp pagination inputs — negatives and NaN collapse to defaults. */
export const clampLimit = (limit: number | undefined): number => {
	if (limit === undefined || !Number.isFinite(limit)) return FIND_LIMIT_DEFAULT;
	return Math.min(Math.max(Math.trunc(limit), 1), FIND_LIMIT_MAX);
};

export const clampOffset = (offset: number | undefined): number => {
	if (offset === undefined || !Number.isFinite(offset)) return 0;
	return Math.max(Math.trunc(offset), 0);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Dotted-path read: "a.b.c" walks nested objects/arrays by numeric
 * segments. Missing segments yield `undefined`. */
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
		if (!isPlainObject(current)) return undefined;
		current = current[segment];
	}
	return current;
};

/** Structural JSON equality — used by `$eq`/`$in` and literal-object
 * conditions. Arrays compare element-wise, objects key-wise. */
export const jsonEqual = (a: unknown, b: unknown): boolean => {
	// `===` (not Object.is): JSON semantics — 0 and -0 are the same
	// value; NaN is not valid JSON and simply never equals.
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		return aKeys.length === bKeys.length && aKeys.every((k) => jsonEqual(a[k], b[k]));
	}
	return false;
};

const isOperatorObject = (cond: unknown): cond is Record<string, unknown> =>
	isPlainObject(cond) &&
	Object.keys(cond).length > 0 &&
	Object.keys(cond).every((k) => k.startsWith("$"));

const compareOrdered = (a: unknown, b: unknown): number => {
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
	// Mixed/missing types: string coercion keeps the comparator total.
	const sa = String(a);
	const sb = String(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
};

/** Evaluate one field condition against the value at `path`. */
const matchCondition = (actual: unknown, cond: unknown): boolean => {
	if (!isOperatorObject(cond)) return jsonEqual(actual, cond);
	for (const [op, operand] of Object.entries(cond)) {
		switch (op) {
			case "$eq":
				if (!jsonEqual(actual, operand)) return false;
				break;
			case "$ne":
				if (jsonEqual(actual, operand)) return false;
				break;
			case "$gt":
				if (!(compareOrdered(actual, operand) > 0)) return false;
				break;
			case "$gte":
				if (!(compareOrdered(actual, operand) >= 0)) return false;
				break;
			case "$lt":
				if (!(compareOrdered(actual, operand) < 0)) return false;
				break;
			case "$lte":
				if (!(compareOrdered(actual, operand) <= 0)) return false;
				break;
			case "$in":
				if (!Array.isArray(operand) || !operand.some((v) => jsonEqual(actual, v))) return false;
				break;
			case "$nin":
				if (Array.isArray(operand) && operand.some((v) => jsonEqual(actual, v))) return false;
				break;
			case "$exists":
				if (operand === true && (actual === undefined || actual === null)) return false;
				if (operand === false && actual !== undefined && actual !== null) return false;
				break;
			case "$regex": {
				if (typeof actual !== "string") return false;
				// Matching is case-SENSITIVE (no flag support in the
				// query DSL). The operand is normally a RegExp
				// precompiled once per `find` call by compileFilter;
				// raw strings are still accepted for direct
				// matchFilter callers.
				if (operand instanceof RegExp) {
					if (!operand.test(actual)) return false;
					break;
				}
				if (typeof operand !== "string" || !new RegExp(operand).test(actual)) return false;
				break;
			}
			default:
				// Unknown operators fail closed — validateFilter rejects
				// them earlier, so reaching here means a direct matchFilter
				// call; treat as non-match rather than silently passing.
				return false;
		}
	}
	return true;
};

/**
 * Match one record's `data` against a filter. Top-level `$and`/`$or`
 * keys combine sub-filters; every other key is a dotted field path
 * (implicit AND across keys).
 */
export const matchFilter = (data: unknown, filter: DocumentFilter | undefined): boolean => {
	if (filter === undefined) return true;
	for (const [key, cond] of Object.entries(filter)) {
		if (key === "$and") {
			if (!Array.isArray(cond) || !cond.every((sub) => matchFilter(data, sub as DocumentFilter))) {
				return false;
			}
			continue;
		}
		if (key === "$or") {
			if (!Array.isArray(cond) || !cond.some((sub) => matchFilter(data, sub as DocumentFilter))) {
				return false;
			}
			continue;
		}
		if (!matchCondition(getPath(data, key), cond)) return false;
	}
	return true;
};

/** Normalize the `sort` argument into terms ("-field" = desc shorthand
 * is NOT supported — use `{ field, dir }` for descending). Callers
 * must run validateSort first — this trusts its input. */
export const normalizeSort = (
	sort: string | readonly (string | SortTerm)[] | undefined,
): readonly SortTerm[] => {
	if (sort === undefined) return [];
	const list = typeof sort === "string" ? [sort] : sort;
	return list.map((term) =>
		typeof term === "string" ? { field: term, dir: "asc" as const } : term,
	);
};

/** Comparator over record `data` payloads for the normalized terms.
 * Missing values always sort last regardless of direction; the sort is
 * stable (Array.prototype.sort) so equal keys keep insertion order. */
export const compareData =
	(terms: readonly SortTerm[]) =>
	(a: unknown, b: unknown): number => {
		for (const { field, dir } of terms) {
			const av = getPath(a, field);
			const bv = getPath(b, field);
			const aMissing = av === undefined || av === null;
			const bMissing = bv === undefined || bv === null;
			if (aMissing && bMissing) continue;
			if (aMissing) return 1;
			if (bMissing) return -1;
			const cmp = compareOrdered(av, bv);
			if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
		}
		return 0;
	};

/** Structural validation of a filter — returns issue strings (empty =
 * valid). Catches unknown operators, non-array `$and`/`$or`, bad
 * `$regex` sources, non-boolean `$exists` operands, excessive nesting
 * ({@link MAX_FILTER_DEPTH}) and oversized filters
 * ({@link MAX_FILTER_NODES}) up front so `find` fails with
 * `InvalidDocumentQuery` instead of silently matching nothing or
 * burning CPU on a pathological tree. */
export const validateFilter = (filter: unknown, path = "filter"): string[] =>
	validateFilterNode(filter, path, 1, { nodes: 0 });

interface FilterBudget {
	nodes: number;
}

/** Spend one node; returns the over-budget issue once, or null. */
const spendNode = (budget: FilterBudget, path: string): string | null => {
	budget.nodes += 1;
	return budget.nodes > MAX_FILTER_NODES
		? `${path}: filter exceeds ${MAX_FILTER_NODES} nodes`
		: null;
};

const validateFilterNode = (
	filter: unknown,
	path: string,
	depth: number,
	budget: FilterBudget,
): string[] => {
	const issues: string[] = [];
	if (!isPlainObject(filter)) return [`${path} must be an object`];
	if (depth > MAX_FILTER_DEPTH) {
		return [`${path} exceeds max nesting depth ${MAX_FILTER_DEPTH}`];
	}
	// The root object spends one node — it can never be the
	// over-budget spend (the budget starts empty), so no check here.
	spendNode(budget, path);
	for (const [key, cond] of Object.entries(filter)) {
		const keyIssue = spendNode(budget, `${path}.${key}`);
		if (keyIssue !== null) {
			issues.push(keyIssue);
			return issues;
		}
		if (key === "$and" || key === "$or") {
			if (!Array.isArray(cond) || cond.length === 0) {
				issues.push(`${path}.${key} must be a non-empty array of filters`);
				continue;
			}
			cond.forEach((sub, i) =>
				issues.push(...validateFilterNode(sub, `${path}.${key}[${i}]`, depth + 1, budget)),
			);
			continue;
		}
		if (isOperatorObject(cond)) {
			for (const [op, operand] of Object.entries(cond)) {
				const opIssue = spendNode(budget, `${path}.${key}.${op}`);
				if (opIssue !== null) {
					issues.push(opIssue);
					return issues;
				}
				if (!(QUERY_OPERATORS as readonly string[]).includes(op)) {
					issues.push(`${path}.${key}: unknown operator ${op}`);
					continue;
				}
				if (op === "$regex") {
					if (typeof operand !== "string") {
						issues.push(`${path}.${key}.$regex operand must be a string`);
					} else {
						issues.push(...regexIssues(operand, `${path}.${key}`));
					}
				}
				if (op === "$exists" && typeof operand !== "boolean") {
					issues.push(`${path}.${key}.$exists operand must be a boolean`);
				}
				if ((op === "$in" || op === "$nin") && !Array.isArray(operand)) {
					issues.push(`${path}.${key}.${op} operand must be an array`);
					continue;
				}
				// $in/$nin element lists are unbounded JSON — each element
				// spends a node so a giant literal can't slip past the
				// structural budget (matchCondition would otherwise
				// jsonEqual-scan it per row).
				if ((op === "$in" || op === "$nin") && Array.isArray(operand)) {
					for (let i = 0; i < operand.length; i++) {
						const elemIssue = spendNode(budget, `${path}.${key}.${op}[${i}]`);
						if (elemIssue !== null) {
							issues.push(elemIssue);
							return issues;
						}
					}
				}
			}
		}
		// Literal conditions (including literal objects for $eq-style
		// JSON comparison) need no further validation.
	}
	return issues;
};

/** Structural validation of the `sort` argument — returns issue
 * strings (empty = valid). Rejects non-string fields, non
 * "asc"/"desc" directions and non-term entries up front so `find`
 * fails with `InvalidDocumentQuery` instead of crashing inside
 * getPath/compareData. */
export const validateSort = (sort: unknown): string[] => {
	if (sort === undefined) return [];
	const list = typeof sort === "string" ? [sort] : sort;
	if (!Array.isArray(list)) return ["sort must be a string or an array of sort terms"];
	const issues: string[] = [];
	list.forEach((term, i) => {
		const path = `sort[${i}]`;
		if (typeof term === "string") {
			if (term.length === 0) issues.push(`${path} must be a non-empty field path`);
			return;
		}
		if (!isPlainObject(term)) {
			issues.push(`${path} must be a string or a { field, dir } object`);
			return;
		}
		if (typeof term.field !== "string" || term.field.length === 0) {
			issues.push(`${path}.field must be a non-empty string`);
		}
		if (term.dir !== undefined && term.dir !== "asc" && term.dir !== "desc") {
			issues.push(`${path}.dir must be "asc" or "desc"`);
		}
	});
	return issues;
};

/** `$regex` pattern cap — long patterns are both a ReDoS surface and
 * almost certainly a caller bug. */
export const REGEX_MAX_PATTERN_LENGTH = 200;

/** Cheap catastrophic-backtracking heuristic: flags a quantified
 * group whose body itself contains a quantifier — the classic
 * `(a+)+`, `(\d*)*`, `(x{2,}){3}` ReDoS shapes. It is deliberately
 * NOT a full regex parser: it may false-positive on innocuous
 * patterns like `([+*])+` (documented tradeoff — filters come from
 * trusted server-fn callers, this is defense in depth, not a
 * security boundary). */
const NESTED_QUANTIFIER_RE = /\([^()]*[+*?{][^()]*\)\s*[+*?{]/;

/** Second cheap heuristic (T-128): a quantified group containing an
 * alternation — `(a|ab)+`, `(x|xy)*` — is the other classic
 * catastrophic-backtracking shape the nested-quantifier regex misses.
 * Deliberately conservative: `(cat|dog)+` is also rejected even though
 * many alternations are safe — filters come from trusted server-fn
 * callers and this is defense in depth, not a security boundary. */
const QUANTIFIED_ALTERNATION_RE = /\([^()]*\|[^()]*\)\s*[+*?{]/;

const regexIssues = (pattern: string, path: string): string[] => {
	if (pattern.length > REGEX_MAX_PATTERN_LENGTH) {
		return [`${path}.$regex pattern exceeds ${REGEX_MAX_PATTERN_LENGTH} characters`];
	}
	if (NESTED_QUANTIFIER_RE.test(pattern)) {
		return [`${path}.$regex pattern has nested quantifiers (ReDoS risk)`];
	}
	if (QUANTIFIED_ALTERNATION_RE.test(pattern)) {
		return [`${path}.$regex pattern has a quantified alternation (ReDoS risk)`];
	}
	try {
		new RegExp(pattern);
		return [];
	} catch {
		return [`${path}.$regex is not a valid pattern`];
	}
};

/**
 * Precompile every `$regex` operand in a validated filter ONCE per
 * `find` call, returning a structurally-equivalent filter whose
 * `$regex` operands are `RegExp` objects. Without this, matchCondition
 * would run `new RegExp(operand)` inside the per-row loop — O(rows ×
 * patterns) compilations. Run validateFilter first: patterns that
 * fail validation are left as strings (matchFilter then fails closed
 * on them per row, same as before).
 */
export const compileFilter = (filter: DocumentFilter | undefined): DocumentFilter | undefined => {
	if (filter === undefined) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, cond] of Object.entries(filter)) {
		if (key === "$and" || key === "$or") {
			out[key] = Array.isArray(cond)
				? cond.map((sub) => compileFilter(sub as DocumentFilter) ?? {})
				: cond;
			continue;
		}
		if (isOperatorObject(cond) && typeof cond.$regex === "string") {
			let compiled: unknown = cond.$regex;
			try {
				compiled = new RegExp(cond.$regex);
			} catch {
				// Uncompilable pattern — keep the string; matchCondition
				// treats it as a non-match (validateFilter rejects it
				// upstream anyway).
			}
			out[key] = { ...cond, $regex: compiled };
			continue;
		}
		out[key] = cond;
	}
	return out;
};
