import { describe, expect, it } from "vitest";

import {
	REGEX_MAX_PATTERN_LENGTH,
	clampLimit,
	clampOffset,
	compileFilter,
	compareData,
	getPath,
	jsonEqual,
	matchFilter,
	normalizeSort,
	validateFilter,
	validateSort,
} from "./query.ts";

const doc = {
	name: "alpha",
	count: 3,
	nested: { deep: { value: 7 }, list: [10, 20] },
	tags: ["x", "y"],
	flag: true,
};

describe("getPath / jsonEqual", () => {
	it("reads dotted paths through objects and arrays", () => {
		expect(getPath(doc, "name")).toBe("alpha");
		expect(getPath(doc, "nested.deep.value")).toBe(7);
		expect(getPath(doc, "nested.list.1")).toBe(20);
		expect(getPath(doc, "nested.list.x")).toBeUndefined();
		expect(getPath(doc, "missing.deep")).toBeUndefined();
		expect(getPath(doc, "name.first")).toBeUndefined();
		expect(getPath({ a: null }, "a.b")).toBeUndefined();
	});

	it("compares JSON structurally", () => {
		expect(jsonEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
		expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
		expect(jsonEqual([1, [2]], [1, [2]])).toBe(true);
		expect(jsonEqual(null, null)).toBe(true);
		expect(jsonEqual(0, -0)).toBe(true);
		expect(jsonEqual("1", 1)).toBe(false);
	});
});

describe("matchFilter", () => {
	it("matches literal equality (implicit $eq, incl. objects)", () => {
		expect(matchFilter(doc, { name: "alpha" })).toBe(true);
		expect(matchFilter(doc, { name: "beta" })).toBe(false);
		expect(matchFilter(doc, { count: { $eq: 3 } })).toBe(true);
		expect(matchFilter(doc, { count: { $eq: 4 } })).toBe(false);
		// Literal object conditions compare structurally at that path.
		expect(matchFilter(doc, { tags: ["x", "y"] })).toBe(true);
		expect(matchFilter(doc, { tags: ["x"] })).toBe(false);
		expect(matchFilter(doc, { nested: doc.nested })).toBe(true);
	});

	it("matches dotted paths", () => {
		expect(matchFilter(doc, { "nested.deep.value": 7 })).toBe(true);
		expect(matchFilter(doc, { "nested.deep.value": 8 })).toBe(false);
	});

	it("ordered operators compare numbers and strings", () => {
		// actual count = 3: operand is the threshold.
		for (const [op, pass, fail] of [
			["$gt", 2, 3],
			["$gte", 3, 4],
			["$lt", 4, 3],
			["$lte", 3, 2],
		] as const) {
			expect(matchFilter(doc, { count: { [op]: pass } })).toBe(true);
			expect(matchFilter(doc, { count: { [op]: fail } })).toBe(false);
		}
		expect(matchFilter(doc, { name: { $gt: "a" } })).toBe(true);
		// Equal strings: ordered compare returns 0.
		expect(matchFilter(doc, { name: { $gte: "alpha" } })).toBe(true);
		expect(matchFilter(doc, { name: { $lte: "alpha" } })).toBe(true);
		// Mixed types fall back to string coercion (keeps < total).
		expect(matchFilter(doc, { count: { $gte: "3" } })).toBe(true); // "3" === "3"
		expect(matchFilter(doc, { count: { $gt: "2" } })).toBe(true); // "3" > "2"
		expect(matchFilter(doc, { count: { $gt: "a" } })).toBe(false); // "3" < "a"
		expect(matchFilter(doc, { count: { $lt: "a" } })).toBe(true);
		expect(matchFilter(doc, { name: { $lt: "a" } })).toBe(false);
	});

	it("$ne / $in / $nin", () => {
		expect(matchFilter(doc, { name: { $ne: "beta" } })).toBe(true);
		expect(matchFilter(doc, { name: { $ne: "alpha" } })).toBe(false);
		expect(matchFilter(doc, { name: { $in: ["alpha", "z"] } })).toBe(true);
		expect(matchFilter(doc, { name: { $in: ["z"] } })).toBe(false);
		expect(matchFilter(doc, { name: { $in: "alpha" } })).toBe(false);
		expect(matchFilter(doc, { name: { $nin: ["z"] } })).toBe(true);
		expect(matchFilter(doc, { name: { $nin: ["alpha"] } })).toBe(false);
		expect(matchFilter(doc, { name: { $nin: "alpha" } })).toBe(true);
	});

	it("$exists treats null and undefined as absent", () => {
		expect(matchFilter(doc, { name: { $exists: true } })).toBe(true);
		expect(matchFilter(doc, { missing: { $exists: true } })).toBe(false);
		expect(matchFilter(doc, { missing: { $exists: false } })).toBe(true);
		expect(matchFilter(doc, { name: { $exists: false } })).toBe(false);
		const withNull = { ...doc, nothing: null };
		expect(matchFilter(withNull, { nothing: { $exists: true } })).toBe(false);
		expect(matchFilter(withNull, { nothing: { $exists: false } })).toBe(true);
	});

	it("$regex matches strings", () => {
		expect(matchFilter(doc, { name: { $regex: "^alp" } })).toBe(true);
		expect(matchFilter(doc, { name: { $regex: "^z" } })).toBe(false);
		expect(matchFilter(doc, { count: { $regex: "3" } })).toBe(false);
		expect(matchFilter(doc, { name: { $regex: 5 } })).toBe(false);
		// Case-sensitive: no flag support in the DSL.
		expect(matchFilter(doc, { name: { $regex: "^ALP" } })).toBe(false);
		// Precompiled RegExp operands (compileFilter output) match too.
		expect(matchFilter(doc, { name: { $regex: /^alp/ } })).toBe(true);
		expect(matchFilter(doc, { name: { $regex: /^ALP/ } })).toBe(false);
	});

	it("unknown operators fail closed", () => {
		expect(matchFilter(doc, { name: { $bogus: 1 } })).toBe(false);
	});

	it("$and / $or combine sub-filters", () => {
		const filter = {
			$or: [{ name: "beta" }, { count: { $gte: 3 } }],
			$and: [{ flag: true }, { "nested.deep.value": { $gt: 5 } }],
		};
		expect(matchFilter(doc, filter)).toBe(true);
		expect(matchFilter(doc, { $and: [{ name: "alpha" }, { count: 4 }] })).toBe(false);
		expect(matchFilter(doc, { $or: [{ name: "beta" }, { name: "alpha" }] })).toBe(true);
		expect(matchFilter(doc, { $or: [{ name: "beta" }] })).toBe(false);
		expect(matchFilter(doc, { $and: "nope" })).toBe(false);
		expect(matchFilter(doc, { $or: [] })).toBe(false);
	});

	it("undefined filter matches everything", () => {
		expect(matchFilter(doc, undefined)).toBe(true);
		expect(matchFilter(doc, {})).toBe(true);
	});
});

describe("normalizeSort / compareData", () => {
	it("normalizes string and object terms", () => {
		expect(normalizeSort(undefined)).toEqual([]);
		expect(normalizeSort("name")).toEqual([{ field: "name", dir: "asc" }]);
		expect(normalizeSort(["name", { field: "count", dir: "desc" }])).toEqual([
			{ field: "name", dir: "asc" },
			{ field: "count", dir: "desc" },
		]);
	});

	it("sorts ascending, descending, missing-last, stably", () => {
		const rows = [
			{ a: 2 },
			{ a: 1 },
			{ b: 1 }, // missing a
			{ a: 1 },
		];
		const asc = [...rows].sort(compareData(normalizeSort("a")));
		expect(asc.map((r) => (r as { a?: number }).a)).toEqual([1, 1, 2, undefined]);
		const desc = [...rows].sort(compareData(normalizeSort([{ field: "a", dir: "desc" }])));
		expect(desc.map((r) => (r as { a?: number }).a)).toEqual([2, 1, 1, undefined]);
		// both missing → equal → stable order kept
		const both = [{}, {}].sort(compareData(normalizeSort("x")));
		expect(both).toHaveLength(2);
	});
});

describe("clamps", () => {
	it("clamps limit and offset", () => {
		expect(clampLimit(undefined)).toBe(100);
		expect(clampLimit(0)).toBe(1);
		expect(clampLimit(50)).toBe(50);
		expect(clampLimit(9999)).toBe(500);
		expect(clampLimit(NaN)).toBe(100);
		expect(clampOffset(undefined)).toBe(0);
		expect(clampOffset(-3)).toBe(0);
		expect(clampOffset(7.9)).toBe(7);
		expect(clampOffset(Infinity)).toBe(0);
	});
});

describe("validateFilter", () => {
	it("accepts valid filters", () => {
		expect(
			validateFilter({ a: { $gt: 1, $lt: 5 }, $or: [{ b: 1 }], $and: [{ c: { $regex: "^x" } }] }),
		).toEqual([]);
	});

	it("rejects non-object filters", () => {
		expect(validateFilter("x")).toHaveLength(1);
		expect(validateFilter(null)).toHaveLength(1);
	});

	it("rejects bad combinators and operators", () => {
		expect(validateFilter({ $and: [] })[0]).toContain("$and");
		expect(validateFilter({ $or: "x" })[0]).toContain("$or");
		expect(validateFilter({ $and: [{ a: { $bogus: 1 } }] })[0]).toContain("$bogus");
		expect(validateFilter({ a: { $in: 1 } })[0]).toContain("$in");
		expect(validateFilter({ a: { $nin: "x" } })[0]).toContain("$nin");
		expect(validateFilter({ a: { $exists: 1 } })[0]).toContain("$exists");
		expect(validateFilter({ a: { $regex: 5 } })[0]).toContain("$regex");
		expect(validateFilter({ a: { $regex: "([" } })[0]).toContain("pattern");
	});

	it("rejects over-long and catastrophically-nested $regex patterns", () => {
		const long = "a".repeat(REGEX_MAX_PATTERN_LENGTH + 1);
		expect(validateFilter({ a: { $regex: long } })[0]).toContain("exceeds");
		expect(validateFilter({ a: { $regex: "a".repeat(REGEX_MAX_PATTERN_LENGTH) } })).toEqual([]);
		for (const nested of ["(a+)+", "(\\d*)*", "(x{2,}){3}", "(a?)+"]) {
			const issues = validateFilter({ a: { $regex: nested } });
			expect(issues[0]).toContain("nested quantifiers");
		}
		// Ordinary grouped/quantified patterns still pass.
		expect(validateFilter({ a: { $regex: "^(ab|cd)+$" } })).toEqual([]);
		expect(validateFilter({ a: { $regex: "a{2,3}" } })).toEqual([]);
	});
});

describe("compileFilter", () => {
	it("precompiles $regex operands once, recursively", () => {
		const filter = {
			name: { $regex: "^alp", $ne: "zzz" },
			$or: [{ count: { $gt: 1 } }, { tag: { $regex: "x$" } }],
			flag: true,
		};
		const compiled = compileFilter(filter);
		expect(compiled).toBeDefined();
		const nameCond = (compiled as Record<string, Record<string, unknown>>).name;
		expect(nameCond.$regex).toBeInstanceOf(RegExp);
		expect((nameCond.$regex as RegExp).source).toBe("^alp");
		expect(nameCond.$ne).toBe("zzz"); // sibling operators untouched
		const orSub = (compiled as { $or: Record<string, Record<string, unknown>>[] }).$or;
		expect(orSub[1]!.tag.$regex).toBeInstanceOf(RegExp);
		// Original filter is not mutated.
		expect(filter.name.$regex).toBe("^alp");
		// The compiled filter still matches through matchFilter.
		expect(matchFilter(doc, compiled)).toBe(true);
		expect(matchFilter(doc, compileFilter({ name: { $regex: "^z" } }))).toBe(false);
	});

	it("passes through undefined and non-regex filters", () => {
		expect(compileFilter(undefined)).toBeUndefined();
		const plain = { a: 1, b: { $gt: 2 } };
		expect(compileFilter(plain)).toEqual(plain);
		// Non-array $and/$or values pass through untouched.
		expect(compileFilter({ $and: "x" } as never)).toEqual({ $and: "x" });
		// Undefined sub-filters inside combinators collapse to {}.
		expect(compileFilter({ $and: [undefined, { a: 1 }] } as never)).toEqual({
			$and: [{}, { a: 1 }],
		});
		// An uncompilable pattern stays a string (fails closed downstream).
		const bad = compileFilter({ a: { $regex: "([" } });
		expect((bad as Record<string, { $regex: unknown }>).a.$regex).toBe("([");
	});
});

describe("validateSort", () => {
	it("accepts valid sorts", () => {
		expect(validateSort(undefined)).toEqual([]);
		expect(validateSort("name")).toEqual([]);
		expect(validateSort(["a", { field: "b", dir: "desc" }, { field: "c" }])).toEqual([]);
	});

	it("rejects malformed sorts", () => {
		expect(validateSort(5)[0]).toContain("sort");
		expect(validateSort([""])[0]).toContain("non-empty");
		expect(validateSort([5])[0]).toContain("sort[0]");
		expect(validateSort([{ dir: "asc" }])[0]).toContain("field");
		expect(validateSort([{ field: "a", dir: "up" }])[0]).toContain("dir");
		expect(validateSort([{ field: "a", dir: 1 }])[0]).toContain("dir");
	});
});
