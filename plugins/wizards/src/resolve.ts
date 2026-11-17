import { evaluateCondition } from "@ktb/dsl";
import type { WizardDefinition, WizardStep } from "./definition.ts";

/**
 * Pure step interpreter for wizard runs — no Effect, no I/O, fully
 * unit-testable. Given a definition and the run's progress
 * (`stepIndex` + submitted `answers`), it resolves which step is
 * current: steps whose `when` condition fails against the answers are
 * skipped, so conditional branches need no explicit jump opcodes.
 *
 * `stepIndex` is a *position hint*, not a cursor into visible steps:
 * the interpreter always scans forward from it, so a stored index
 * pointing at a now-hidden step resolves to the next visible one (and
 * past-the-end resolves to "done"). `back` scans backward from the
 * current position for the previous *visible* step.
 */

/** Minimal run progress the interpreter needs. */
export interface WizardProgress {
	readonly stepIndex: number;
	readonly answers: Readonly<Record<string, unknown>>;
}

export type StepResolution =
	| {
			readonly kind: "step";
			/** Index into `definition.steps` (declaration order). */
			readonly index: number;
			readonly step: WizardStep;
	  }
	| { readonly kind: "done" }
	| { readonly kind: "invalid"; readonly reason: string };

/** Is `step` visible for this answer set? Steps without `when` are
 * always visible; malformed conditions fail closed (hidden). */
export const stepVisible = (step: WizardStep, answers: unknown): boolean =>
	step.when === undefined || evaluateCondition(step.when, answers);

const isStep = (value: unknown): value is WizardStep => typeof value === "object" && value !== null;

/**
 * Resolve the current step: scan forward from `progress.stepIndex`
 * (clamped into range) for the first visible step. Returns "done" when
 * no visible step remains — the run is complete and its completion
 * target should fire. "invalid" only when the stored index is corrupt
 * (negative/NaN — a defect, surfaced loudly rather than papered over).
 */
export const resolveCurrentStep = (
	definition: WizardDefinition,
	progress: WizardProgress,
): StepResolution => {
	const { stepIndex, answers } = progress;
	if (!Number.isInteger(stepIndex) || stepIndex < 0) {
		return { kind: "invalid", reason: `stepIndex ${stepIndex} is not a valid position` };
	}
	const steps = definition.steps;
	for (let index = Math.min(stepIndex, steps.length); index < steps.length; index += 1) {
		const step = steps[index];
		/* v8 ignore next -- steps are validated non-empty objects by
		 * assertWizardDefinition; the guard only narrows the tuple read */
		if (!isStep(step)) continue;
		if (stepVisible(step, answers)) return { kind: "step", index, step };
	}
	return { kind: "done" };
};

/** Index of the first visible step AFTER `fromIndex`, or null. Used by
 * `advance` to know whether submitting the current step finishes the
 * wizard (no next step → completion fires). */
export const nextVisibleIndex = (
	definition: WizardDefinition,
	fromIndex: number,
	answers: unknown,
): number | null => {
	for (let index = fromIndex + 1; index < definition.steps.length; index += 1) {
		const step = definition.steps[index];
		/* v8 ignore next -- see resolveCurrentStep */
		if (!isStep(step)) continue;
		if (stepVisible(step, answers)) return index;
	}
	return null;
};

/** Index of the previous visible step BEFORE `beforeIndex`, or null —
 * `back` never lands on a step the current answers would hide. */
export const previousVisibleIndex = (
	definition: WizardDefinition,
	beforeIndex: number,
	answers: unknown,
): number | null => {
	for (let index = Math.min(beforeIndex, definition.steps.length) - 1; index >= 0; index -= 1) {
		const step = definition.steps[index];
		/* v8 ignore next -- see resolveCurrentStep */
		if (!isStep(step)) continue;
		if (stepVisible(step, answers)) return index;
	}
	return null;
};
