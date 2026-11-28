import { describe, expect, it } from "vitest";

import {
	applyResidual,
	decodeFilterExpr,
	evaluateFilter,
	partitionFilter,
	type FilterAccessors,
	type FilterExpr,
} from "./index.ts";

interface Row {
	readonly title: string;
	readonly startsAt: Date;
	readonly location: string | null;
	readonly attendees: readonly string[];
	readonly tags: readonly string[];
	readonly priority: number;
}

const accessors: FilterAccessors<Row> = {
	title: (r) => r.title,
	startsAt: (r) => r.startsAt,
	location: (r) => r.location,
	attendees: (r) => r.attendees,
	tags: (r) => r.tags,
	priority: (r) => r.priority,
};

const row: Row = {
	title: "Consulta Maria",
	startsAt: new Date("2025-06-10T14:00:00Z"),
	location: "Clínica Central",
	attendees: ["maria@example.com", "dr@example.com"],
	tags: ["retorno", "vip"],
	priority: 3,
};

describe("evaluateFilter", () => {
	it("eq/neq compare scalars with date normalization", () => {
		expect(
			evaluateFilter({ op: "eq", field: "title", value: "Consulta Maria" }, row, accessors),
		).toBe(true);
		expect(
			evaluateFilter({ op: "neq", field: "title", value: "Consulta Maria" }, row, accessors),
		).toBe(false);
		expect(
			evaluateFilter(
				{ op: "eq", field: "startsAt", value: "2025-06-10T14:00:00.000Z" },
				row,
				accessors,
			),
		).toBe(true);
	});

	it("contains matches case-insensitively on strings and arrays", () => {
		expect(evaluateFilter({ op: "contains", field: "title", value: "maria" }, row, accessors)).toBe(
			true,
		);
		expect(
			evaluateFilter({ op: "contains", field: "attendees", value: "MARIA@" }, row, accessors),
		).toBe(true);
		expect(evaluateFilter({ op: "contains", field: "title", value: "joão" }, row, accessors)).toBe(
			false,
		);
	});

	it("in checks membership", () => {
		expect(evaluateFilter({ op: "in", field: "priority", values: [1, 3] }, row, accessors)).toBe(
			true,
		);
	});

	it("ordering operators compare ISO dates lexicographically", () => {
		expect(
			evaluateFilter({ op: "gte", field: "startsAt", value: "2025-06-01" }, row, accessors),
		).toBe(true);
		expect(
			evaluateFilter({ op: "lt", field: "startsAt", value: "2025-06-01" }, row, accessors),
		).toBe(false);
		expect(evaluateFilter({ op: "lt", field: "priority", value: 5 }, row, accessors)).toBe(true);
	});

	it("exists treats null and empty as absent", () => {
		expect(evaluateFilter({ op: "exists", field: "location" }, row, accessors)).toBe(true);
		expect(
			evaluateFilter({ op: "exists", field: "location" }, { ...row, location: null }, accessors),
		).toBe(false);
		expect(evaluateFilter({ op: "exists", field: "unknown-field" }, row, accessors)).toBe(false);
	});

	it("and/or/not compose", () => {
		const expr: FilterExpr = {
			op: "and",
			args: [
				{ op: "contains", field: "title", value: "maria" },
				{
					op: "or",
					args: [
						{ op: "eq", field: "priority", value: 4 },
						{ op: "eq", field: "priority", value: 3 },
					],
				},
				{ op: "not", arg: { op: "contains", field: "location", value: "norte" } },
			],
		};
		expect(evaluateFilter(expr, row, accessors)).toBe(true);
	});
});

describe("partitionFilter", () => {
	const pushable = new Set(["startsAt", "title"]);
	const canPush = (expr: FilterExpr): boolean => {
		if (expr.op === "and") return expr.args.every(canPush);
		if (expr.op === "or" || expr.op === "not") return false;
		return pushable.has(expr.field);
	};

	it("splits conjunctions child-by-child", () => {
		const expr: FilterExpr = {
			op: "and",
			args: [
				{ op: "gte", field: "startsAt", value: "2025-06-01" },
				{ op: "contains", field: "location", value: "central" },
			],
		};
		const partition = partitionFilter(expr, canPush);
		expect(partition.push).toEqual({ op: "gte", field: "startsAt", value: "2025-06-01" });
		expect(partition.residual).toEqual({ op: "contains", field: "location", value: "central" });
	});

	it("never partially pushes a disjunction", () => {
		const expr: FilterExpr = {
			op: "or",
			args: [
				{ op: "contains", field: "title", value: "a" },
				{ op: "contains", field: "location", value: "b" },
			],
		};
		const partition = partitionFilter(expr, canPush);
		expect(partition.push).toBeNull();
		expect(partition.residual).toEqual(expr);
	});

	it("pushes a fully pushable tree whole", () => {
		const expr: FilterExpr = {
			op: "and",
			args: [
				{ op: "gte", field: "startsAt", value: "2025-06-01" },
				{ op: "contains", field: "title", value: "a" },
			],
		};
		const partition = partitionFilter(expr, canPush);
		expect(partition.push).toEqual(expr);
		expect(partition.residual).toBeNull();
	});

	it("applyResidual filters rows with the residual side only", () => {
		const expr: FilterExpr = {
			op: "and",
			args: [
				{ op: "gte", field: "startsAt", value: "2025-06-01" },
				{ op: "contains", field: "location", value: "central" },
			],
		};
		const partition = partitionFilter(expr, canPush);
		const rows = applyResidual(partition, [row, { ...row, location: "Outro lugar" }], accessors);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.location).toBe("Clínica Central");
	});
});

describe("FilterExprSchema", () => {
	it("round-trips a valid expression and rejects garbage", () => {
		const expr: FilterExpr = {
			op: "and",
			args: [
				{ op: "gte", field: "startsAt", value: "2025-06-01T00:00:00.000Z" },
				{ op: "in", field: "eventType", values: ["default"] },
			],
		};
		const decoded = decodeFilterExpr(expr);
		expect(decoded).toEqual(expr);
		expect(() => decodeFilterExpr({ op: "xor", args: [] })).toThrow();
	});
});
