import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
	InvalidTransitionError,
	StateNotFoundError,
	StateStoreError,
	TransitionConflictError,
	TransitionRejectedError,
	type MachineEdge,
	type StateMachineError,
	type StateMachineSpec,
	type StateStore,
	type Transition,
	type TransitionGuard,
	type TransitionResult,
} from "./types.ts";

/**
 * machine.ts — the runtime half of `@ktb/statemachine`.
 *
 * {@link defineStateMachine} validates the spec once at declaration
 * (every `to` must be a declared state — a typo'd target is a
 * packaging bug, surfaced at module load like `definePlugin`) and
 * returns a {@link StateMachine}: pure legality queries plus `step`,
 * which evaluates guards and produces a {@link TransitionResult} as
 * an Effect. Nothing here touches a database — persistence is the
 * caller's job, either through {@link commit}'s {@link StateStore}
 * contract or by translating `edges()`/`predecessors()` output into
 * conditional UPDATEs by hand.
 */

/** The compiled machine — see {@link StateMachineSpec} for the
 * declarative input. */
export interface StateMachine<State extends string, Event extends string, Ctx> {
	readonly id: string;
	readonly initial: State;
	/** Declared states, spec order. */
	readonly states: readonly State[];
	/** `true` when `value` is one of the declared states — use it to
	 * validate DB-decoded status strings before stepping. */
	readonly isState: (value: unknown) => value is State;
	/** `true` for states listed in `spec.terminal`. */
	readonly isTerminal: (state: State) => boolean;
	/** Event names `state` declares a transition for. */
	readonly events: (state: State) => readonly Event[];
	/** Structural legality only — guards are NOT evaluated (they may
	 * be Effects). Use `step` when the guard matters. */
	readonly can: (state: State, event: Event) => boolean;
	/** States declaring `event`; with `to`, only those whose target
	 * for `event` is `to`. This is how callers derive conditional-write
	 * source sets — e.g. the audio retry statuses are
	 * `predecessors("retry", "queued")`. */
	readonly predecessors: (event: Event, to?: State) => readonly State[];
	/** Every legal edge for `event` across all states — the full
	 * `{from, to}` list a conditional UPDATE needs when an event has
	 * a single target everywhere it appears. */
	readonly edges: (event: Event) => readonly MachineEdge<State>[];
	/** Evaluate the transition `state --event--> ?` under an optional
	 * guard `context`. Fails {@link InvalidTransitionError} when no
	 * transition is declared (or `state` is foreign), {@link
	 * TransitionRejectedError} when the guard refuses. Never writes
	 * anything — persistence is `commit`'s job. */
	readonly step: (
		state: State,
		event: Event,
		context?: Ctx,
	) => Effect.Effect<TransitionResult<State, Event>, StateMachineError, never>;
}

/** Compile a {@link StateMachineSpec} into a runnable machine.
 * Throws (synchronously, at declaration) when `initial` or any
 * transition target names an undeclared state. */
