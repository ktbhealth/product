import {
	evaluateCondition,
	getPath,
	isRecord,
	jsonEquals,
	resolveTemplate,
	setPath,
} from "@ktb/dsl";

import {
	FLOW_EVENT_PATTERN,
	type FlowAction,
	type FlowDef,
	type FlowTransition,
} from "./definition.ts";

/**
 * Flow interpreter — the PURE half of the runtime. Everything here is
 * synchronous, Effect-free and store-free: given a {@link FlowDef}, a
 * document's `data` payload, an event name and an optional payload it
 * answers "which transition (if any) does this event take?" and "what
 * does the resulting write look like?". The `Flows` service
 * (./service.ts) owns fetching records, permission checks, the atomic
 * DocumentStore update and post-commit hooks.
 *
 * Scope grammar (shared by guards and `set-field` templates):
 *
 * - `record.*` — dot paths into the document's `data`
 * - `event.*`  — dot paths into the transition payload (non-object
 *   payloads are wrapped as `{ value: <payload> }` so `$event.value`
 *   always reaches them)
 * - `flow.*`   — `{ id, title }` of the governing definition
 *
 * Templates are `"$<scope>.<dot.path>"` strings; anything else is a
 * literal (same contract as trigger/wizard templates — unresolved
 * paths pass the template through literally).
 */

/** Everything a guard/template resolves against for ONE transition
 * attempt. */
export interface TransitionScope {
	readonly record: Record<string, unknown>;
	readonly event: Record<string, unknown>;
	readonly flow: { readonly id: string; readonly title?: string };
}

/** Build the resolution scope for a transition attempt. `payload` is
 * the caller-supplied event payload (`Flows.transition`'s `payload`). */
export const transitionScope = (
	def: FlowDef,
	data: Record<string, unknown>,
	payload: unknown,
): TransitionScope => ({
	record: data,
	event: isRecord(payload) ? payload : { value: payload },
	flow: { id: def.id, ...(def.title === undefined ? {} : { title: def.title }) },
});

/** The raw state stored at `def.stateField` — a non-empty string, or
 * `undefined` when the field is absent/empty (flows never
 * auto-initialize; see {@link currentState}). */
export const readState = (def: FlowDef, data: Record<string, unknown>): string | undefined => {
	const value = getPath(data, def.stateField);
	return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** The state a document is in RIGHT NOW: the stored `stateField`
 * value when present, else `def.initial` (the documented starting
 * point — nothing writes it until the first transition lands). */
export const currentState = (def: FlowDef, data: Record<string, unknown>): string =>
	readState(def, data) ?? def.initial;

/** Why an event did not resolve to a transition. */
export type TransitionRejection = "unknown-state" | "no-transition" | "guard-failed";

export type TransitionResolution =
	| {
			readonly ok: true;
			/** State the document was in when the transition resolved. */
			readonly from: string;
			/** `transition.target` — the next state. */
			readonly to: string;
			readonly transition: FlowTransition;
			readonly scope: TransitionScope;
	  }
	| {
			readonly ok: false;
			readonly reason: TransitionRejection;
			/** The state the event was attempted from (`undefined` when
			 * the stored stateField held a non-string value). */
			readonly state: string | undefined;
			readonly event: string;
	  };

/**
 * Resolve `event` against `def` for a document whose `data` is `data`.
 * Pure and total: every non-transition outcome is a typed
 * {@link TransitionResolution} failure, never a throw.
 *
 * Order of checks: the event name must match {@link FLOW_EVENT_PATTERN}
 * (wire input is untrusted — anything else is `no-transition` before any
 * lookup) → stored state must be a DECLARED state (a stateField
 * holding an undeclared/garbage value is `unknown-state`, not a silent
 * fallback to `initial` — only absent/empty falls back) → the state
 * must declare `on.<event>` (`no-transition`) → the transition's
 * optional `guard` must hold over the scope (`guard-failed`).
 *
 * All object lookups use `Object.hasOwn`, never `in`/bare indexing:
 * event names like `"constructor"` are LEGAL (`FLOW_EVENT_PATTERN`
 * admits them) and state names like `"toString"` can arrive via
 * document data — a prototype-chain hit must read as "not declared",
 * not as an inherited member.
 */
export const resolveTransition = (
	def: FlowDef,
	data: Record<string, unknown>,
	event: string,
	payload?: unknown,
): TransitionResolution => {
	const stored = readState(def, data);
	const state = stored ?? def.initial;
	const scope = transitionScope(def, data, payload);
	// Wire-level event names are untrusted: reject anything outside the
	// def grammar before touching the state machine (also keeps
	// "__proto__"-style names — illegal per the pattern — away from the
	// `on` lookup entirely).
	if (!FLOW_EVENT_PATTERN.test(event)) {
		return { ok: false, reason: "no-transition", state, event };
	}
	const stateDef = Object.hasOwn(def.states, state) ? def.states[state] : undefined;
	if (stateDef === undefined) {
		return { ok: false, reason: "unknown-state", state: stored, event };
	}
	const on = stateDef.on;
	// hasOwn, not `on[event]`: "constructor"/"toString" are legal event
	// names and must only match DECLARED handlers — an inherited
	// Object.prototype member is not a transition.
	const transition = on !== undefined && Object.hasOwn(on, event) ? on[event] : undefined;
	if (transition === undefined) {
		return { ok: false, reason: "no-transition", state, event };
	}
	if (transition.guard !== undefined && !evaluateCondition(transition.guard, scope)) {
		return { ok: false, reason: "guard-failed", state, event };
	}
	return { ok: true, from: state, to: transition.target, transition, scope };
};

// `resolveTemplate`/`setPath` come from @ktb/dsl — re-exported here so
// the interpreter's public surface is unchanged.
export { resolveTemplate } from "@ktb/dsl";

/** The write plan for a resolved transition: the top-level patch keys
 * DocumentStore's shallow merge needs (only CHANGED top-level keys are
 * emitted — untouched subtrees are never re-sent, so a schema-tightened
 * collection can't fail on stale untouched fields) plus the ordered
 * hook ids to run post-commit. */
export interface WritePlan {
	/** Shallow top-level patch — pass straight to `store.update`. */
	readonly patch: Record<string, unknown>;
	/** `hook` action ids in declaration order. */
	readonly hookIds: readonly string[];
}

/**
 * Fold a resolved transition into ONE DocumentStore update payload:
 * every `set-field` action (template-resolved against the scope) plus
 * the `stateField` write land in a single patch. `stateField` is
 * written LAST so it is authoritative even if an action targets the
 * same path.
 */
export const planWrites = (
	def: FlowDef,
	data: Record<string, unknown>,
	resolution: Extract<TransitionResolution, { ok: true }>,
): WritePlan => {
	const next = structuredClone(data);
	const hookIds: string[] = [];
	for (const action of resolution.transition.actions ?? []) {
		applyAction(action, next, resolution.scope, hookIds);
	}
	setPath(next, def.stateField, resolution.to);
	// Diff top-level keys: only changed roots go into the patch.
	const patch: Record<string, unknown> = {};
	const keys = new Set([...Object.keys(data), ...Object.keys(next)]);
	for (const key of keys) {
		if (!jsonEquals(data[key], next[key])) patch[key] = next[key];
	}
	return { patch, hookIds };
};

const applyAction = (
	action: FlowAction,
	next: Record<string, unknown>,
	scope: TransitionScope,
	hookIds: string[],
): void => {
	if (action.kind === "set-field") {
		setPath(next, action.field, resolveTemplate(action.value, scope));
		return;
	}
	hookIds.push(action.hook);
};
