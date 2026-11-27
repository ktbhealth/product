import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { EvalAnswer, EvalQuestion } from "@ktb/eval-core";

import {
	charRangesFor,
	detectAsrErrorRanges,
	mergeFlaggedRanges,
	segmentCharSpans,
} from "./asr-ranges.ts";
import { EvalPort, PortError } from "@ktb/eval-core";

const record = {
	runId: "r",
	taskId: "t",
	stage: "judge",
	engine: "stub",
	inputHash: "h",
	startedAt: 0,
};

type Call = { state: unknown; questions: readonly EvalQuestion[] };

/** Fake judge: p(yes) per segment index, answered in noul form
 * (probability backs the chosen verdict, like makeSystemOneEval). */
const judgeLayer = (pBySegment: readonly number[], calls: Call[], skip: readonly string[] = []) =>
	Layer.succeed(
		EvalPort,
		EvalPort.of({
			judge: (input) => {
				calls.push(input);
				const answers: EvalAnswer[] = input.questions
					.filter((q) => !skip.includes(q.id))
					.map((q) => {
						const p = pBySegment[Number(q.id.slice(1))]!;
						const yes = p >= 0.5;
						return { id: q.id, kind: "noul", value: yes, probability: yes ? p : 1 - p };
					});
				return Effect.succeed({ answers, record });
			},
		}),
	);

const segs = (n: number) => Array.from({ length: n }, (_, i) => ({ text: ` seg ${i} ` }));

describe("mergeFlaggedRanges", () => {
	it("merges adjacent flagged segments and splits on gaps", () => {
		expect(mergeFlaggedRanges([0.6, 0.7, 0.2, 0.5, 0.1, 0.9], 0.5)).toEqual([
			{ start: 0, end: 1 },
			{ start: 3, end: 3 },
			{ start: 5, end: 5 },
		]);
	});

	it("returns no ranges when nothing reaches the threshold", () => {
		expect(mergeFlaggedRanges([0.1, 0.4], 0.5)).toEqual([]);
		expect(mergeFlaggedRanges([], 0.5)).toEqual([]);
	});
});

describe("segmentCharSpans", () => {
	it("locates each segment's char span in the joined transcript", () => {
		const text = "dor de cabeça e febre há dias";
		const spans = segmentCharSpans(text, [{ text: "dor de cabeça" }, { text: "e febre há dias" }]);
		expect(spans).toEqual([
			{ start: 0, end: 13 },
			{ start: 14, end: 29 },
		]);
		expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("dor de cabeça");
	});

	it("walks forward so repeated text lands on its own occurrence", () => {
		const text = "não sei, não";
		expect(segmentCharSpans(text, [{ text: "não" }, { text: "sei," }, { text: "não" }])).toEqual([
			{ start: 0, end: 3 },
			{ start: 4, end: 8 },
			{ start: 9, end: 12 },
		]);
	});

	it("marks a segment absent from the text null and keeps going", () => {
		const spans = segmentCharSpans("alpha gamma", [
			{ text: "alpha" },
			{ text: "beta" },
			{ text: "gamma" },
		]);
		expect(spans).toEqual([{ start: 0, end: 5 }, null, { start: 6, end: 11 }]);
	});

	it("handles empty inputs", () => {
		expect(segmentCharSpans("", [])).toEqual([]);
	});
});

