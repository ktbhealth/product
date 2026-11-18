import { sql, type SQL } from "drizzle-orm";

import { documentRecords } from "./schema.ts";
import type { DocumentFilter } from "./query.ts";

/**
 * SQL pushdown for `DocumentStore.find` (T-149) — compiles the SAFE
 * subset of a validated {@link DocumentFilter} into a WHERE fragment
 * over `json_extract(document_records.data, '$.path')` so SQLite does
 * the first-pass filtering instead of JS scanning every visible row.
 *
 * CORRECTNESS CONTRACT — the compiled fragment is only ever a
 * SUPERSET prefilter: every row the JS `matchFilter` would accept MUST
 * satisfy the SQL fragment (JS-match ⇒ SQL-true). `find` still runs
 * the full `matchFilter` over the returned rows, so results are
 * IDENTICAL to the pure-JS path; SQL only narrows what gets parsed,
 * migrated and matched in memory. Anything the compiler cannot prove
 * safe contributes NO constraint (returns null) and stays JS-side:
 * `$regex`, object/array literals, non-scalar `$in`/`$nin` elements,
 * non-finite numbers, untranslatable paths.
 *
 * Semantic traps handled here (the JS matcher in query.ts is the
 * source of truth):
 *
 * - `json_type` distinguishes JSON `null` ('null') from a MISSING path
 *   (NULL) — `json_extract` alone conflates them, and `$exists` plus
 *   `$eq: null`/`undefined` depend on the difference.
 * - Booleans extract as integers 1/0, so `$eq: 1` must NOT match JSON
 *   `true` — the `json_type IN ('integer','real')` guard handles it.
 * - JSON objects/arrays extract as TEXT (the serialized JSON), which
 *   sorts ABOVE every number in SQLite's cross-type ordering — that
 *   makes `E > n`/`E >= n` automatically true for them, matching the
 *   JS `compareOrdered` String() coercion ("[object Object]"/"1,2"
 *   both compare > any numeric string). For `$lt`/`$lte` the same
 *   rows are rescued explicitly via `json_type IN ('text','array')`
 *   because TEXT < number is false in SQLite while JS string
 *   coercion can still match.
 * - `$gt`/`$gte` with a NUMBER operand must also rescue
 *   'true'/'false'/'null'/missing: JS `String(true)` = "true" etc.
 *   always sorts above any numeric string, so those rows DO match in
 *   JS even though `json_extract` yields 1/0/NULL.
 * - Numbers beyond ±2^53 lose precision differently in JS (double) vs
 *   SQLite (int64-exact/REAL), so huge magnitudes are always let
 *   through (`abs(E) > MAX_SAFE_INTEGER`) and left for the JS
 *   postfilter. `$eq`/`$in` use the loose variant; `$ne`/`$nin` need
 *   the STRICT variant (definitely-equal only) because a superset
 *   equality would wrongly exclude rows JS keeps.
 * - Prototype-chain keys (`constructor`, `__proto__`, `toString`, …)
 *   and non-identifier path segments are rejected: `getPath` walks
 *   inherited properties in JS while `json_extract` only sees own
 *   JSON keys — results would diverge.
 * - Dotted paths only reach object keys here: JS array indexing
 *   (`items.0.name`) needs bracket syntax per segment AND the parent
 *   type is data-dependent, so any segment that is not a plain
 *   identifier falls back to JS.
 */

/** SQLite json_type values meaning "JSON number". */
const NUM_TYPES = "('integer','real')";
/** |value| above this can't be compared reliably across JS doubles
 * and SQLite int64 — always let the JS postfilter decide. */
const MAX_SAFE_JSON_INT = 9007199254740991;

/** Path segment → SQLite `$.a.b` label is only provably equivalent
 * for plain identifiers; anything else (digits, hyphens, dots-in-key
 * impossible anyway, quotes) falls back to JS. */
const SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** `getPath` reads `current[segment]` on plain objects — an absent
 * key named like an Object.prototype member (`constructor`,
 * `__proto__`, `hasOwnProperty`, …) resolves to the INHERITED value in
 * JS while `json_extract` returns NULL. Reject those segments. */
const isPrototypeKey = (segment: string): boolean => segment in {};

/** Dotted filter path → SQLite JSON path, or null when any segment is
 * not safely translatable (identifier charset + no prototype keys). */
const toJsonPath = (field: string): string | null => {
	const segments = field.split(".");
	for (const segment of segments) {
		if (!SEGMENT_RE.test(segment) || isPrototypeKey(segment)) return null;
	}
	return `$.${segments.join(".")}`;
};

const extract = (path: string): SQL => sql`json_extract(${documentRecords.data}, ${path})`;
const jtype = (path: string): SQL => sql`json_type(${documentRecords.data}, ${path})`;

/** |E| > MAX_SAFE without abs(): SQLite abs() throws "integer
 * overflow" on INTEGER -9223372036854775808 (a legal JSON number), so
 * the magnitude test is two comparisons. TEXT extracts never satisfy
 * either side (TEXT sorts above all numbers). */
