import { describe, expect, it } from "vitest";

import {
	assertCondition,
	evaluateCondition,
	jsonEquals,
	MAX_CONDITION_DEPTH,
	type Condition,
} from "./condition.ts";

describe("assertCondition", () => {
	it("accepts leaf, all, any and not shapes", () => {
		expect(assertCondition({ path: "a.b", op: "eq", value: 1 }, "ctx")).toEqual({
			path: "a.b",
			op: "eq",
			value: 1,
		});
		expect(
			assertCondition({ all: [{ path: "x" }, { any: [{ path: "y", op: "truthy" }] }] }, "ctx"),
		).toBeDefined();
		expect(assertCondition({ not: { path: "z" } }, "ctx")).toBeDefined();
	});

	it("accepts every documented op", () => {
		const ops = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "exists", "truthy"] as const;
		for (const op of ops) {
			expect(() => assertCondition({ path: "a", op }, "ctx")).not.toThrow();
		}
	});

	it("rejects malformed payloads", () => {
		const bad: readonly unknown[] = [
			null,
			"x",
			[],
			{ all: "nope" },
			{ all: ["x"] },
			{ any: {} },
			{ any: ["x"] },
			{ not: "nope" },
			{ path: "" },
			{ path: 3 },
			{ path: "a", op: "bogus" },
			{ path: "a", op: 7 },
			{ path: "a", op: "exists", value: 1 },
			{ path: "a", op: "truthy", value: false },
			{ all: [{ nope: true }] },
		];
		for (const value of bad) {
			expect(() => assertCondition(value, "ctx")).toThrow("ctx");
		}
	});

	it("accepts conditions nested exactly MAX_CONDITION_DEPTH deep", () => {
		let cond: Condition = { path: "a" };
		for (let i = 0; i < MAX_CONDITION_DEPTH; i += 1) {
			cond = { not: cond };
		}
		expect(() => assertCondition(cond, "ctx")).not.toThrow();
	});

	it("rejects conditions nested past MAX_CONDITION_DEPTH", () => {
		let cond: Condition = { path: "a" };
		for (let i = 0; i <= MAX_CONDITION_DEPTH; i += 1) {
			cond = { not: cond };
		}
		expect(() => assertCondition(cond, "ctx")).toThrow("nesting exceeds");
	});

	it("rejects over-depth all/any nesting and reports the path context", () => {
		let allCond: Condition = { path: "a" };
		for (let i = 0; i <= MAX_CONDITION_DEPTH; i += 1) {
			allCond = { all: [allCond] };
		}
		expect(() => assertCondition(allCond, "ctx")).toThrow("nesting exceeds");
		let anyCond: Condition = { path: "a" };
		for (let i = 0; i <= MAX_CONDITION_DEPTH; i += 1) {
			anyCond = { any: [anyCond] };
		}
		expect(() => assertCondition(anyCond, "ctx")).toThrow("ctx.any[0]");
	});
});