describe("charRangesFor", () => {
	it("resolves a range to [first located start, last located end]", () => {
		const spans = [{ start: 0, end: 5 }, null, { start: 10, end: 15 }];
		expect(charRangesFor([{ start: 0, end: 2 }], spans)).toEqual([{ start: 0, end: 15 }]);
	});

	it("drops ranges whose segments are all unlocatable", () => {
		const spans: (ReturnType<typeof segmentCharSpans>[number] | null)[] = [
			null,
			{ start: 5, end: 9 },
		];
		expect(
			charRangesFor(
				[
					{ start: 0, end: 0 },
					{ start: 1, end: 1 },
				],
				spans,
			),
		).toEqual([{ start: 5, end: 9 }]);
	});

	it("ignores out-of-bounds indices and merges overlapping spans", () => {
		const spans = [
			{ start: 0, end: 6 },
			{ start: 4, end: 10 },
			{ start: 20, end: 25 },
		];
		expect(
			charRangesFor(
				[
					{ start: -3, end: 1 },
					{ start: 2, end: 9 },
				],
				spans,
			),
		).toEqual([
			{ start: 0, end: 10 },
			{ start: 20, end: 25 },
		]);
	});

	it("merges resolved char spans that overlap", () => {
		// Ranges overlapping on segment indices resolve to overlapping
		// char spans — the output must stay a disjoint cover for
		// applyEdits.
		const spans = [
			{ start: 0, end: 5 },
			{ start: 4, end: 8 },
			{ start: 9, end: 12 },
		];
		expect(
			charRangesFor(
				[
					{ start: 0, end: 1 },
					{ start: 1, end: 2 },
				],
				spans,
			),
		).toEqual([{ start: 0, end: 12 }]);
	});
});

describe("detectAsrErrorRanges", () => {
	it("batches questions over a shared state and recovers p(yes)", async () => {
		const calls: Call[] = [];
		const p = [0.2, 0.55, 0.6, 0.3, 0.8];
		const r = await Effect.runPromise(
			detectAsrErrorRanges(segs(5), { batchSize: 2 }).pipe(Effect.provide(judgeLayer(p, calls))),
		);
		expect(calls.map((c) => c.questions.map((q) => q.id))).toEqual([
			["s0", "s1"],
			["s2", "s3"],
			["s4"],
		]);
		expect(calls.every((c) => c.state === calls[0]!.state)).toBe(true);
		expect(calls[0]!.state).toMatchObject({
			transcript_segments: ["[0] seg 0", "[1] seg 1", "[2] seg 2", "[3] seg 3", "[4] seg 4"],
		});
		expect(calls[0]!.questions[1]).toMatchObject({ kind: "noul" });
		expect(calls[0]!.questions[1]!.text).toContain("O segmento [1]");
		r.scores.forEach((s, i) => expect(s).toBeCloseTo(p[i]!));
		expect(r.ranges).toEqual([
			{ start: 1, end: 2 },
			{ start: 4, end: 4 },
		]);
		expect(r.records).toHaveLength(3);
	});

	it("honours threshold and lang, defaulting to batches of 6", async () => {
		const calls: Call[] = [];
		const p = [0.2, 0.35, 0.4, 0.1, 0.1, 0.1, 0.45];
		const r = await Effect.runPromise(
			detectAsrErrorRanges(segs(7), { threshold: 0.35, lang: "en" }).pipe(
				Effect.provide(judgeLayer(p, calls)),
			),
		);
		expect(calls.map((c) => c.questions.length)).toEqual([6, 1]);
		expect(calls[0]!.questions[0]!.text).toContain("Does segment [0]");
		expect(r.ranges).toEqual([
			{ start: 1, end: 2 },
			{ start: 6, end: 6 },
		]);
	});

	it("scores an unanswered segment as no error", async () => {
		const r = await Effect.runPromise(
			detectAsrErrorRanges(segs(2)).pipe(Effect.provide(judgeLayer([0.9, 0.9], [], ["s1"]))),
		);
		expect(r.scores).toEqual([0.9, 0]);
		expect(r.ranges).toEqual([{ start: 0, end: 0 }]);
	});

	it("propagates judge failures", async () => {
		const failing = Layer.succeed(
			EvalPort,
			EvalPort.of({ judge: () => Effect.fail(new PortError({ port: "eval", message: "down" })) }),
		);
		const exit = await Effect.runPromiseExit(
			detectAsrErrorRanges(segs(1)).pipe(Effect.provide(failing)),
		);
		expect(exit._tag).toBe("Failure");
	});

	it("makes no request for an empty transcript", async () => {
		const calls: Call[] = [];
		const r = await Effect.runPromise(
			detectAsrErrorRanges([]).pipe(Effect.provide(judgeLayer([], calls))),
		);
		expect(calls).toEqual([]);
		expect(r).toEqual({ scores: [], ranges: [], records: [] });
	});
});
