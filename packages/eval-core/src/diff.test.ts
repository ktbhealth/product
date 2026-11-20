import { describe, expect, it } from "vitest";

import { applyEdits, EditApplyError, type EditOp } from "./diff.ts";

describe("applyEdits", () => {
	it("splices a single op", () => {
		const ops: EditOp[] = [{ at: 4, remove: "abc", insert: "XYZ", kind: "fix" }];
		expect(applyEdits("foo abc bar", ops)).toBe("foo XYZ bar");
	});

	it("applies multiple ops independently of order", () => {
		const ops: EditOp[] = [
			{ at: 0, remove: "foo", insert: "one", kind: "fix" },
			{ at: 8, remove: "baz", insert: "three", kind: "fix" },
		];
		expect(applyEdits("foo bar baz", ops)).toBe("one bar three");
	});

	it("supports pure insertion and pure deletion", () => {
		expect(applyEdits("ab", [{ at: 2, remove: "", insert: "c", kind: "fix" }])).toBe("abc");
		expect(applyEdits("abc", [{ at: 2, remove: "c", insert: "", kind: "fix" }])).toBe("ab");
	});

	it("applies a realistic flagged entity edit", () => {
		const ops: EditOp[] = [
			{ at: 7, remove: "cabeca", insert: "cabeça", kind: "entity", flagged: true },
		];
		expect(applyEdits("dor de cabeca forte", ops)).toBe("dor de cabeça forte");
	});

	it("applies right-to-left even when a length-changing op precedes a later one", () => {
		// Ops listed in ASCENDING `at` order: applying the first op
		// (which shortens the string) before the second would shift
		// its offset — only right-to-left application is correct.
		const ops: EditOp[] = [
			{ at: 0, remove: "ab", insert: "X", kind: "fix" },
			{ at: 4, remove: "ef", insert: "Y", kind: "fix" },
		];
		expect(applyEdits("abcdef", ops)).toBe("XcdY");
	});

	it("sorts descending regardless of input order", () => {
		// Same ops in DESCENDING `at` order with a length-changing
		// later op — a `b.at + a.at` comparator would order these
		// ascending and corrupt the second op's offset.
		const ops: EditOp[] = [
			{ at: 4, remove: "ef", insert: "LONG", kind: "fix" },
			{ at: 0, remove: "ab", insert: "X", kind: "fix" },
		];
		expect(applyEdits("abcdef", ops)).toBe("XcdLONG");
	});

	it("does not mutate the caller's ops array", () => {
		const ops: EditOp[] = [
			{ at: 0, remove: "a", insert: "b", kind: "fix" },
			{ at: 2, remove: "c", insert: "d", kind: "fix" },
		];
		const snapshot = [...ops];
		applyEdits("abc", ops);
		expect(ops).toEqual(snapshot);
	});
});

describe("integrity guard", () => {
	it("throws EditApplyError when remove does not match the base", () => {
		try {
			applyEdits("o que você está sentindo dor de cabeca", [
				{ at: 29, remove: "cabeca", insert: "cabeça", kind: "fix" },
			]);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(EditApplyError);
			expect(e).toMatchObject({
				_tag: "EditApplyError",
				at: 29,
				expected: "cabeca",
				actual: expect.any(String),
			});
		}
	});

	it("pure insertions (empty remove) always match", () => {
		expect(applyEdits("ab", [{ at: 1, remove: "", insert: "X", kind: "fix" }])).toBe("aXb");
	});
});
