import { describe, expect, it } from "vitest";

import type { ViewDef } from "./definition.ts";
import {
	buildFilter,
	filterParam,
	interactiveFilters,
	fixedFilters,
	parseFilterInput,
	planFind,
	VIEW_PAGE_SIZE_DEFAULT,
} from "./plan.ts";

const DEF: ViewDef = {
	id: "v",
	title: "V",
	collection: "c.d",
	kind: "table",
	fields: [{ field: "a" }],
};

describe("parseFilterInput", () => {
	it("parses JSON values and falls back to raw strings", () => {
		expect(parseFilterInput("5")).toBe(5);
		expect(parseFilterInput("true")).toBe(true);
		expect(parseFilterInput("null")).toBeNull();
		expect(parseFilterInput('["a","b"]')).toEqual(["a", "b"]);
		expect(parseFilterInput('{"x":1}')).toEqual({ x: 1 });
		expect(parseFilterInput("hello world")).toBe("hello world");
		expect(parseFilterInput("   ")).toBe("   ");
	});
});

describe("filterParam / interactiveFilters / fixedFilters", () => {
	const def: ViewDef = {
		...DEF,
		filters: [
			{ field: "a.b", op: "$eq", value: 1 },
			{ field: "c", op: "$regex", param: "q" },
		],
	};
	it("derives the param name and splits fixed vs interactive", () => {
		expect(filterParam({ field: "a.b", op: "$eq" })).toBe("a.b");
		expect(filterParam({ field: "c", op: "$eq", param: "p" })).toBe("p");
		expect(interactiveFilters(def).map((f) => f.field)).toEqual(["c"]);
		expect(fixedFilters(def).map((f) => f.field)).toEqual(["a.b"]);
		expect(interactiveFilters(DEF)).toEqual([]);
		expect(fixedFilters(DEF)).toEqual([]);
	});
});

describe("buildFilter", () => {
	it("returns undefined with no applicable filters", () => {
		expect(buildFilter(DEF, undefined)).toBeUndefined();
		expect(buildFilter(DEF, {})).toBeUndefined();
	});

	it("applies fixed filters unconditionally", () => {
		const def: ViewDef = { ...DEF, filters: [{ field: "a", op: "$eq", value: true }] };
		expect(buildFilter(def, {})).toEqual({ a: { $eq: true } });
	});

	it("applies interactive filters only for non-empty supplied values", () => {
		const def: ViewDef = {
			...DEF,
			filters: [
				{ field: "name", op: "$regex" },
				{ field: "age", op: "$gte", param: "minAge" },
			],
		};
		expect(buildFilter(def, {})).toBeUndefined();
		expect(buildFilter(def, { name: "   " })).toBeUndefined();
		expect(buildFilter(def, { name: "jo" })).toEqual({ name: { $regex: "jo" } });
		expect(buildFilter(def, { name: "jo", minAge: "18" })).toEqual({
			$and: [{ name: { $regex: "jo" } }, { age: { $gte: 18 } }],
		});
		// undeclared params are ignored
		expect(buildFilter(def, { other: "x" })).toBeUndefined();
	});
});

describe("planFind", () => {
	it("plans defaults: page size, zero offset, no filter/sort", () => {
		const planned = planFind(DEF);
		expect(planned.find).toEqual({ limit: VIEW_PAGE_SIZE_DEFAULT, offset: 0 });
		expect(planned.pageSize).toBe(VIEW_PAGE_SIZE_DEFAULT);
		expect(planned.offset).toBe(0);
	});

	it("honors def sort/pageSize and caller offset/values", () => {
		const def: ViewDef = {
			...DEF,
			pageSize: 10,
			sort: [{ field: "a", dir: "desc" }],
			filters: [{ field: "a", op: "$eq" }],
		};
		const planned = planFind(def, { offset: 20, values: { a: "1" } });
		expect(planned.find).toEqual({
			filter: { a: { $eq: 1 } },
			sort: [{ field: "a", dir: "desc" }],
			limit: 10,
			offset: 20,
		});
		expect(planned.pageSize).toBe(10);
		expect(planned.offset).toBe(20);
	});

	it("clamps negative offsets", () => {
		const planned = planFind(DEF, { offset: -5 });
		expect(planned.offset).toBe(0);
		expect(planned.find.offset).toBe(0);
	});
});
