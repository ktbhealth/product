import { describe, expect, it } from "vitest";

import type { WizardDefinition } from "./definition.ts";
import {
	nextVisibleIndex,
	previousVisibleIndex,
	resolveCurrentStep,
	stepVisible,
} from "./resolve.ts";

const def: WizardDefinition = {
	id: "w",
	steps: [
		{ kind: "info", id: "s0" },
		{ kind: "form", id: "s1", schema: { type: "object" } },
		{
			kind: "info",
			id: "s2",
			when: { path: "s1.go", op: "eq", value: true },
		},
		{ kind: "info", id: "s3" },
	],
};

describe("stepVisible", () => {
	it("is true without when and evaluates conditions otherwise", () => {
		expect(stepVisible(def.steps[0]!, {})).toBe(true);
		expect(stepVisible(def.steps[2]!, { s1: { go: true } })).toBe(true);
		expect(stepVisible(def.steps[2]!, { s1: { go: false } })).toBe(false);
		expect(stepVisible(def.steps[2]!, {})).toBe(false);
	});
});

describe("resolveCurrentStep", () => {
	it("returns the step at the stored index", () => {
		const res = resolveCurrentStep(def, { stepIndex: 1, answers: {} });
		expect(res).toMatchObject({ kind: "step", index: 1, step: { id: "s1" } });
	});

	it("skips hidden steps", () => {
		const res = resolveCurrentStep(def, { stepIndex: 2, answers: { s1: { go: false } } });
		expect(res).toMatchObject({ kind: "step", index: 3 });
	});

	it("returns done past the last visible step", () => {
		expect(resolveCurrentStep(def, { stepIndex: 4, answers: {} })).toEqual({ kind: "done" });
		expect(resolveCurrentStep(def, { stepIndex: 99, answers: {} })).toEqual({ kind: "done" });
		// s2 hidden and s3 is last visible → index 3 then done.
		expect(resolveCurrentStep(def, { stepIndex: 3, answers: { s1: { go: false } } })).toMatchObject(
			{ kind: "step", index: 3 },
		);
	});

	it("clamps stale indexes forward", () => {
		const res = resolveCurrentStep(def, { stepIndex: 2, answers: { s1: { go: true } } });
		expect(res).toMatchObject({ kind: "step", index: 2 });
	});

	it("rejects corrupt positions", () => {
		expect(resolveCurrentStep(def, { stepIndex: -1, answers: {} })).toEqual({
			kind: "invalid",
			reason: expect.stringContaining("-1"),
		});
		expect(resolveCurrentStep(def, { stepIndex: 1.5, answers: {} }).kind).toBe("invalid");
	});
});

describe("nextVisibleIndex / previousVisibleIndex", () => {
	it("finds the next visible step after an index", () => {
		expect(nextVisibleIndex(def, 0, {})).toBe(1);
		expect(nextVisibleIndex(def, 1, { s1: { go: false } })).toBe(3);
		expect(nextVisibleIndex(def, 3, {})).toBeNull();
		expect(nextVisibleIndex(def, 99, {})).toBeNull();
	});

	it("finds the previous visible step before an index", () => {
		// s2 is hidden without s1.go === true
		expect(previousVisibleIndex(def, 3, {})).toBe(1);
		expect(previousVisibleIndex(def, 3, { s1: { go: true } })).toBe(2);
		expect(previousVisibleIndex(def, 3, { s1: { go: false } })).toBe(1);
		expect(previousVisibleIndex(def, 1, {})).toBe(0);
		expect(previousVisibleIndex(def, 0, {})).toBeNull();
		expect(previousVisibleIndex(def, 99, {})).toBe(3);
		expect(previousVisibleIndex(def, 2, { s1: { go: false } })).toBe(1);
	});
});
