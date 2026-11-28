import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

/**
 * types.ts — the declarative half of `@ktb/statemachine`.
 *
 * The kit absorbs the hand-rolled status lifecycles scattered across
 * plugins (consultation audio jobs, eval instance/item generation,
 * eval runs): a state column on a DB row driven by conditional
 * UPDATEs, claim stamps, stale-reclaim sweeps and retry sets kept in
 * sync by hand. A {@link StateMachineSpec} declares the topology once;
 * the machine object answers legality questions (`can`, `events`,
 * `predecessors`, `isTerminal`) and `step` evaluates guarded
 * transitions as Effects; `commit` (machine.ts) pairs `step` with a
 * load/conditional-save store for the optimistic-concurrency claim
 * pattern those lifecycles all share.
 */

/** What a transition guard sees. `context` is whatever the caller
 * passed to `step`/`commit` — per-domain payloads (claim timestamps,
 * tenant flags) the machine itself knows nothing about. */
export interface GuardInput<State extends string, Event extends string, Ctx> {
	readonly state: State;
	readonly event: Event;
	readonly context: Ctx;
}

/** A transition guard — synchronous predicate or an Effect. Return
 * `false` to reject the transition; fail the effect to reject with a
 * cause. Truthy non-boolean values count as allowed.
 *
 * Guards carry NO requirements (`R = never`): ambient services are
 * probed inside the guard via `Effect.serviceOption`, the same
 * contract orchestration kinds follow — the machine cannot provide
 * services, so requiring them would only defer a defect to run time. */
export type TransitionGuard<State extends string, Event extends string, Ctx> = (
	input: GuardInput<State, Event, Ctx>,
) => boolean | Effect.Effect<boolean, unknown, never>;

/** A guarded transition target — `to` plus an optional `guard`. */
export interface TransitionTarget<State extends string, Event extends string, Ctx> {
	readonly to: State;
	readonly guard?: TransitionGuard<State, Event, Ctx>;
	/** Free-form note surfaced in tooling/tests — never enforced. */
	readonly description?: string;
}

/** `on` entries accept a bare target state or a guarded target. */
export type Transition<State extends string, Event extends string, Ctx> =
	| State
	| TransitionTarget<State, Event, Ctx>;

/** One state's outgoing transitions, keyed by event name. Events not
 * listed are illegal in this state. */
export interface StateNode<State extends string, Event extends string, Ctx> {
	readonly on?: {
		readonly [K in Event]?: Transition<State, Event, Ctx>;
	};
}

/** The declarative spec: `id` names the machine in errors, `initial`
 * is the state a fresh entity starts in, `states` must cover every
 * state (the mapped type enforces it), `terminal` lists states with
 * no meaningful outgoing work — informational for `isTerminal`
 * callers (UI badges, retry-set derivation); the machine does NOT
 * forbid transitions out of them, declare `on` honestly instead. */
export interface StateMachineSpec<State extends string, Event extends string, Ctx = unknown> {
	readonly id: string;
	readonly initial: State;
	readonly states: {
		readonly [K in State]: StateNode<State, Event, Ctx>;
	};
	readonly terminal?: readonly State[];
}

/** The outcome of a successful `step`: where the entity came from,
 * the event that moved it, and where it landed. `reentered` is true
 * for self-transitions (`to === from` — e.g. a re-record resetting a
 * consultation to "stored"). */
export interface TransitionResult<State extends string, Event extends string> {
	readonly from: State;
	readonly event: Event;
	readonly to: State;
	readonly reentered: boolean;
}

/** One legal edge — `machine.edges(event)` returns these so callers
 * can derive conditional-WRITE source sets (`WHERE status IN
 * (sources)`) straight from the declaration. */
export interface MachineEdge<State extends string> {
	readonly from: State;
	readonly to: State;
}

/** `step`/`commit` fired an event the current state does not declare
 * — or the current value is not a state the machine knows at all
 * (e.g. a legacy/foreign status string decoded from a DB row). */
export class InvalidTransitionError extends Data.TaggedError("InvalidTransitionError")<{
	readonly machineId: string;
	readonly from: string;
	readonly event: string;
}> {}

/** A declared transition's guard rejected the move — `cause` is set
 * when the guard Effect itself failed (foreign error normalized,
 * same idiom as the orchestrator runner); absent when the guard
 * returned false. */
export class TransitionRejectedError extends Data.TaggedError("TransitionRejectedError")<{
	readonly machineId: string;
	readonly from: string;
	readonly event: string;
	readonly cause?: unknown;
}> {}

/** `commit` found no persisted entity and no `initial` fallback was
 * supplied. */
export class StateNotFoundError extends Data.TaggedError("StateNotFoundError")<{
	readonly machineId: string;
}> {}

/** `commit`'s store `load`/`save` failed — the underlying driver
 * error rides on `cause` (normalized like kind errors in the
 * orchestrator runner). */
export class StateStoreError extends Data.TaggedError("StateStoreError")<{
	readonly machineId: string;
	readonly op: "load" | "save";
	readonly cause: unknown;
}> {}

/** `commit`'s conditional `save` reported the write did not land —
 * a concurrent transition moved the row between `load` and `save`
 * (the optimistic-concurrency claim lost the race). Callers retry or
 * treat as a no-op; the eval-persona item claim relies on exactly
 * this signal. */
export class TransitionConflictError extends Data.TaggedError("TransitionConflictError")<{
	readonly machineId: string;
	readonly from: string;
	readonly to: string;
	readonly event: string;
}> {}

/** Every typed error the kit raises. Store/guard foreign errors are
 * normalized into {@link StateStoreError}/{@link
 * TransitionRejectedError} — this union IS the error channel. */
export type StateMachineError =
	| InvalidTransitionError
	| TransitionRejectedError
	| StateNotFoundError
	| StateStoreError
	| TransitionConflictError;

/** The persistence half of `commit`: `load` reads the entity's
 * current state (`Option.none` = no row); `save` performs the
 * CONDITIONAL write — it must only land when the row is still in
 * `from` (e.g. `UPDATE … WHERE id = ? AND status = ?`) and report
 * whether it did. Returning `false` is the lost-race signal, not an
 * error. */
export interface StateStore<State extends string> {
	readonly load: () => Effect.Effect<Option.Option<State>, unknown, never>;
	/** `from` is the state `load` observed — `null` when the entity
	 * did not exist and `commit`'s `initial` fallback supplied the
	 * step source (the save should INSERT-or-guard accordingly).
	 * Must only land when the row is still in `from` (or still
	 * absent, for `from: null`) — e.g. `UPDATE … WHERE id = ? AND
	 * status = ?` — and report whether it did. Returning `false` is
	 * the lost-race signal, not an error. Requirements are `never`
	 * for the same reason guards carry none — capture dependencies
	 * in the closure or probe services inside. */
	readonly save: (transition: {
		readonly from: State | null;
		readonly to: State;
	}) => Effect.Effect<boolean, unknown, never>;
}