describe("jsonEquals", () => {
	it("compares primitives, arrays and objects", () => {
		expect(jsonEquals(1, 1)).toBe(true);
		expect(jsonEquals("a", "a")).toBe(true);
		expect(jsonEquals(null, null)).toBe(true);
		expect(jsonEquals(1, "1")).toBe(false);
		expect(jsonEquals([1, { a: 2 }], [1, { a: 2 }])).toBe(true);
		expect(jsonEquals([1, 2], [2, 1])).toBe(false);
		expect(jsonEquals({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
		expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(jsonEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false);
		expect(jsonEquals([1], { 0: 1 })).toBe(false);
		expect(jsonEquals(undefined, undefined)).toBe(true);
		expect(jsonEquals(undefined, null)).toBe(false);
	});

	it("returns false for differing primitives and mismatched types", () => {
		expect(jsonEquals(1, 2)).toBe(false);
		expect(jsonEquals("a", "b")).toBe(false);
		expect(jsonEquals(null, { a: 1 })).toBe(false);
		expect(jsonEquals({ a: 1 }, null)).toBe(false);
		expect(jsonEquals({ a: 1 }, undefined)).toBe(false);
		expect(jsonEquals({}, () => {})).toBe(false);
	});

	it("compares arrays element-wise and rejects array/object mixes", () => {
		expect(jsonEquals([1], [2])).toBe(false);
		expect(jsonEquals([1, 2], [1, 9])).toBe(false);
		expect(jsonEquals([1, 2], [1, 2, 3])).toBe(false);
		expect(jsonEquals([1, 2], { 0: 1, 1: 2, length: 2 })).toBe(false);
	});

	it("compares objects key-by-key", () => {
		expect(jsonEquals({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
		expect(jsonEquals({ a: 1 }, { b: 1 })).toBe(false);
	});
});

describe("evaluateCondition", () => {
	const answers = {
		contact: { email: "a@b.c", age: 30 },
		tags: ["x", "y"],
		done: true,
		flag: false,
		zero: 0,
		nil: null,
	};

	it("evaluates leaf ops", () => {
		const cases: ReadonlyArray<readonly [Condition, boolean]> = [
			[{ path: "contact.email" }, false], // default eq needs value
			[{ path: "contact.email", value: "a@b.c" }, true],
			[{ path: "contact.email", op: "eq", value: "a@b.c" }, true],
			[{ path: "contact.email", op: "ne", value: "z@z.z" }, true],
			[{ path: "contact.age", op: "gt", value: 18 }, true],
			[{ path: "contact.age", op: "gt", value: 30 }, false],
			[{ path: "contact.age", op: "gt", value: 40 }, false],
			[{ path: "contact.age", op: "gt", value: "10" }, false], // cross-type never orders
			[{ path: "contact.age", op: "gte", value: 29 }, true],
			[{ path: "contact.age", op: "gte", value: 30 }, true],
			[{ path: "contact.age", op: "gte", value: 31 }, false],
			[{ path: "contact.age", op: "lt", value: 30 }, false],
			[{ path: "contact.age", op: "lt", value: 31 }, true],
			[{ path: "contact.age", op: "lte", value: 30 }, true],
			[{ path: "contact.age", op: "lte", value: 29 }, false],
			[{ path: "contact.age", op: "gt", value: "x" }, false],
			[{ path: "done", op: "gt", value: true }, false], // same-type non-comparable
			[{ path: "done", op: "gte", value: true }, false], // booleans are not ordered
			[{ path: "tags", op: "lt", value: {} }, false],
			[{ path: "missing", op: "gt", value: 1 }, false],
			[{ path: "contact.email", op: "gt", value: 1 }, false],
			[{ path: "tags", op: "in", value: ["x"] }, false], // path resolves array; in checks membership of value list
			[{ path: "done", op: "in", value: [true, false] }, true],
			[{ path: "done", op: "in", value: "nope" }, false],
			[{ path: "contact.email", op: "exists" }, true],
			[{ path: "nope", op: "exists" }, false],
			[{ path: "flag", op: "exists" }, true], // defined but falsey still exists
			[{ path: "zero", op: "exists" }, true],
			[{ path: "nil", op: "exists" }, true], // null is defined
			[{ path: "done", op: "truthy" }, true],
			[{ path: "flag", op: "truthy" }, false],
			[{ path: "nope", op: "truthy" }, false],
			// default op is eq against `undefined` — a missing path with no
			// expected value counts as equal (documented DSL semantics).
			[{ path: "nope" }, true],
			[{ path: "nope", value: 1 }, false],
			[{ path: "contact.age", op: "eq", value: { deep: [1] } }, false],
		];
		for (const [cond, expected] of cases) {
			expect(evaluateCondition(cond, answers)).toBe(expected);
		}
	});

	it("evaluates string ordering", () => {
		expect(evaluateCondition({ path: "contact.email", op: "gt", value: "a" }, answers)).toBe(true);
		expect(evaluateCondition({ path: "contact.email", op: "lt", value: "zzz" }, answers)).toBe(
			true,
		);
	});

	it("evaluates all/any/not recursively", () => {
		expect(
			evaluateCondition(
				{
					all: [
						{ path: "done", op: "truthy" },
						{ any: [{ path: "contact.age", op: "gt", value: 18 }, { path: "nope" }] },
					],
				},
				answers,
			),
		).toBe(true);
		expect(evaluateCondition({ all: [] }, answers)).toBe(true);
		expect(evaluateCondition({ any: [] }, answers)).toBe(false);
		expect(evaluateCondition({ not: { path: "done", op: "truthy" } }, answers)).toBe(false);
		expect(evaluateCondition({ not: { path: "nope", value: 1 } }, answers)).toBe(true);
	});

	it("evaluates conditions nested exactly MAX_CONDITION_DEPTH deep", () => {
		let cond: Condition = { path: "done", op: "truthy" };
		for (let i = 0; i < MAX_CONDITION_DEPTH; i += 1) {
			cond = { all: [cond] };
		}
		expect(evaluateCondition(cond, answers)).toBe(true);
	});

	it("fails closed past the recursion depth cap", () => {
		// Hand-built (unasserted) condition nested deeper than the cap —
		// evaluateCondition must not recurse into it. `all` (not `not`)
		// keeps the over-depth false from being negated back to true.
		let cond: Condition = { path: "done", op: "truthy" };
		for (let i = 0; i <= MAX_CONDITION_DEPTH; i += 1) {
			cond = { all: [cond] };
		}
		expect(evaluateCondition(cond, answers)).toBe(false);
	});

	it("fails closed for over-depth any nesting", () => {
		let cond: Condition = { path: "done", op: "truthy" };
		for (let i = 0; i <= MAX_CONDITION_DEPTH; i += 1) {
			cond = { any: [cond] };
		}
		expect(evaluateCondition(cond, answers)).toBe(false);
	});

	it("fails closed for over-depth not nesting", () => {
		// 34 `not` wraps: the node past the cap evaluates false, then the
		// 33 in-cap negations flip it back — the result is true. A mutant
		// that under-counts depth evaluates the (false) leaf through all
		// 34 negations and returns false instead.
		let cond: Condition = { path: "nope", value: 1 };
		for (let i = 0; i < MAX_CONDITION_DEPTH + 2; i += 1) {
			cond = { not: cond };
		}
		expect(evaluateCondition(cond, answers)).toBe(true);
	});

	it("fails closed on malformed (unvalidated) condition shapes", () => {
		// Hand-built/DB-sourced defs that skipped assertCondition must
		// evaluate false — never throw a TypeError defect.
		const malformed: readonly unknown[] = [
			5,
			null,
			"x",
			[],
			{ all: "yes" },
			{ all: {} },
			{ any: "x" },
			{ any: {} },
			{ not: 5 },
			{ not: null },
			{ not: "x" },
			{ path: 5 },
			{ path: "" },
			{ path: "a", op: "bogus" },
			{ all: [null] },
			{ any: [5] },
			{ all: [{ path: "done", op: "truthy" }, "junk"] },
		];
		for (const cond of malformed) {
			expect(evaluateCondition(cond as unknown as Condition, answers)).toBe(false);
		}
	});
});
