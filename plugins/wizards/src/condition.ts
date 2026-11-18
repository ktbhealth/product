/**
 * Wizard step conditions — a small JSON-safe boolean DSL evaluated
 * against a run's submitted answers (`Record<stepId, value>`).
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
 * Leaf `path` is a dot path into the answers object (numeric segments
 * index arrays). `op` defaults to `"eq"`; `"exists"`/`"truthy"` ignore
 * `value`. Comparisons are JSON-deep for `eq`/`ne`/`in` and primitive
 * `<`/`>` ordering for `gt`/`gte`/`lt`/`lte` (non-comparable operands
 * evaluate false — conditions fail closed).
 */

export type ConditionOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "exists" | "truthy";

export type WizardCondition =
	| {
			readonly path: string;
			readonly op?: ConditionOp;
			readonly value?: unknown;
	  }
	| { readonly all: readonly WizardCondition[] }
	| { readonly any: readonly WizardCondition[] }
	| { readonly not: WizardCondition };

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural validation for manifest/DB payloads — throws with the
 * caller-supplied context string (packaging-bug contract). */
export const assertCondition = (value: unknown, context: string): WizardCondition => {
	if (!isRecord(value)) {
		throw new Error(`${context}: condition must be an object`);
	}
	if ("all" in value) {
		if (!Array.isArray(value.all)) {
			throw new Error(`${context}: condition "all" must be an array`);
		}
		value.all.forEach((cond, index) => assertCondition(cond, `${context}.all[${index}]`));
		return value as unknown as WizardCondition;
	}
	if ("any" in value) {
		if (!Array.isArray(value.any)) {
			throw new Error(`${context}: condition "any" must be an array`);
		}
		value.any.forEach((cond, index) => assertCondition(cond, `${context}.any[${index}]`));
		return value as unknown as WizardCondition;
	}
	if ("not" in value) {
		assertCondition(value.not, `${context}.not`);
		return value as unknown as WizardCondition;
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
	return value as unknown as WizardCondition;
};

/** Deep JSON equality — object key order and array order matter-free
 * for objects, strict for arrays (mirrors the document-store `jsonEqual`
 * contract closely enough for condition use). */
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
	return ka.length === kb.length && ka.every((key) => key in rb && jsonEquals(ra[key], rb[key]));
};

/** Resolve a dot path into the answers object. Numeric segments index
 * arrays; missing segments yield `undefined`. */
export const resolveAnswerPath = (answers: unknown, path: string): unknown => {
	let current: unknown = answers;
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
	answers: unknown,
): boolean => {
	const actual = resolveAnswerPath(answers, cond.path);
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

/** Evaluate a condition against submitted answers. Unknown/malformed
 * shapes evaluate false (fail closed). */
export const evaluateCondition = (cond: WizardCondition, answers: unknown): boolean => {
	if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, answers));
	if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, answers));
	if ("not" in cond) return !evaluateCondition(cond.not, answers);
	return evalLeaf(cond, answers);
};
