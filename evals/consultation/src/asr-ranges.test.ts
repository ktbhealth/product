import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import type { EvalAnswer, EvalQuestion } from "@ktb/eval-core";

import { detectAsrErrorRanges, mergeFlaggedRanges } from "./asr-ranges.ts";
import { EvalPort, PortError } from "./ports.ts";

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
