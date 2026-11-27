import { describe, expect, it } from "vitest";

import { alignWords, fold, sentenceDiff, splitSentences, tokens } from "./index.ts";

describe("fold", () => {
	it("lowercases, strips accents and drops non-word chars", () => {
		expect(fold("Médico,")).toBe("medico");
		expect(fold("CORAÇÃO!")).toBe("coracao");
	});
});

describe("tokens", () => {
	it("splits on whitespace and drops empties", () => {
		expect(tokens("  a  b\tc ")).toEqual(["a", "b", "c"]);
		expect(tokens("")).toEqual([]);
	});
});

describe("alignWords", () => {
	it("emits ok for equal folded tokens", () => {
		expect(alignWords(["dor", "de"], ["Dor", "dé"])).toEqual([
			{ op: "ok", ref: "dor", hyp: "Dor" },
			{ op: "ok", ref: "de", hyp: "dé" },
		]);
	});

	it("emits sub/del/ins ops in order", () => {
		const ops = alignWords(["a", "b", "c"], ["a", "x", "y", "c"]);
		// ok(a) sub(b→x) sub(c→y) ins(c) — tie-break prefers sub over
		// del+ins, so the extra hyp token lands as a trailing insertion.
		expect(ops.map((o) => o.op)).toEqual(["ok", "sub", "sub", "ins"]);
	});

	it("prefers sub over del+ins on ties", () => {
		const ops = alignWords(["a"], ["b"]);
		expect(ops).toEqual([{ op: "sub", ref: "a", hyp: "b" }]);
	});

	it("handles empty sides", () => {
		expect(alignWords([], ["x"])).toEqual([{ op: "ins", ref: "", hyp: "x" }]);
		expect(alignWords(["x"], [])).toEqual([{ op: "del", ref: "x", hyp: "" }]);
		expect(alignWords([], [])).toEqual([]);
	});
});

describe("splitSentences", () => {
	it("splits on end punctuation and newlines", () => {
		expect(splitSentences("Um. Dois! Três?\nQuatro")).toEqual(["Um.", "Dois!", "Três?", "Quatro"]);
	});
	it("keeps a single sentence whole", () => {
		expect(splitSentences("sem pontuação final")).toEqual(["sem pontuação final"]);
	});
});

describe("sentenceDiff", () => {
	it("pairs near-identical sentences and word-diffs inside them", () => {
		const pairs = sentenceDiff("Dor de garganta. Vou examinar.", "Dor na garganta. Vou examinar.");
		expect(pairs).toHaveLength(2);
		expect(pairs[0]!.ops.some((o) => o.op === "sub")).toBe(true);
		expect(pairs[1]!.ops.every((o) => o.op === "ok")).toBe(true);
	});

	it("marks sentences with no pair as deletions", () => {
		const pairs = sentenceDiff("Frase que sumiu completamente.", "Outro conteúdo.");
		const del = pairs.find((p) => p.hyp === "");
		expect(del?.ref).toBe("Frase que sumiu completamente.");
		expect(del?.ops.every((o) => o.op === "del")).toBe(true);
	});

	it("marks extra corrected sentences as insertions", () => {
		const pairs = sentenceDiff("Frase original.", "Frase original. Nota acrescentada agora.");
		const ins = pairs.find((p) => p.ref === "");
		expect(ins?.hyp).toBe("Nota acrescentada agora.");
		expect(ins?.ops.every((o) => o.op === "ins")).toBe(true);
	});

	it("treats tokenless sentences as unpaired instead of dividing by zero", () => {
		// "!!!" / "???" fold to empty token sets — overlap must return 0,
		// so both sides render as del + ins rather than pairing.
		const pairs = sentenceDiff("!!!", "???");
		expect(pairs.some((p) => p.ref === "!!!" && p.hyp === "")).toBe(true);
		expect(pairs.some((p) => p.ref === "" && p.hyp === "???")).toBe(true);
	});

	it("handles empty inputs", () => {
		expect(sentenceDiff("", "")).toEqual([]);
		expect(sentenceDiff("", "texto")).toEqual([expect.objectContaining({ ref: "", hyp: "texto" })]);
	});
});
