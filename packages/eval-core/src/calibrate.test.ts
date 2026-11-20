import { describe, expect, it } from "vitest";

import { calibrate, wilsonLowerBound } from "./calibrate.ts";

const segs = (correct: number, wrong: number, conf = 0.9) => [
	...Array.from({ length: correct }, () => ({ correct: true, confidence: conf })),
	...Array.from({ length: wrong }, () => ({ correct: false, confidence: conf })),
];

describe("wilsonLowerBound", () => {
	it("is 0 for empty input", () => {
		expect(wilsonLowerBound(0, 0)).toBe(0);
	});

	it("floor is below the point estimate — small n pays the price", () => {
		// 19/20 = 95% observed but the floor is ~75% — can't claim 95%.
		expect(wilsonLowerBound(19, 20)).toBeLessThan(0.95);
		// Same ratio at n=2000 has a much tighter floor.
		expect(wilsonLowerBound(1900, 2000)).toBeGreaterThan(0.93);
	});

	it("is monotonic in successes", () => {
		expect(wilsonLowerBound(10, 100)).toBeLessThan(wilsonLowerBound(50, 100));
	});

	it("matches the Wilson formula exactly", () => {
		// 19/20 at z=1.96: p=0.95, z²=3.8416 — a `z/z` (=1) mutant
		// would report ~0.876 instead of ~0.764.
		expect(wilsonLowerBound(19, 20)).toBeCloseTo(0.7639, 3);
		expect(wilsonLowerBound(1900, 2000)).toBeCloseTo(0.9396, 3);
		// A custom z must actually be used (z=0 collapses the bound to p).
		expect(wilsonLowerBound(19, 20, 0)).toBeCloseTo(0.95, 5);
	});
});

describe("calibrate", () => {
	it("passes only when floor ≥ target AND n ≥ minN", () => {
		expect(calibrate(segs(190, 10), { target: 0.9, minN: 100 }).passes).toBe(true);
		// Same observed precision, too few samples → fail.
		expect(calibrate(segs(19, 1), { target: 0.9, minN: 100 }).passes).toBe(false);
		// Enough n, floor under target → fail.
		expect(calibrate(segs(80, 20), { target: 0.9, minN: 50 }).passes).toBe(false);
	});

	it("reports precision/lowerBound honestly on empty input", () => {
		const v = calibrate([], { target: 0.9, minN: 1 });
		expect(v.precision).toBe(0);
		expect(v.lowerBound).toBe(0);
		expect(v.passes).toBe(false);
	});

	it("reports the point precision and sample counts", () => {
		const v = calibrate(segs(7, 3), { target: 0.5, minN: 5 });
		expect(v.n).toBe(10);
		expect(v.successes).toBe(7);
		expect(v.precision).toBeCloseTo(0.7, 5);
	});

	it("passes at the exact boundaries — n === minN and lowerBound === target", () => {
		// `>` mutants on either comparison must fail here.
		const segs10 = segs(10, 0);
		const lb = calibrate(segs10, { target: 0, minN: 10 }).lowerBound;
		expect(lb).toBeGreaterThan(0);
		const v = calibrate(segs10, { target: lb, minN: 10 });
		expect(v.passes).toBe(true);
	});

	it("fails when n < minN even if the floor clears the target", () => {
		// The sample-size gate is independent of the precision gate.
		const segs10 = segs(10, 0);
		const lb = calibrate(segs10, { target: 0, minN: 10 }).lowerBound;
		expect(calibrate(segs10, { target: lb, minN: 11 }).passes).toBe(false);
	});
});
