import { Schema } from "effect";

/**
 * @ktb/filters — a provider-agnostic filter engine. One serializable
 * AST ({@link FilterExpr}) describes what the user wants; two pure
 * operations serve every consumer:
 *
 * - {@link evaluateFilter} — client-side predicate over domain records
 *   through caller-declared field accessors.
 * - {@link partitionFilter} — splits an expression into the subtree a
 *   provider can honor natively (pushdown) and the residual that must
 *   be evaluated locally. Conjunctions split child-by-child; `or`/`not`
 *   are all-or-nothing because a partial pushdown of a disjunction or
 *   negation would change the meaning.
 *
 * The engine knows nothing about providers, wire formats, or domain
 * fields — adapters declare both the accessor map and the pushdown
 * capability predicate, keeping the seam honest in both directions.
 * Dates cross the AST as ISO strings, which compare correctly under
 * lexicographic ordering, so ordering operators need no type system.
 */

/** Leaf values a condition can carry — wire-safe by construction. */
export type FilterScalar = string | number | boolean | null;

export type FilterCondition =
	| { readonly op: "eq" | "neq"; readonly field: string; readonly value: FilterScalar }
	| { readonly op: "contains"; readonly field: string; readonly value: string }
	| { readonly op: "in"; readonly field: string; readonly values: readonly FilterScalar[] }
	| {
			readonly op: "gt" | "gte" | "lt" | "lte";
			readonly field: string;
			readonly value: string | number;
	  }
	| { readonly op: "exists"; readonly field: string };

export interface FilterAnd {
	readonly op: "and";
	readonly args: readonly FilterExpr[];
}
export interface FilterOr {
	readonly op: "or";
	readonly args: readonly FilterExpr[];
}
export interface FilterNot {
	readonly op: "not";
	readonly arg: FilterExpr;
}

export type FilterExpr = FilterCondition | FilterAnd | FilterOr | FilterNot;

const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);

export const FilterConditionSchema = Schema.Union([
	Schema.Struct({
		op: Schema.Literals(["eq", "neq"]),
		field: Schema.String,
		value: Scalar,
	}),
	Schema.Struct({ op: Schema.Literal("contains"), field: Schema.String, value: Schema.String }),
	Schema.Struct({ op: Schema.Literal("in"), field: Schema.String, values: Schema.Array(Scalar) }),
	Schema.Struct({
		op: Schema.Literals(["gt", "gte", "lt", "lte"]),
		field: Schema.String,
		value: Schema.Union([Schema.String, Schema.Number]),
	}),
	Schema.Struct({ op: Schema.Literal("exists"), field: Schema.String }),
]);

export const FilterExprSchema: Schema.Schema<FilterExpr> = Schema.suspend(() =>
	Schema.Union([
		FilterConditionSchema,
		Schema.Struct({
			op: Schema.Literals(["and", "or"]),
			args: Schema.Array(FilterExprSchema),
		}),
		Schema.Struct({ op: Schema.Literal("not"), arg: FilterExprSchema }),
	]),
);

/** Decode wire input into a validated {@link FilterExpr}. The recursive
 * schema is service-free, but Schema.suspend can't prove it at the type
 * level (DecodingServices stays unknown) — the cast restates that fact
 * once here instead of at every call site. */
export const decodeFilterExpr = Schema.decodeUnknownSync(
	FilterExprSchema as unknown as Schema.ConstraintDecoder<FilterExpr>,
);

/** Field access is caller-declared: the engine never reaches into
 * domain objects on its own, so typos in field names fail predictably
 * (unknown fields read as undefined → exists/eq false) rather than
 * leaking arbitrary property access. */
export type FilterAccessors<T> = Readonly<Record<string, (subject: T) => unknown>>;

const normalize = (value: unknown): unknown => {
	if (value instanceof Date) return value.toISOString();
	return value;
};

const compareValues = (a: unknown, b: string | number): number => {
	const left = normalize(a);
	const right = normalize(b) ?? b;
	if (typeof left === "number" && typeof right === "number") return left - right;
	return String(left).localeCompare(String(right));
};

