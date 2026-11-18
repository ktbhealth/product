import { getPath } from "./path.ts";
import { isRecord } from "./grammar.ts";

/**
 * Shared condition DSL — a small JSON-safe boolean grammar evaluated
 * against a scope object (wizard run answers, the written record's
 * `data`, a flow transition's `{ record, event, flow }` scope, …).
 *
 * Grammar:
 *
 * ```jsonc
 * { "path": "contact.email", "op": "eq", "value": "a@b.c" }   // leaf
 * { "all": [ <cond>, … ] }                                    // AND
 * { "any": [ <cond>, … ] }                                    // OR
 * { "not": <cond> }                                           // negation
 * ```
 *
 * Leaf `path` is a dot path into the evaluated object (numeric
 * segments index arrays — see {@link getPath}). `op` defaults to
 * `"eq"`; `"exists"`/`"truthy"` ignore `value`. Comparisons are
 * JSON-deep for `eq`/`ne`/`in` and primitive `<`/`>` ordering for
 * `gt`/`gte`/`lt`/`lte` (non-comparable operands evaluate false —
 * conditions fail closed).
 */

export type ConditionOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "exists" | "truthy";

export type Condition =
	| {
			readonly path: string;
			readonly op?: ConditionOp;
			readonly value?: unknown;
	  }
	| { readonly all: readonly Condition[] }
	| { readonly any: readonly Condition[] }
	| { readonly not: Condition };

const CONDITION_OPS = new Set<ConditionOp>([
	"eq",
	"ne",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"exists",
	"truthy",
]);

/** Nesting cap for condition trees — `all`/`any`/`not` recursion in
 * both {@link assertCondition} and {@link evaluateCondition}. Over-depth
 * payloads are rejected at assert time and evaluate false at runtime
 * (fail closed), so a hostile def can't smash the stack. */
export const MAX_CONDITION_DEPTH = 32;

/** Structural validation for manifest/DB payloads — throws with the
 * caller-supplied context string (packaging-bug contract). */
export const assertCondition = (value: unknown, context: string, depth = 0): Condition => {
	if (depth > MAX_CONDITION_DEPTH) {
		throw new Error(`${context}: condition nesting exceeds ${MAX_CONDITION_DEPTH}`);
	}
	if (!isRecord(value)) {
		throw new Error(`${context}: condition must be an object`);
	}
	if ("all" in value) {
		if (!Array.isArray(value.all)) {
			throw new Error(`${context}: condition "all" must be an array`);
		}
		value.all.forEach((cond, index) =>
			assertCondition(cond, `${context}.all[${index}]`, depth + 1),
		);
		return value as unknown as Condition;
	}
	if ("any" in value) {
		if (!Array.isArray(value.any)) {
			throw new Error(`${context}: condition "any" must be an array`);
		}
		value.any.forEach((cond, index) =>
			assertCondition(cond, `${context}.any[${index}]`, depth + 1),
		);
		return value as unknown as Condition;
	}
	if ("not" in value) {
		assertCondition(value.not, `${context}.not`, depth + 1);
		return value as unknown as Condition;
	}
	const { path, op, value: expected } = value;
	if (typeof path !== "string" || path.length === 0) {
		throw new Error(`${context}: condition needs a non-empty "path"`);
	}
	if (op !== undefined && (typeof op !== "string" || !CONDITION_OPS.has(op as ConditionOp))) {
		throw new Error(`${context}: condition op ${JSON.stringify(op)} is not supported`);
	}
	if ((op === "exists" || op === "truthy") && expected !== undefined) {
		throw new Error(`${context}: condition op "${op}" takes no value`);
	}
	return value as unknown as Condition;
};

/** Deep JSON equality — object key order and array order matter-free
 * for objects, strict for arrays. */
export const jsonEquals = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, index) => jsonEquals(item, b[index]))
		);
	}
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	const ka = Object.keys(ra);
	const kb = Object.keys(rb);
	return (
		ka.length === kb.length &&
		ka.every((key) => Object.hasOwn(rb, key) && jsonEquals(ra[key], rb[key]))
	);
};

const compareOrdered = (op: ConditionOp, left: unknown, right: unknown): boolean => {
	if (typeof left !== typeof right) return false;
	if (typeof left !== "number" && typeof left !== "string") return false;
	if (op === "gt") return (left as number) > (right as number);
	if (op === "gte") return (left as number) >= (right as number);
	if (op === "lt") return (left as number) < (right as number);
	return (left as number) <= (right as number);
};

const evalLeaf = (
	cond: { readonly path: string; readonly op?: ConditionOp; readonly value?: unknown },
	scope: unknown,
): boolean => {
	const actual = getPath(scope, cond.path);
	const op = cond.op ?? "eq";
	switch (op) {
		case "exists":
			return actual !== undefined;
		case "truthy":
			return Boolean(actual);
		case "eq":
			return jsonEquals(actual, cond.value);
		case "ne":
			return !jsonEquals(actual, cond.value);
		case "in":
			return Array.isArray(cond.value) && cond.value.some((v) => jsonEquals(actual, v));
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return compareOrdered(op, actual, cond.value);
	}
};

/** Evaluate a condition against a scope object. Unknown/malformed
 * shapes evaluate false (fail closed). `depth` is internal recursion
 * state — conditions nested deeper than {@link MAX_CONDITION_DEPTH}
 * evaluate false rather than recursing (defense in depth for defs that
 * skipped assertCondition, e.g. hand-built test fixtures). */
export const evaluateCondition = (cond: Condition, scope: unknown, depth = 0): boolean => {
	if (depth > MAX_CONDITION_DEPTH) return false;
	if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, scope, depth + 1));
	if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, scope, depth + 1));
	if ("not" in cond) return !evaluateCondition(cond.not, scope, depth + 1);
	return evalLeaf(cond, scope);
};
