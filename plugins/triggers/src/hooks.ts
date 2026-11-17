import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { DocumentRecordWrittenEvent } from "@ktb/document-store";

import type { TriggerDef } from "./definition.ts";

/**
 * TriggersHooks — the reaction-hook registry. A `trigger.def` whose
 * action is `{ kind: "hook", hook: "<id>" }` resolves here: any plugin
 * registers a handler at layer-build time and the triggers engine
 * invokes it when a matching document-store write lands.
 *
 * Mirrors `WizardHooks` (@ktb/wizards): same mutable-registry pattern,
 * same trust contract. Hook handlers receive the written record's
 * payload as UNTRUSTED input — `event.data` is user-controlled record
 * content, so handlers must validate what they consume and scope any
 * writes to the event's `ownerId`/`tenantId` attribution (or their own
 * tenancy rules). Registering a hook is a composition-time act: do it
 * inside the plugin's services layer (`yield* TriggersHooks` then
 * `register`), never per-request.
 */

/** Everything a hook handler sees about the fired trigger. */
export interface TriggerHookHandle {
	/** The trigger definition that fired (id, collection, ops, action). */
	readonly trigger: TriggerDef;
	/** The committed write: collection, record id, op, data payload,
	 * ownerId/tenantId attribution and cascade depth. */
	readonly event: DocumentRecordWrittenEvent;
}

export type TriggerHookHandler = (
	handle: TriggerHookHandle,
) => Effect.Effect<unknown, unknown, unknown>;

/** A trigger action named a hook id nothing registered. */
export class UnknownTriggerHook extends Data.TaggedError("UnknownTriggerHook")<{
	readonly hook: string;
}> {}

export class TriggersHooks extends Context.Service<
	TriggersHooks,
	{
		/** Register a reaction handler. Re-registering an id replaces
		 * the previous handler (last wins — deterministic in topo order). */
		readonly register: (id: string, handler: TriggerHookHandler) => void;
		/** Look up a handler without invoking — tooling/introspection. */
		readonly get: (id: string) => TriggerHookHandler | undefined;
		/** Invoke the handler for `id`; fails `UnknownTriggerHook` when
		 * absent. Handler errors propagate to the caller — the triggers
		 * engine logs and isolates them per trigger (see ./runner.ts).
		 *
		 * R is erased to `never`: handlers are registered at layer-build
		 * time and their requirements resolve against the ONE composed
		 * plugin runtime — the registry cannot name them statically
		 * (same type-erasure contract as `Layer.Any` plugin services).
		 * A handler requiring a service absent from the runtime dies as
		 * a defect, exactly like an unsatisfied layer requirement. */
		readonly invoke: (
			id: string,
			handle: TriggerHookHandle,
		) => Effect.Effect<unknown, unknown, never>;
	}
>()("@ktb/triggers/TriggersHooks") {}

/** The resolved service shape (register/get/invoke) — consumers that
 * take the registry as a parameter (e.g. the runner) use this
 * interface rather than the Context tag so tests can pass stubs. */
export type TriggersHooksService = TriggersHooks["Service"];

export const TriggersHooksLive = Layer.sync(TriggersHooks, () => {
	const handlers = new Map<string, TriggerHookHandler>();
	return TriggersHooks.of({
		register: (id, handler) => {
			handlers.set(id, handler);
		},
		get: (id) => handlers.get(id),
		invoke: (id, handle) => {
			const handler = handlers.get(id);
			if (handler === undefined) {
				return Effect.fail(new UnknownTriggerHook({ hook: id }));
			}
			// R-erasure documented on the service shape above.
			return handler(handle) as Effect.Effect<unknown, unknown, never>;
		},
	});
});
