import { describe, expect, it } from "vitest";

import { anchorEdits, applyEdits, EditApplyError, isRewrite, type EditOp } from "./diff.ts";

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

describe("anchorEdits", () => {
	const op = (at: number, remove: string, insert: string): EditOp => ({
		at,
		remove,
		insert,
		kind: "fix",
	});

	it("keeps ops whose remove already matches at `at`", () => {
		const out = anchorEdits("dor de cabeca", [op(7, "cabeca", "cabeça")]);
		expect(out.ops).toEqual([op(7, "cabeca", "cabeça")]);
		expect(out.stats).toEqual({ exact: 1, reanchored: 0, rewrites: 0, dropped: 0 });
	});

	it("moves a mis-offset op to the nearest occurrence of its remove text", () => {
		const base = "dipirona 500 mg e dipirona 500 mg";
		const out = anchorEdits(base, [op(20, "dipirona", "Dipirona")]);
		expect(out.ops).toEqual([op(18, "dipirona", "Dipirona")]);
		expect(out.stats).toEqual({ exact: 0, reanchored: 1, rewrites: 0, dropped: 0 });
		// Nearest wins over first: a hint near the start picks index 0.
		expect(anchorEdits(base, [op(3, "dipirona", "x")]).ops[0]?.at).toBe(0);
		// Ties keep the earlier occurrence.
		expect(anchorEdits("ab ab", [op(1.5, "ab", "x")]).ops[0]?.at).toBe(0);
	});

	it("preserves extra fields such as flagged and kind", () => {
		const flagged: EditOp = { at: 99, remove: "abc", insert: "x", kind: "entity", flagged: true };
		expect(anchorEdits("abc", [flagged]).ops).toEqual([{ ...flagged, at: 0 }]);
	});

	it("drops ops that are unverifiable or no-ops", () => {
		const out = anchorEdits("abc", [op(0, "zzz", "y"), op(1, "", "y"), op(0, "a", "a")]);
		expect(out.ops).toEqual([]);
		expect(out.stats).toEqual({ exact: 0, reanchored: 0, rewrites: 0, dropped: 3 });
	});

	it("drops ops overlapping an earlier kept op and sorts by offset", () => {
		const out = anchorEdits("abcdef", [op(4, "ef", "Y"), op(0, "abc", "X"), op(2, "cd", "Z")]);
		expect(out.ops).toEqual([op(0, "abc", "X"), op(4, "ef", "Y")]);
		expect(out.stats).toEqual({ exact: 3, reanchored: 0, rewrites: 0, dropped: 1 });
		expect(applyEdits("abcdef", out.ops)).toBe("XdY");
	});

	it("allows adjacent (touching) ops", () => {
		const out = anchorEdits("abcd", [op(0, "ab", "X"), op(2, "cd", "Y")]);
		expect(out.ops).toHaveLength(2);
		expect(applyEdits("abcd", out.ops)).toBe("XY");
	});
});

describe("isRewrite", () => {
	it("accepts word-level ASR corrections", () => {
		expect(isRewrite({ remove: "exajurai", insert: "exagerei" })).toBe(false);
		expect(isRewrite({ remove: "dorde", insert: "dor de" })).toBe(false);
		expect(isRewrite({ remove: "a vontade", insert: "à vontade" })).toBe(false);
		expect(isRewrite({ remove: "doutora", insert: "Dra." })).toBe(false);
	});

	it("ignores punctuation and casing", () => {
		expect(isRewrite({ remove: "tudo bem sente aqui", insert: "Tudo bem? Sente aqui." })).toBe(
			false,
		);
	});

	it("flags sentence-level paraphrases", () => {
		expect(
			isRewrite({
				remove: "Fume não, nunca fumei, graças a Deus.",
				insert: "Não fumo, nunca fumei.",
			}),
		).toBe(true);
		expect(
			isRewrite({
				remove: "Começou a fazer umas duas semanas, mais ou menos.",
				insert: "Começou a acontecer há cerca de duas semanas.",
			}),
		).toBe(true);
	});

	it("allows several changes inside a long span when most words survive", () => {
		// 3 changed words out of 10 — above the free allowance but
		// under half the span.
		expect(
			isRewrite({
				remove: "tomo dipirona duas capsula de quinhentos mg quando ta doendo",
				insert: "tomo dipirona duas cápsulas de 500 mg quando tá doendo",
			}),
		).toBe(false);
	});

	it("treats empty-word spans by their longer side", () => {
		expect(isRewrite({ remove: "...", insert: "um dois três" })).toBe(true);
		expect(isRewrite({ remove: "...", insert: "!" })).toBe(false);
	});
});

describe("anchorEdits rewrite guard", () => {
	const base = "Fume não, nunca fumei, graças a Deus. Eu exajurai no café.";
	const paraphrase: EditOp = {
		at: 0,
		remove: "Fume não, nunca fumei, graças a Deus.",
		insert: "Não fumo, nunca fumei.",
		kind: "punct",
	};
	const fix: EditOp = { at: 41, remove: "exajurai", insert: "exagerei", kind: "fix" };

	it("drops paraphrases by default and counts them separately", () => {
		const out = anchorEdits(base, [paraphrase, fix]);
		expect(out.ops).toEqual([fix]);
		expect(out.stats).toEqual({ exact: 1, reanchored: 0, rewrites: 1, dropped: 0 });
	});

	it("keeps them when the guard is disabled", () => {
		const out = anchorEdits(base, [paraphrase, fix], { rewriteGuard: false });
		expect(out.ops).toEqual([paraphrase, fix]);
		expect(out.stats.rewrites).toBe(0);
	});
});
