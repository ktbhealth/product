import { describe, expect, it } from "vitest";

import { alignWords, wordDiff } from "./diff.ts";

describe("alignWords", () => {
	it("identical sequences are all ok", () => {
		const ops = alignWords(["a", "b", "c"], ["a", "b", "c"]);
		expect(ops).toEqual([
			{ op: "ok", ref: "a", hyp: "a" },
			{ op: "ok", ref: "b", hyp: "b" },
			{ op: "ok", ref: "c", hyp: "c" },
		]);
	});

	it("substitution keeps position and both tokens", () => {
		const ops = alignWords(["dor", "de", "cabeca"], ["dor", "de", "barriga"]);
		expect(ops[2]).toEqual({ op: "sub", ref: "cabeca", hyp: "barriga" });
	});

	it("deletion carries the ref token, insertion the hyp token", () => {
		expect(alignWords(["a", "b"], ["a"])).toEqual([
			{ op: "ok", ref: "a", hyp: "a" },
			{ op: "del", ref: "b", hyp: "" },
		]);
		expect(alignWords(["a"], ["a", "b"])).toEqual([
			{ op: "ok", ref: "a", hyp: "a" },
			{ op: "ins", ref: "", hyp: "b" },
		]);
	});

	it("empty sides degrade to pure ins/del", () => {
		expect(alignWords([], ["x"])).toEqual([{ op: "ins", ref: "", hyp: "x" }]);
		expect(alignWords(["x"], [])).toEqual([{ op: "del", ref: "x", hyp: "" }]);
		expect(alignWords([], [])).toEqual([]);
	});

	it("fold folds case/accents/punct for equality but keeps raw display", () => {
		const ops = alignWords(["Cefaléia,"], ["cefaleia"]);
		expect(ops).toEqual([{ op: "ok", ref: "Cefaléia,", hyp: "cefaleia" }]);
	});

	it("prefers sub over del+ins on a one-token swap mid-sequence", () => {
		const ops = alignWords(["tomo", "losartana", "50"], ["tomo", "enalapril", "50"]);
		expect(ops[1]).toEqual({ op: "sub", ref: "losartana", hyp: "enalapril" });
	});
});

describe("wordDiff", () => {
	it("counts ops and reports the canonical wer", () => {
		const d = wordDiff("o paciente toma losartana", "o paciente toma enalapril");
		expect(d.summary).toEqual({
			refWords: 4,
			hypWords: 4,
			ok: 3,
			sub: 1,
			del: 0,
			ins: 0,
			wer: 0.25,
		});
	});

	it("both empty → zero counts and wer 0", () => {
		const d = wordDiff("", "");
		expect(d.summary.wer).toBe(0);
		expect(d.ops).toEqual([]);
	});

	it("realistic clinical slip: dose number and drug name differ", () => {
		const d = wordDiff(
			"prescrevo dipirona 500 mg duas vezes ao dia",
			"prescrevo dipirona 250 mg duas vezes ao dia",
		);
		const sub = d.ops.find((o) => o.op === "sub");
		expect(sub).toMatchObject({ ref: "500" });
		expect(d.summary.wer).toBeGreaterThan(0);
	});
});
