import { describe, expect, it } from "vitest";

import {
	assertCondition,
	evaluateCondition,
	jsonEquals,
	resolveAnswerPath,
	type WizardCondition,
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

	it("rejects malformed payloads", () => {
		const bad: readonly unknown[] = [
			null,
			"x",
			[],
			{ all: "nope" },
			{ any: {} },
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
});

describe("resolveAnswerPath", () => {
	const answers = { step: { items: ["a", "b"], flag: true }, n: 3 };

	it("resolves dot paths and array indices", () => {
		expect(resolveAnswerPath(answers, "step.items.1")).toBe("b");
		expect(resolveAnswerPath(answers, "step.flag")).toBe(true);
		expect(resolveAnswerPath(answers, "n")).toBe(3);
	});

	it("returns undefined for missing or mistyped segments", () => {
		expect(resolveAnswerPath(answers, "missing.deep.path")).toBeUndefined();
		expect(resolveAnswerPath(answers, "step.items.x")).toBeUndefined();
		expect(resolveAnswerPath(answers, "n.child")).toBeUndefined();
		expect(resolveAnswerPath(answers, "step.items.9")).toBeUndefined();
		expect(resolveAnswerPath(null, "a")).toBeUndefined();
		expect(resolveAnswerPath(undefined, "a.b")).toBeUndefined();
	});
});

describe("evaluateCondition", () => {
	const answers = { contact: { email: "a@b.c", age: 30 }, tags: ["x", "y"], done: true };

	it("evaluates leaf ops", () => {
		const cases: ReadonlyArray<readonly [WizardCondition, boolean]> = [
			[{ path: "contact.email" }, false], // default eq needs value
			[{ path: "contact.email", value: "a@b.c" }, true],
			[{ path: "contact.email", op: "eq", value: "a@b.c" }, true],
			[{ path: "contact.email", op: "ne", value: "z@z.z" }, true],
			[{ path: "contact.age", op: "gt", value: 18 }, true],
			[{ path: "contact.age", op: "gte", value: 30 }, true],
			[{ path: "contact.age", op: "lt", value: 30 }, false],
			[{ path: "contact.age", op: "lte", value: 30 }, true],
			[{ path: "contact.age", op: "gt", value: "x" }, false],
			[{ path: "done", op: "gt", value: true }, false], // same-type non-comparable
			[{ path: "tags", op: "lt", value: {} }, false],
			[{ path: "missing", op: "gt", value: 1 }, false],
			[{ path: "contact.email", op: "gt", value: 1 }, false],
			[{ path: "tags", op: "in", value: ["x"] }, false], // path resolves array; in checks membership of value list
			[{ path: "done", op: "in", value: [true, false] }, true],
			[{ path: "done", op: "in", value: "nope" }, false],
			[{ path: "contact.email", op: "exists" }, true],
			[{ path: "nope", op: "exists" }, false],
			[{ path: "done", op: "truthy" }, true],
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
});
