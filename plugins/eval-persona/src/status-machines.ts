import { defineStateMachine } from "@ktb/statemachine";

/**
 * status-machines.ts — the eval pipeline's two status lifecycles as
 * `@ktb/statemachine` declarations, replacing the status literals the
 * generation tick used to keep in sync by hand.
 *
 * `eval_instance.status` (instanceMachine):
 *
 *   draft ──start──▶ generating ──finish──▶ ready
 *                        │
 *                        └──fail──▶ failed        (terminal)
 *
 * - `start`  — EvalInstances.start flips draft→generating; the
 *   conditional write guards on the draft source so a double-start
 *   can't re-arm a finished instance.
 * - `finish` — the tick's finalize UPDATE lands `ready` (or `failed`
 *   when zero items completed — modelled as `fail`, see below).
 * - `fail`   — init-level failure (reclaim/items scan) or an
 *   all-items-failed finalize. `generating` only.
 *
 * `eval_instance_item.status` (itemMachine) — the per-item generation
 * status, distinct from the review `state` column:
 *
 *   pending ──claim──▶ generating ──complete──▶ done
 *                        │  ▲
 *                        │  └──reclaim──▶ pending   (stale claim sweep)
 *                        ├──fail──▶ error
 *
 * - `claim`    — the atomic pending→generating UPDATE
 *   (`status='pending'` guard + claimed_at stamp) that keeps
 *   concurrent polls/tabs from double-processing.
 * - `complete` — generateItem persisted the script (done).
 * - `fail`     — per-item failure isolation (error + message).
 * - `reclaim`  — the stale-claim sweep flips a `generating` item whose
 *   claimed_at is older than STALE_CLAIM_MS back to `pending` (a
 *   request killed mid-generation must not deadlock the run). The
 *   staleness predicate lives in the UPDATE's WHERE clause — the
 *   machine declares the edge, the SQL enforces the clock.
 */
export const evalInstanceMachine = defineStateMachine({
	id: "eval.instance",
	initial: "draft",
	states: {
		draft: { on: { start: "generating" } },
		generating: { on: { finish: "ready", fail: "failed" } },
		ready: {},
		failed: {},
	},
	terminal: ["ready", "failed"],
});

export const evalInstanceItemMachine = defineStateMachine({
	id: "eval.instance.item",
	initial: "pending",
	states: {
		pending: { on: { claim: "generating" } },
		generating: {
			on: { complete: "done", fail: "error", reclaim: "pending" },
		},
		done: {},
		error: {},
	},
	terminal: ["done", "error"],
});

export type EvalInstanceStatus = (typeof evalInstanceMachine.states)[number];
export type EvalInstanceItemStatus = (typeof evalInstanceItemMachine.states)[number];
export type EvalInstanceEvent = "start" | "finish" | "fail";
export type EvalInstanceItemEvent = "claim" | "complete" | "fail" | "reclaim";
