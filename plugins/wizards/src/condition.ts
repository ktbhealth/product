/**
 * Wizard step conditions — the shared condition DSL now lives in
 * `@ktb/dsl` (./condition.ts there). This module is a compatibility
 * re-export so `@ktb/wizards/condition` and the package index keep
 * their historical surface: `WizardCondition` (the pre-extraction name
 * for `Condition`), `resolveAnswerPath` (the pre-extraction name for
 * `getPath`) and the rest unchanged.
 */
export { assertCondition, evaluateCondition, jsonEquals, MAX_CONDITION_DEPTH } from "@ktb/dsl";
export type { Condition, ConditionOp } from "@ktb/dsl";
export type { Condition as WizardCondition } from "@ktb/dsl";
export { getPath as resolveAnswerPath } from "@ktb/dsl";
