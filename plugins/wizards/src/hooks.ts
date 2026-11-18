import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { WizardDefinition } from "./definition.ts";

/**
 * WizardHooks — the completion-hook registry. The `wizard.def`
 * `completion: { kind: "hook", hook: "<id>" }` target resolves here:
 * any plugin registers a handler at layer-build time and the run
 * service invokes it when a run completes.
 *
 * TRUST CONTRACT: hook handlers receive the run's submitted answers
 * (`payload`) as UNTRUSTED input — the wizard runner is user-facing,
 * so answers are user-controlled data. Handlers must validate what
 * they consume (same rule as any request payload) and must scope any
 * writes to the run owner (`run.ownerId`) or their own tenancy rules.
 * Registering a hook is a composition-time act: do it inside the
 * plugin's services layer (`yield* WizardHooks` then `register`),
 * never per-request.
 */

/** Everything a hook handler sees about the finished run. */
export interface WizardRunHandle {
	readonly id: number;
	/** Wizard id (def.id / run key). */
	readonly key: string;
	/** Session user id that owns the run. */
	readonly ownerId: string;
	/** The snapshotted definition the run executed. */
	readonly definition: WizardDefinition;
	/** Submitted answers: step id → step value. */
	readonly answers: Readonly<Record<string, unknown>>;
	/** Resolved completion `data` payload (template-expanded). */
	readonly payload: Readonly<Record<string, unknown>>;
}

export type WizardHookHandler = (run: WizardRunHandle) => Effect.Effect<unknown, unknown, unknown>;

/** Completion named a hook id nothing registered. */
export class UnknownWizardHook extends Data.TaggedError("UnknownWizardHook")<{
	readonly hook: string;
}> {}

export class WizardHooks extends Context.Service<
	WizardHooks,
	{
		/** Register a completion handler. Re-registering an id replaces
		 * the previous handler (last wins — deterministic in topo order). */
		readonly register: (id: string, handler: WizardHookHandler) => void;
		/** Look up a handler without invoking — tooling/introspection. */
		readonly get: (id: string) => WizardHookHandler | undefined;
		/** Invoke the handler for `id`; fails `UnknownWizardHook` when
		 * absent. Handler errors propagate (completion is best-effort
		 * recorded by the caller — see service.ts).
		 *
		 * R is erased to `never`: handlers are registered at layer-build
		 * time and their requirements resolve against the ONE composed
		 * plugin runtime — the registry cannot name them statically
		 * (same type-erasure contract as `Layer.Any` plugin services).
		 * A handler requiring a service absent from the runtime dies as
		 * a defect, exactly like an unsatisfied layer requirement. */
		readonly invoke: (id: string, run: WizardRunHandle) => Effect.Effect<unknown, unknown, never>;
	}
>()("@ktb/wizards/WizardHooks") {}

export const WizardHooksLive = Layer.sync(WizardHooks, () => {
	const handlers = new Map<string, WizardHookHandler>();
	return WizardHooks.of({
		register: (id, handler) => {
			handlers.set(id, handler);
		},
		get: (id) => handlers.get(id),
		invoke: (id, run) => {
			const handler = handlers.get(id);
			if (handler === undefined) {
				return Effect.fail(new UnknownWizardHook({ hook: id }));
			}
			// R-erasure documented on the service shape above.
			return handler(run) as Effect.Effect<unknown, unknown, never>;
		},
	});
});