export const defineStateMachine = <State extends string, Event extends string, Ctx = unknown>(
	spec: StateMachineSpec<State, Event, Ctx>,
): StateMachine<State, Event, Ctx> => {
	const stateSet = new Set<string>(Object.keys(spec.states));
	if (!stateSet.has(spec.initial)) {
		throw new Error(`statemachine "${spec.id}": initial state "${spec.initial}" is not declared`);
	}
	for (const state of Object.keys(spec.states) as State[]) {
		const node = spec.states[state];
		for (const [event, transition] of Object.entries(node.on ?? {}) as [
			Event,
			Transition<State, Event, Ctx>,
		][]) {
			const to = typeof transition === "string" ? transition : transition?.to;
			if (to === undefined || !stateSet.has(to)) {
				throw new Error(
					`statemachine "${spec.id}": ${state} --${event}--> "${String(to)}" targets an undeclared state`,
				);
			}
		}
	}
	const terminal = new Set<string>(spec.terminal ?? []);
	const states = Object.keys(spec.states) as State[];
	const isState = (value: unknown): value is State =>
		typeof value === "string" && stateSet.has(value);

	/** Resolve an `on` entry to its target — bare string or object. */
	const targetOf = (
		transition: Transition<State, Event, Ctx>,
	): { readonly to: State; readonly guard?: TransitionGuard<State, Event, Ctx> } =>
		typeof transition === "string" ? { to: transition } : transition;

	const edgesFor = (event: Event): readonly MachineEdge<State>[] => {
		const edges: MachineEdge<State>[] = [];
		for (const state of states) {
			const transition = spec.states[state].on?.[event];
			if (transition === undefined) continue;
			const target = targetOf(transition);
			edges.push({ from: state, to: target.to });
		}
		return edges;
	};

	const machine: StateMachine<State, Event, Ctx> = {
		id: spec.id,
		initial: spec.initial,
		states,
		isState,
		isTerminal: (state) => terminal.has(state),
		events: (state) => {
			const node = spec.states[state];
			return node === undefined ? [] : (Object.keys(node.on ?? {}) as Event[]);
		},
		can: (state, event) => spec.states[state]?.on?.[event] !== undefined,
		predecessors: (event, to) =>
			edgesFor(event)
				.filter((edge) => to === undefined || edge.to === to)
				.map((edge) => edge.from),
		edges: edgesFor,
		step: (state, event, context) =>
			Effect.gen(function* () {
				if (!isState(state)) {
					return yield* new InvalidTransitionError({
						machineId: spec.id,
						from: String(state),
						event,
					});
				}
				const transition = spec.states[state].on?.[event];
				if (transition === undefined) {
					return yield* new InvalidTransitionError({
						machineId: spec.id,
						from: state,
						event,
					});
				}
				const target = targetOf(transition);
				if (target.guard !== undefined) {
					const verdict = yield* Effect.suspend(() => {
						try {
							const out = target.guard!({
								state,
								event,
								context: context as Ctx,
							});
							return Effect.isEffect(out)
								? (out as Effect.Effect<boolean, unknown, never>)
								: Effect.succeed(out);
						} catch (cause) {
							return Effect.fail(cause);
						}
					}).pipe(
						Effect.map((allowed) => ({ ok: true as const, allowed: Boolean(allowed) })),
						Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
					);
					if (!verdict.ok) {
						return yield* new TransitionRejectedError({
							machineId: spec.id,
							from: state,
							event,
							cause: verdict.cause,
						});
					}
					if (!verdict.allowed) {
						return yield* new TransitionRejectedError({
							machineId: spec.id,
							from: state,
							event,
						});
					}
				}
				return {
					from: state,
					event,
					to: target.to,
					reentered: target.to === state,
				} satisfies TransitionResult<State, Event>;
			}),
	};
	return machine;
};

/** Normalize a store failure into {@link StateStoreError} — same
 * foreign-error idiom as the orchestrator runner's `toNodeError`. */
const toStoreError =
	(machineId: string, op: "load" | "save") =>
	(cause: unknown): StateStoreError =>
		new StateStoreError({ machineId, op, cause });

export interface CommitOptions<State extends string, Ctx> {
	/** Forwarded to guards as `GuardInput.context`. */
	readonly context?: Ctx;
	/** State to step FROM when `store.load` returns `Option.none`
	 * (entity not yet persisted). Absent → {@link StateNotFoundError}. */
	readonly initial?: State;
}

/** Load → `step` → conditional `save`, the optimistic-concurrency
 * pattern behind every claim/retry in the plugins this kit absorbs:
 *
 * 1. `store.load` reads the current state (`Option.none` = missing).
 * 2. `machine.step` evaluates the transition + guard.
 * 3. `store.save({from, to})` must land ONLY when the row is still in
 *    `from` — a `false` return means a concurrent writer won and the
 *    attempt fails {@link TransitionConflictError} (retry or no-op,
 *    caller's choice — eval-persona's item claim treats it as a
 *    skip).
 *
 * Store failures normalize into {@link StateStoreError}; guard
 * failures into {@link TransitionRejectedError}. Single attempt —
 * loop `commit` yourself when retries are wanted. */
export const commit = <State extends string, Event extends string, Ctx = unknown>(
	machine: StateMachine<State, Event, Ctx>,
	store: StateStore<State>,
	event: Event,
	opts?: CommitOptions<State, Ctx>,
): Effect.Effect<TransitionResult<State, Event>, StateMachineError, never> =>
	Effect.gen(function* () {
		const loaded = yield* store.load().pipe(Effect.mapError(toStoreError(machine.id, "load")));
		const missing = Option.isNone(loaded);
		const from = missing ? opts?.initial : loaded.value;
		if (from === undefined) {
			return yield* new StateNotFoundError({ machineId: machine.id });
		}
		const result = yield* machine.step(from, event, opts?.context);
		const saved = yield* store
			.save({ from: missing ? null : result.from, to: result.to })
			.pipe(Effect.mapError(toStoreError(machine.id, "save")));
		if (!saved) {
			return yield* new TransitionConflictError({
				machineId: machine.id,
				from: result.from,
				to: result.to,
				event,
			});
		}
		return result;
	});
