import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { DocumentRecord, DocumentStoreError } from "@ktb/document-store";
import { DocumentStore } from "@ktb/document-store";
import { PluginStates } from "@ktb/platform/plugin-states";
import { Permissions, splitPermission } from "@ktb/rbac";

import { defOwnerEnabled, FlowDefinitions, type FlowDef } from "./definition.ts";
import { FlowsHooks, FlowsHooksLive, type FlowHookHandle } from "./hooks.ts";
import { currentState, planWrites, resolveTransition } from "./interpreter.ts";

/**
 * Flows service — the runtime half of `flow.def`. Flows are
 * PULL-based state machines over document-store collections: callers
 * (server fns, hooks, other plugins) ask `canTransition`/`transition`
 * explicitly; nothing fires on its own (that is `trigger.def`'s job —
 * triggers react to writes after the fact, flows decide which writes
 * are legal before they happen).
 *
 * `transition` contract:
 *
 * 1. Resolve the def by id; the input `collection` must match
 *    `def.collection` (a mismatch is indistinguishable from an unknown
 *    flow — `UnknownFlow`).
 * 2. `def.permission` (optional `"resource.action"`) is checked
 *    through the OPTIONAL `Permissions` port: absent service or denied
 *    grant fails closed with `FlowPermissionDenied`.
 * 3. The record is read through `DocumentStore` with NO ctx — the
 *    bound `Principal` supplies owner/tenant fencing, so a caller can
 *    never transition a record outside its visible scope (missing and
 *    not-visible are the same `FlowRecordNotFound`).
 * 4. The pure interpreter ({@link resolveTransition}) decides
 *    legality: undeclared state, missing `on.<event>` and failed
 *    guards all collapse to `IllegalTransition`.
 * 5. OPTIMISTIC STATE RE-CHECK: the record is re-read immediately
 *    before the write and the state re-resolved — a concurrent
 *    transition that landed in between fails `FlowStateConflict`
 *    instead of silently overwriting. (DocumentStore has no CAS;
 *    this narrows but cannot eliminate the race — same honesty
 *    contract as any read-then-write.)
 * 6. ONE `store.update` carries every `set-field` action plus the
 *    `stateField` write (see ./interpreter.ts `planWrites`) — the
 *    state change and its side effects commit atomically.
 * 7. `hook` actions run AFTER the commit, in declaration order, each
 *    bounded by {@link FLOW_HOOK_TIMEOUT}. Failures (including
 *    `UnknownFlowHook` and timeouts) are logged and isolated — a hook
 *    can never roll back a committed transition.
 *
 * ENABLEMENT: defs are static composition data collected from the FULL
 * registry; enablement is runtime state. Every call re-reads
 * `PluginStates.enabledIds()` (optional port — absent service means
 * "no gate", same convention as `Permissions`) and treats a def whose
 * `owner` plugin/package is disabled as `UnknownFlow` — a disabled
 * plugin's flows are invisible to every entry point, and a
 * /platform/plugins toggle applies without a layer rebuild.
 *
 * NO-OP TRANSITIONS: when the resolved transition is a self-loop
 * (`to === from`) AND the write plan is empty, `store.update` is
 * skipped entirely — no `updated_at` bump, no write event for
 * triggers to react to. Declared `hook` actions still run (they are
 * part of the transition, not of the write) against the fresh record.
 */

/** Which document a flow call targets. `collection` must equal the
 * def's governed collection. */
export interface FlowTargetInput {
	readonly flow: string;
	readonly collection: string;
	readonly id: number;
}

/** A transition attempt: the target plus the event name and its
 * optional payload (guard/template scope `event.*`). */
export interface FlowEventInput extends FlowTargetInput {
	readonly event: string;
	readonly payload?: unknown;
}

/** `currentState` result: the resolved state plus the record it was
 * read from (callers rendering UIs want both). */
export interface FlowStateInfo {
	readonly flow: FlowDef;
	readonly state: string;
	readonly record: DocumentRecord;
}

/** `transition` result: the committed transition plus the updated
 * record. */
export interface FlowTransitionResult {
	readonly flow: FlowDef;
	readonly from: string;
	readonly to: string;
	readonly record: DocumentRecord;
}

/** No flow def with this id governs this collection. */
export class UnknownFlow extends Data.TaggedError("UnknownFlow")<{
	readonly flow: string;
	readonly collection: string;
}> {}

/** The target record is missing or outside the caller's visible
 * scope (indistinguishable by design — no existence oracle). */
export class FlowRecordNotFound extends Data.TaggedError("FlowRecordNotFound")<{
	readonly flow: string;
	readonly collection: string;
	readonly id: number;
}> {}

/** The event is not a legal transition from the document's current
 * state: undeclared state, no `on.<event>` handler, or a failed
 * guard. `reason` is the interpreter's {@link TransitionRejection}. */
export class IllegalTransition extends Data.TaggedError("IllegalTransition")<{
	readonly flow: string;
	readonly collection: string;
	readonly id: number;
	readonly event: string;
	readonly state: string | undefined;
	readonly reason: string;
}> {}