const hugeMagnitude = (path: string): SQL =>
	sql`(${extract(path)} > ${MAX_SAFE_JSON_INT} OR ${extract(path)} < ${-MAX_SAFE_JSON_INT})`;

/** Loose equality candidate — TRUE for every row where JS
 * `jsonEqual(actual, operand)` MAY hold (superset). Used by `$eq`,
 * `$in` and literal conditions where extra rows are filtered out by
 * the JS postfilter anyway. Returns null for operands SQL cannot
 * express (objects/arrays, non-finite numbers). */
const looseEq = (path: string, operand: unknown): SQL | null => {
	if (operand === undefined) {
		// JS jsonEqual(actual, undefined) ⇔ getPath missed ⇔ the JSON
		// path is absent (json_type IS NULL — covers both missing keys
		// and paths through scalars/arrays).
		return sql`${jtype(path)} IS NULL`;
	}
	if (operand === null) return sql`coalesce(${jtype(path)} = 'null', 0)`;
	if (typeof operand === "boolean") {
		return sql`coalesce(${jtype(path)} = ${operand ? "true" : "false"}, 0)`;
	}
	if (typeof operand === "string") {
		// TEXT never equals INTEGER/REAL in SQLite (no column affinity
		// on an expression), and json_type='text' ⇔ JSON string —
		// exact for JSON equality.
		return sql`coalesce(${jtype(path)} = 'text' AND ${extract(path)} = ${operand}, 0)`;
	}
	if (typeof operand === "number") {
		if (!Number.isFinite(operand)) return null;
		// Loose: huge int64-exact integers whose JS double rounds onto
		// the operand still count as candidates (JS postfilter
		// decides); within ±2^53 SQLite and JS agree exactly.
		return sql`coalesce(${jtype(path)} IN ${sql.raw(NUM_TYPES)} AND (${extract(path)} = ${operand} OR ${hugeMagnitude(path)}), 0)`;
	}
	// Objects/arrays need structural jsonEqual — JS-side.
	return null;
};

/** Strict equality candidate — TRUE only where JS `jsonEqual` is
 * CERTAIN (subset). Required by the negative operators: `$ne`/`$nin`
 * exclude rows on equality, so their SQL must not flag rows JS would
 * keep (the loose huge-int rescue would). */
const strictEq = (path: string, operand: unknown): SQL | null => {
	if (typeof operand === "number" && Number.isFinite(operand)) {
		return sql`coalesce(${jtype(path)} IN ${sql.raw(NUM_TYPES)} AND ${extract(path)} <= ${MAX_SAFE_JSON_INT} AND ${extract(path)} >= ${-MAX_SAFE_JSON_INT} AND ${extract(path)} = ${operand}, 0)`;
	}
	// Every other scalar type is already exact in looseEq.
	return looseEq(path, operand);
};

/** Range comparison with a finite NUMBER operand. JS `compareOrdered`
 * falls back to String() coercion for mixed/missing types, which SQL
 * cannot reproduce — so each direction emits a provable superset:
 * `$gt`/`$gte` rely on SQLite's TEXT > number ordering plus explicit
 * rescues for boolean/null/missing (whose String() forms always sort
 * above a numeric string); `$lt`/`$lte` whitelist the types that can
 * possibly match (numbers below the bound, all strings, all arrays —
 * String([]) === "" sorts below everything) and exclude the rest,
 * which JS provably never matches. */
const rangeOp = (path: string, op: "$gt" | "$gte" | "$lt" | "$lte", operand: number): SQL => {
	const cmp = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" }[op];
	const huge = sql`(${jtype(path)} IN ${sql.raw(NUM_TYPES)} AND ${hugeMagnitude(path)})`;
	if (op === "$gt" || op === "$gte") {
		return sql`(${extract(path)} ${sql.raw(cmp)} ${operand} OR ${jtype(path)} IN ('true','false','null') OR ${jtype(path)} IS NULL OR ${huge})`;
	}
	return sql`(${jtype(path)} IN ${sql.raw(NUM_TYPES)} AND (${extract(path)} ${sql.raw(cmp)} ${operand} OR ${hugeMagnitude(path)})) OR ${jtype(path)} IN ('text','array')`;
};

/** One operator entry → SQL fragment, or null when it must stay
 * JS-side. The fragment is always a SUPERSET of the operator's JS
 * matches (see module doc). */
