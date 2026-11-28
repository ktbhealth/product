import { defineStateMachine } from "@ktb/statemachine";

/**
 * status-machine.ts — the `eval_run.status` lifecycle as a
 * `@ktb/statemachine` declaration.
 *
 *   queued ──start──▶ running ──finish──▶ done
 *     │  ▲               │
 *     │  └──fail──▶ failed◀─┘──fail──▶ failed
 *     └──────────start──▶ running   (retry: a failed run re-executes;
 *                                    pending samples resume)
 *
 * - `start`  — executeEvalRun's queued|failed → running flip. `failed`
 *   is a legal source: redelivery/retry resumes the run (pending
 *   samples only — crashed attempts pick up the tail).
 * - `finish` — the finalize UPDATE lands `done` (or `failed` via the
 *   `fail` edge when the runner itself failed).
 * - `fail`   — wholesale runner failure, missing-runner
 *   (`failRun`), or enqueue failure on a fresh `queued` row. The
 *   `failRun`/`enqueue` writes were already conditional on
 *   queued|running — the machine derives that set.
 * - `done`   — terminal for `start`/`fail`, but `finish` self-loops:
 *   a redelivered job re-runs finalize, which recomputes `done`/
 *   `summary` from the sample rows — an idempotent identical-value
 *   rewrite the pre-machine unconditional UPDATE performed. Without
 *   the edge the guard would freeze a stale summary on redelivery.
 */
export const evalRunMachine = defineStateMachine({
	id: "eval.run",
	initial: "queued",
	states: {
		queued: { on: { start: "running", fail: "failed" } },
		running: { on: { finish: "done", fail: "failed" } },
		failed: { on: { start: "running" } },
		done: { on: { finish: "done" } },
	},
	terminal: ["done"],
});

export type EvalRunStatus = (typeof evalRunMachine.states)[number];
export type EvalRunEvent = "start" | "finish" | "fail";

/** Statuses the `start` (→running) flip may leave — the executeEvalRun
 * guard `queued || failed` expressed as machine data. */
export const EVAL_RUN_START_SOURCES = evalRunMachine.predecessors("start");
/** Statuses a `fail` (→failed) write may leave — `failRun`'s
 * `inArray(status, …)` set, derived. */
export const EVAL_RUN_FAIL_SOURCES = evalRunMachine.predecessors("fail");
/** Statuses the finalize UPDATE may leave — union of `finish` and
 * `fail` sources (`running` plus `queued` for the never-started
 * wholesale-failure path). */
export const EVAL_RUN_FINALIZE_SOURCES = [
	...new Set([...evalRunMachine.predecessors("finish"), ...evalRunMachine.predecessors("fail")]),
];