/** The optimistic re-check saw a different state than the one the
 * transition was resolved against — a concurrent write landed first. */
export class FlowStateConflict extends Data.TaggedError("FlowStateConflict")<{
	readonly flow: string;
	readonly collection: string;
	readonly id: number;
	readonly event: string;
	readonly expected: string;
	readonly actual: string;
}> {}

/** `def.permission` was declared but the caller lacks the grant —
 * or no `Permissions` service is bound (fail closed). */
export class FlowPermissionDenied extends Data.TaggedError("FlowPermissionDenied")<{
	readonly flow: string;
	readonly permission: string;
}> {}

export type FlowError =
	| UnknownFlow
	| FlowRecordNotFound
	| IllegalTransition
	| FlowStateConflict
	| FlowPermissionDenied;

export interface FlowsShape {
	/** Every collected flow def (topo order) — introspection/tooling.
	 * UNFILTERED: includes defs whose owner plugin is currently
	 * disabled (enablement gates the operations below, not this list —
	 * it is synchronous and cannot await `PluginStates`). */
	readonly defs: readonly FlowDef[];
	/** The document's current state: stored `stateField` value, else
	 * `def.initial`. `null` for unknown/disabled flows, denied
	 * permission and missing/invisible records. */
	readonly currentState: (
		input: FlowTargetInput,
	) => Effect.Effect<FlowStateInfo | null, DocumentStoreError>;
	/** Would `event` resolve to a transition right now? `false` for
	 * unknown/disabled flows, missing records, denied permission and
	 * every illegal transition — never throws on legality, only on
	 * store failures. */
	readonly canTransition: (input: FlowEventInput) => Effect.Effect<boolean, DocumentStoreError>;
	/** Resolve + commit a transition (see the module doc for the full
	 * contract). */
	readonly transition: (
		input: FlowEventInput,
	) => Effect.Effect<FlowTransitionResult, FlowError | DocumentStoreError>;
}

export class Flows extends Context.Service<Flows, FlowsShape>()("@ktb/flows/Flows") {}

/** Post-commit hook bound — a hung handler must not pin the
 * transition's fiber forever (the write already committed; the hook
 * is best-effort). Same order of magnitude as other in-process
 * timeout conventions in the repo. */
const FLOW_HOOK_TIMEOUT = "30 seconds";