const opFragment = (path: string, op: string, operand: unknown): SQL | null => {
	switch (op) {
		case "$eq":
			return looseEq(path, operand);
		case "$ne": {
			const eq = strictEq(path, operand);
			// strictEq ⊆ jsonEqual ⇒ its negation ⊇ JS $ne matches.
			// NULL-safe: strictEq never yields NULL (coalesced), but a
			// missing path makes every scalar candidate 0 → $ne passes,
			// exactly like JS (jsonEqual(undefined, scalar) is false).
			return eq === null ? null : sql`(${eq}) = 0`;
		}
		case "$gt":
		case "$gte":
		case "$lt":
		case "$lte":
			return typeof operand === "number" && Number.isFinite(operand)
				? rangeOp(path, op, operand)
				: null;
		case "$in": {
			if (!Array.isArray(operand)) return null;
			if (operand.length === 0) return sql`0 = 1`; // JS: some() → never matches
			const parts: SQL[] = [];
			for (const el of operand) {
				const eq = looseEq(path, el);
				if (eq === null) return null; // one inexpressible element → whole op JS-side
				parts.push(eq);
			}
			return sql`(${sql.join(parts, sql` OR `)})`;
		}
		case "$nin": {
			if (!Array.isArray(operand)) return null; // JS: non-array operand always passes
			if (operand.length === 0) return null; // JS: some() → never fails → no constraint
			const parts: SQL[] = [];
			for (const el of operand) {
				const eq = strictEq(path, el);
				if (eq === null) return null;
				parts.push(eq);
			}
			// NOT(any strict-equal): strictEq ⊆ jsonEqual ⇒ a row with
			// no strict hit may still jsonEqual (huge ints) — the JS
			// postfilter removes those; rows WITH a strict hit are
			// definitely jsonEqual → JS $nin fails → safe to exclude.
			return sql`NOT (${sql.join(parts, sql` OR `)})`;
		}
		case "$exists": {
			if (operand === true) {
				// JS "exists" = actual !== undefined && !== null ⇔
				// json_type is neither NULL (missing) nor 'null'.
				return sql`coalesce(${jtype(path)} IS NOT NULL AND ${jtype(path)} != 'null', 0)`;
			}
			if (operand === false) {
				return sql`coalesce(${jtype(path)} IS NULL OR ${jtype(path)} = 'null', 0)`;
			}
			return null; // non-boolean operand: JS ignores the check entirely
		}
		default:
			// $regex and unknown operators stay JS-side ($regex) or are
			// vacuous (unknown ops fail closed in matchCondition, so
			// skipping them here keeps the superset property).
			return null;
	}
};

const isOperatorObject = (cond: unknown): cond is Record<string, unknown> =>
	isPlainObject(cond) &&
	Object.keys(cond).length > 0 &&
	Object.keys(cond).every((k) => k.startsWith("$"));

/** One field condition → zero or more SQL fragments (implicit AND).
 * Untranslatable paths/operands simply contribute nothing. */
const conditionFragments = (field: string, cond: unknown): SQL[] => {
	const path = toJsonPath(field);
	if (path === null) return [];
	if (!isOperatorObject(cond)) {
		// Literal condition === implicit $eq (jsonEqual semantics).
		const eq = looseEq(path, cond);
		return eq === null ? [] : [eq];
	}
	const out: SQL[] = [];
	for (const [op, operand] of Object.entries(cond)) {
		const frag = opFragment(path, op, operand);
		if (frag !== null) out.push(frag);
	}
	return out;
};

/** Compile one filter node → SQL constraint, or null when it imposes
 * none. Mirrors matchFilter's $and/$or/implicit-AND structure; every
 * returned fragment is a superset of that node's JS matches. */
const compileNode = (filter: unknown): SQL | null => {
	if (!isPlainObject(filter)) return null; // matchFilter: no entries → matches all
	const parts: SQL[] = [];
	for (const [key, cond] of Object.entries(filter)) {
		if (key === "$and") {
			if (!Array.isArray(cond)) {
				// matchFilter fails closed on a non-array $and — nothing matches.
				return sql`0 = 1`;
			}
			for (const sub of cond) {
				const child = compileNode(sub);
				if (child !== null) parts.push(child);
			}
			continue;
		}
		if (key === "$or") {
			if (!Array.isArray(cond)) return sql`0 = 1`;
			if (cond.length === 0) return sql`0 = 1`; // some() over [] → false
			const branches: SQL[] = [];
			let unconstrained = false;
			for (const sub of cond) {
				const child = compileNode(sub);
				if (child === null) {
					// An unconstrained branch could match anything ⇒ the
					// whole $or imposes no SQL constraint (JS decides).
					unconstrained = true;
					break;
				}
				branches.push(child);
			}
			if (!unconstrained) parts.push(sql`(${sql.join(branches, sql` OR `)})`);
			continue;
		}
		parts.push(...conditionFragments(key, cond));
	}
	if (parts.length === 0) return null;
	return sql`(${sql.join(parts, sql` AND `)})`;
};

/**
 * Compile a validated {@link DocumentFilter} into a drizzle SQL WHERE
 * fragment for `find`, or undefined when nothing is safely pushable
 * (no filter, or every condition stayed JS-side). The result is ONLY
 * a prefilter — `find` must still run `matchFilter` over the fetched
 * rows for identical results.
 */
export const compileFilterPrefilter = (filter: DocumentFilter | undefined): SQL | undefined => {
	if (filter === undefined) return undefined;
	return compileNode(filter) ?? undefined;
};
