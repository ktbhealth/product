import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { DocumentRecord } from "@ktb/document-store";

import type { FlowDef } from "./definition.ts";

/**
 * FlowsHooks — the post-commit hook registry. A transition whose
 * `actions` include `{ kind: "hook", hook: "<id>" }` resolves here:
 * any plugin registers a handler at layer-build time and the Flows
 * service invokes it AFTER the state write commits.
 *
 * Mirrors `WizardHooks`/`TriggersHooks`: same mutable-registry
 * pattern, same trust contract. Handlers receive the transitioned
 * record and the caller-supplied event payload as UNTRUSTED input —
 * `handle.record.data` is user-controlled record content and
 * `handle.event.payload` is user-controlled transition input (the
 * event NAME is grammar-checked, the payload is not), so handlers
 * must validate what they consume and scope any writes to the
 * record's `ownerId`/`tenantId` attribution (or their own tenancy
 * rules).
 * Registering a hook is a composition-time act: do it inside the
 * plugin's services layer (`yield* FlowsHooks` then `register`),
 * never per-request. Hook failures are logged and isolated by the
 * caller — a hook can never roll back a committed transition.
 */

/** Everything a hook handler sees about the committed transition. */
export interface FlowHookHandle {
	/** The flow definition that governed the transition. */
	readonly flow: FlowDef;
	/** The record AFTER the transition write committed. */
	readonly record: DocumentRecord;
	/** The event that drove the transition: its name and the raw
	 * caller-supplied payload (untrusted — validate before use). */
	readonly event: {
		readonly name: string;
		readonly payload: unknown;
	};
	/** State the document was in before the write. */
	readonly from: string;
	/** State the document is in after the write (`transition.target`). */
	readonly to: string;
}

export type FlowHookHandler = (handle: FlowHookHandle) => Effect.Effect<unknown, unknown, unknown>;

/** A transition action named a hook id nothing registered. */
export class UnknownFlowHook extends Data.TaggedError("UnknownFlowHook")<{
	readonly hook: string;
}> {}

export class FlowsHooks extends Context.Service<
	FlowsHooks,
	{
		/** Register a post-commit handler. Re-registering an id replaces
		 * the previous handler (last wins — deterministic in topo order). */
		readonly register: (id: string, handler: FlowHookHandler) => void;
		/** Look up a handler without invoking — tooling/introspection. */
		readonly get: (id: string) => FlowHookHandler | undefined;
		/** Invoke the handler for `id`; fails `UnknownFlowHook` when
		 * absent. Handler errors propagate to the caller — the Flows
		 * service logs and isolates them per hook (see ./service.ts).
		 *
		 * R is erased to `never`: handlers are registered at layer-build
		 * time and their requirements resolve against the ONE composed
		 * plugin runtime — the registry cannot name them statically
		 * (same type-erasure contract as `Layer.Any` plugin services).
		 * A handler requiring a service absent from the runtime dies as
		 * a defect, exactly like an unsatisfied layer requirement. */
		readonly invoke: (id: string, handle: FlowHookHandle) => Effect.Effect<unknown, unknown, never>;
	}
>()("@ktb/flows/FlowsHooks") {}

/** The resolved service shape (register/get/invoke) — consumers that
 * take the registry as a parameter use this interface rather than the
 * Context tag so tests can pass stubs. */
export type FlowsHooksService = FlowsHooks["Service"];

export const FlowsHooksLive = Layer.sync(FlowsHooks, () => {
	const handlers = new Map<string, FlowHookHandler>();
	return FlowsHooks.of({
		register: (id, handler) => {
			handlers.set(id, handler);
		},
		get: (id) => handlers.get(id),
		invoke: (id, handle) => {
			const handler = handlers.get(id);
			if (handler === undefined) {
				return Effect.fail(new UnknownFlowHook({ hook: id }));
			}
			// R-erasure documented on the service shape above.
			return handler(handle) as Effect.Effect<unknown, unknown, never>;
		},
	});
});