export const FlowsLive = Layer.effect(
	Flows,
	Effect.gen(function* () {
		const registry = yield* FlowDefinitions;
		const store = yield* DocumentStore;
		const hooks = yield* FlowsHooks;
		// Permissions is an OPTIONAL port (the rbac plugin may be
		// disabled or ordered later): a def declaring `permission`
		// fails closed without it — same contract as @ktb/api exposures.
		const permissions = yield* Effect.serviceOption(Permissions);
		// PluginStates is likewise an OPTIONAL port: when bound, defs
		// owned by disabled plugins/packages resolve as UnknownFlow on
		// every call (runtime enablement — see the module doc).
		const pluginStates = yield* Effect.serviceOption(PluginStates);

		const byId = new Map(registry.flows.map((def) => [def.id, def] as const));

		/** Def lookup + collection match + owner enablement — one
		 * indistinguishable `UnknownFlow` for all failure modes (a
		 * disabled plugin's flow is invisible, not an error). */
		const resolveDef = (input: FlowTargetInput): Effect.Effect<FlowDef, UnknownFlow> =>
			Effect.gen(function* () {
				const def = byId.get(input.flow);
				const unknown = new UnknownFlow({ flow: input.flow, collection: input.collection });
				if (def === undefined || def.collection !== input.collection) {
					return yield* Effect.fail(unknown);
				}
				if (Option.isSome(pluginStates)) {
					const enabled = yield* pluginStates.value.enabledIds();
					if (!defOwnerEnabled(registry.ownerIndex, def.owner, enabled)) {
						return yield* Effect.fail(unknown);
					}
				}
				return def;
			});

		/** Optional permission gate — checked before any store read so a
		 * denied caller learns nothing about the record. */
		const authorize = (def: FlowDef): Effect.Effect<void, FlowPermissionDenied> => {
			const permission = def.permission;
			if (permission === undefined) return Effect.void;
			if (Option.isNone(permissions)) {
				return Effect.fail(new FlowPermissionDenied({ flow: def.id, permission }));
			}
			const { resource, action } = splitPermission(permission);
			return Effect.flatMap(permissions.value.can(resource, action), (allowed) =>
				allowed ? Effect.void : Effect.fail(new FlowPermissionDenied({ flow: def.id, permission })),
			);
		};

		const getRecord = (
			def: FlowDef,
			id: number,
		): Effect.Effect<DocumentRecord, FlowRecordNotFound | DocumentStoreError> =>
			Effect.flatMap(store.get(def.collection, id), (record) =>
				record === null
					? Effect.fail(
							new FlowRecordNotFound({
								flow: def.id,
								collection: def.collection,
								id,
							}),
						)
					: Effect.succeed(record),
			);

		const illegal = (
			def: FlowDef,
			input: FlowEventInput,
			state: string | undefined,
			reason: string,
		): IllegalTransition =>
			new IllegalTransition({
				flow: def.id,
				collection: def.collection,
				id: input.id,
				event: input.event,
				state,
				reason,
			});

		return Flows.of({
			defs: registry.flows,

			currentState: (input) =>
				Effect.gen(function* () {
					const def = yield* resolveDef(input);
					// Same permission gate as transition — a denied caller
					// learns nothing, not even the state (fail closed).
					yield* authorize(def);
					const record = yield* store.get(def.collection, input.id);
					if (record === null) return null;
					return {
						flow: def,
						state: currentState(def, record.data as Record<string, unknown>),
						record,
					};
				}).pipe(
					// UnknownFlow/missing record/denied permission collapse
					// to null — same "not visible" contract as the store's
					// scoped reads.
					Effect.catchTag("UnknownFlow", () => Effect.succeed(null)),
					Effect.catchTag("FlowPermissionDenied", () => Effect.succeed(null)),
				),

			canTransition: (input) =>
				Effect.gen(function* () {
					const def = yield* resolveDef(input);
					// Same permission gate as transition — denied reads as
					// "not transitionable" (fail closed).
					yield* authorize(def);
					const record = yield* store.get(def.collection, input.id);
					if (record === null) return false;
					return resolveTransition(
						def,
						record.data as Record<string, unknown>,
						input.event,
						input.payload,
					).ok;
				}).pipe(
					// UnknownFlow/denied permission is a caller-visible
					// "not transitionable" — canTransition never fails on
					// legality, only on store errors.
					Effect.catchTag("UnknownFlow", () => Effect.succeed(false)),
					Effect.catchTag("FlowPermissionDenied", () => Effect.succeed(false)),
				),

			transition: (input) =>
				Effect.gen(function* () {
					const def = yield* resolveDef(input);
					yield* authorize(def);
					const record = yield* getRecord(def, input.id);
					const data = record.data as Record<string, unknown>;
					const resolution = resolveTransition(def, data, input.event, input.payload);
					if (!resolution.ok) {
						return yield* Effect.fail(illegal(def, input, resolution.state, resolution.reason));
					}
					// Optimistic re-check: re-read and re-resolve against
					// the FRESH state before writing — a concurrent
					// transition fails loudly instead of being
					// overwritten. The patch is also computed from the
					// fresh data so unrelated concurrent field writes
					// are preserved (store.update merges top-level).
					const fresh = yield* getRecord(def, input.id);
					const freshState = currentState(def, fresh.data as Record<string, unknown>);
					if (freshState !== resolution.from) {
						return yield* Effect.fail(
							new FlowStateConflict({
								flow: def.id,
								collection: def.collection,
								id: input.id,
								event: input.event,
								expected: resolution.from,
								actual: freshState,
							}),
						);
					}
					const freshResolution = resolveTransition(
						def,
						fresh.data as Record<string, unknown>,
						input.event,
						input.payload,
					);
					if (!freshResolution.ok || freshResolution.from !== resolution.from) {
						return yield* Effect.fail(
							new FlowStateConflict({
								flow: def.id,
								collection: def.collection,
								id: input.id,
								event: input.event,
								expected: resolution.from,
								actual: freshState,
							}),
						);
					}
					const plan = planWrites(def, fresh.data as Record<string, unknown>, freshResolution);
					// No-op self-loop: `to === from` AND an empty patch means
					// the write would change nothing — skip store.update so
					// no updated_at bump and no record-written event fires
					// for triggers to react to. (A self-loop that DOES
					// write fields, or the first transition persisting
					// `initial` into an unset stateField, still commits.)
					const noop = resolution.to === resolution.from && Object.keys(plan.patch).length === 0;
					const updated = noop ? fresh : yield* store.update(def.collection, input.id, plan.patch);
					// Post-commit hooks: ordered, isolated, never fatal,
					// each bounded by FLOW_HOOK_TIMEOUT.
					yield* Effect.forEach(
						plan.hookIds,
						(hookId) => {
							const handle: FlowHookHandle = {
								flow: def,
								record: updated,
								event: { name: input.event, payload: input.payload },
								from: resolution.from,
								to: resolution.to,
							};
							return hooks.invoke(hookId, handle).pipe(
								Effect.timeout(FLOW_HOOK_TIMEOUT),
								Effect.catchCause((cause) =>
									Effect.logError("flow hook failed", {
										flow: def.id,
										hook: hookId,
										cause,
									}),
								),
							);
						},
						{ discard: true },
					);
					return {
						flow: def,
						from: resolution.from,
						to: resolution.to,
						record: updated,
					};
				}),
		});
	}),
);

/** The services-layer export: the Flows runtime plus the shared
 * FlowsHooks registry other plugins register post-commit handlers on
 * (provideMerge wires the registry into FlowsLive's requirement and
 * re-exports it for dependents — same shape as
 * `TriggersServicesLive`/`WizardsServicesLive`). */
export const FlowsServicesLive = FlowsLive.pipe(Layer.provideMerge(FlowsHooksLive));
