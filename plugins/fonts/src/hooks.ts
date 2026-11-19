import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * FontHooks — the change-notification registry. The `Fonts` service
 * invokes every registered handler after each committed mutation so
 * consumers (the theme plugin's font config is the first intended
 * one) can cascade font-catalog changes without polling.
 *
 * Mirrors `WizardHooks` (@ktb/wizards) / `TriggersHooks` (@ktb/triggers):
 * same mutable-registry pattern, same trust contract. Handles carry
 * provider ids and family names — reference data, not user payloads —
 * but handlers must still scope any writes to their own tenancy rules.
 * Registering a hook is a composition-time act: do it inside the
 * plugin's services layer (`yield* FontHooks` then `register`), never
 * per-request.
 *
 * Dispatch is broadcast: EVERY registered handler sees EVERY fonts
 * event and filters on `handle.event` — there is no per-event
 * subscription id. Handlers run inline after the mutation commits;
 * the service logs and swallows their failures so a broken consumer
 * can never fail an admin write.
 */

/** Everything a hook handler sees about a fonts change. */
export interface FontHookHandle {
	/** What changed: a provider row ("provider.changed") or a family's
	 * synced catalog ("family.synced"). */
	readonly event: "provider.changed" | "family.synced";
	readonly providerId: number;
	/** The provider's adapter kind ("local", "googlefonts", …). */
	readonly kind: string;
	/** Family names touched — populated for "family.synced". */
	readonly families?: readonly string[];
}

export type FontHookHandler = (handle: FontHookHandle) => Effect.Effect<unknown, unknown, unknown>;

/** `invoke` named a hook id nothing registered. */
export class UnknownFontHook extends Data.TaggedError("UnknownFontHook")<{
	readonly hook: string;
}> {}

export class FontHooks extends Context.Service<
	FontHooks,
	{
		/** Register a change handler. Re-registering an id replaces
		 * the previous handler (last wins — deterministic in topo order). */
		readonly register: (id: string, handler: FontHookHandler) => void;
		/** Look up a handler without invoking — tooling/introspection. */
		readonly get: (id: string) => FontHookHandler | undefined;
		/** Registered ids — the service broadcasts each event to all of
		 * them (see module doc). */
		readonly ids: () => readonly string[];
		/** Invoke the handler for `id`; fails `UnknownFontHook` when
		 * absent. Handler errors propagate to the caller — the Fonts
		 * service isolates them per hook (log + swallow).
		 *
		 * R is erased to `never`: handlers are registered at layer-build
		 * time and their requirements resolve against the ONE composed
		 * plugin runtime — the registry cannot name them statically
		 * (same type-erasure contract as `Layer.Any` plugin services).
		 * A handler requiring a service absent from the runtime dies as
		 * a defect, exactly like an unsatisfied layer requirement. */
		readonly invoke: (id: string, handle: FontHookHandle) => Effect.Effect<unknown, unknown, never>;
	}
>()("@ktb/fonts/FontHooks") {}

/** The resolved service shape — consumers that take the registry as a
 * parameter use this interface rather than the Context tag. */
export type FontHooksService = FontHooks["Service"];

export const FontHooksLive = Layer.sync(FontHooks, () => {
	const handlers = new Map<string, FontHookHandler>();
	return FontHooks.of({
		register: (id, handler) => {
			handlers.set(id, handler);
		},
		get: (id) => handlers.get(id),
		ids: () => [...handlers.keys()],
		invoke: (id, handle) => {
			const handler = handlers.get(id);
			if (handler === undefined) {
				return Effect.fail(new UnknownFontHook({ hook: id }));
			}
			// R-erasure documented on the service shape above.
			return handler(handle) as Effect.Effect<unknown, unknown, never>;
		},
	});
});