const evaluateCondition = <T>(
	cond: FilterCondition,
	subject: T,
	accessors: FilterAccessors<T>,
): boolean => {
	const read = accessors[cond.field];
	const value = read === undefined ? undefined : normalize(read(subject));
	switch (cond.op) {
		case "exists":
			return value !== undefined && value !== null && value !== "";
		case "eq":
			return value === normalize(cond.value);
		case "neq":
			return value !== normalize(cond.value);
		case "contains": {
			if (Array.isArray(value))
				return value.some(
					(entry) =>
						typeof entry === "string" && entry.toLowerCase().includes(cond.value.toLowerCase()),
				);
			return typeof value === "string" && value.toLowerCase().includes(cond.value.toLowerCase());
		}
		case "in":
			return cond.values.some((candidate) => value === normalize(candidate));
		case "gt":
			return value !== undefined && value !== null && compareValues(value, cond.value) > 0;
		case "gte":
			return value !== undefined && value !== null && compareValues(value, cond.value) >= 0;
		case "lt":
			return value !== undefined && value !== null && compareValues(value, cond.value) < 0;
		case "lte":
			return value !== undefined && value !== null && compareValues(value, cond.value) <= 0;
	}
};

/** Pure predicate evaluation of a filter against one subject. */
export const evaluateFilter = <T>(
	expr: FilterExpr,
	subject: T,
	accessors: FilterAccessors<T>,
): boolean => {
	if (expr.op === "and") return expr.args.every((arg) => evaluateFilter(arg, subject, accessors));
	if (expr.op === "or") return expr.args.some((arg) => evaluateFilter(arg, subject, accessors));
	if (expr.op === "not") return !evaluateFilter(expr.arg, subject, accessors);
	return evaluateCondition(expr, subject, accessors);
};

export interface FilterPartition {
	/** Subtree the provider can honor natively — null when nothing pushes. */
	readonly push: FilterExpr | null;
	/** Subtree that must be evaluated locally — null when nothing remains. */
	readonly residual: FilterExpr | null;
}

const andOf = (args: readonly FilterExpr[]): FilterExpr | null => {
	if (args.length === 0) return null;
	if (args.length === 1) return args[0] ?? null;
	return { op: "and", args };
};

/**
 * Split an expression into pushdown and residual subtrees. `canPushTree`
 * answers for a whole subtree, so the caller — not the engine — owns
 * the semantics of what combinations its provider can express (Google,
 * for instance, pushes leaf conditions and conjunctions of them, but
 * never a disjunction: repeating a query param is AND, not OR). Only
 * conjunctions branch partially — a tree the provider can't honor as a
 * unit falls entirely to the local side, because filtering half of a
 * disjunction or negation provider-side would silently narrow or widen
 * the result set.
 */
export const partitionFilter = (
	expr: FilterExpr,
	canPushTree: (expr: FilterExpr) => boolean,
): FilterPartition => {
	if (canPushTree(expr)) return { push: expr, residual: null };
	if (expr.op !== "and") return { push: null, residual: expr };
	const pushed: FilterExpr[] = [];
	const remaining: FilterExpr[] = [];
	for (const arg of expr.args) {
		const inner = partitionFilter(arg, canPushTree);
		if (inner.push !== null) pushed.push(inner.push);
		if (inner.residual !== null) remaining.push(inner.residual);
	}
	return { push: andOf(pushed), residual: andOf(remaining) };
};

/** Convenience over {@link partitionFilter} + {@link evaluateFilter}:
 * apply the residual side of an already-partitioned expression to a
 * list of provider-returned rows. */
export const applyResidual = <T>(
	partition: FilterPartition,
	rows: readonly T[],
	accessors: FilterAccessors<T>,
): readonly T[] => {
	if (partition.residual === null) return rows;
	const residual = partition.residual;
	return rows.filter((row) => evaluateFilter(residual, row, accessors));
};
