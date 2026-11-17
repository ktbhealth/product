import { describe, expect, it } from "vitest";

import { chance, int, makeRng, pick } from "./rng.ts";

describe("makeRng", () => {
	it("is deterministic for the same seed", () => {
		const a = makeRng("patient-seed");
		const b = makeRng("patient-seed");
		for (let i = 0; i < 100; i++) expect(a()).toBe(b());
	});

	it("produces different streams for different seeds", () => {
		const a = makeRng("a");
		const b = makeRng("b");
		const sa = Array.from({ length: 20 }, () => a());
		const sb = Array.from({ length: 20 }, () => b());
		expect(sa).not.toEqual(sb);
	});

	it("accepts numeric seeds", () => {
		const a = makeRng(42);
		const b = makeRng(42);
		expect(a()).toBe(b());
	});

	it("stays within [0, 1)", () => {
		const rng = makeRng("range");
		for (let i = 0; i < 1000; i++) {
			const v = rng();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe("int / pick / chance", () => {
	it("int stays in the inclusive range", () => {
		const rng = makeRng("int");
		for (let i = 0; i < 500; i++) {
			const v = int(rng, 3, 7);
			expect(v).toBeGreaterThanOrEqual(3);
			expect(v).toBeLessThanOrEqual(7);
			expect(Number.isInteger(v)).toBe(true);
		}
	});

	it("int handles a single-value range", () => {
		const rng = makeRng("single");
		for (let i = 0; i < 10; i++) expect(int(rng, 5, 5)).toBe(5);
	});

	it("pick returns members", () => {
		const rng = makeRng("pick");
		for (let i = 0; i < 50; i++) expect(["x", "y", "z"]).toContain(pick(rng, ["x", "y", "z"]));
	});

	it("chance respects probability 0 and 1", () => {
		const rng = makeRng("chance");
		for (let i = 0; i < 20; i++) {
			expect(chance(rng, 0)).toBe(false);
			expect(chance(rng, 1)).toBe(true);
		}
	});
});
