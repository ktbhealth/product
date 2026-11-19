import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Element-kind registry (P-102 phase 3): managed content generalized
 * into declarative kinds. A plugin that owns a content kind (rich
 * text today; layouts/templates consume it tomorrow) registers ONE
 * `ElementKindDescriptor` at layer build — next to its own service
 * layer — via `Effect.serviceOption(ElementKinds)`, the same pattern
 * `RichTextDeleteHooks` and `DocumentRefTargets` established:
 *
 *   const MyKindLive = Layer.effectDiscard(
 *   	Effect.gen(function* () {
 *   		const kinds = yield* Effect.serviceOption(ElementKinds);
 *   		if (Option.isNone(kinds)) return; // registry absent
 *   		const svc = yield* MyService;
 *   		yield* kinds.value.register({
 *   			kind: "my-kind",
 *   			label: "My kind",
 *   			resolve: (ref) => svc.getById(ref),
 *   		});
 *   	}),
 *   );
 *
 * and merges it into its plugin `services` layer (provideMerge wires
 * the sibling services in). Registration is a composition-time side
 * effect on a shared registry — like `DocumentCollections` it ignores
 * plugin enablement: a disabled kind owner's tables still exist, so
 * stored refs stay resolvable (the same static-composition contract).
 *
 * The registry is provided ONCE by the composition root
 * (@ktb/app-host merges `ElementKindsLive` into `core`) BELOW the
 * plugin layer, so every plugin layer shares one instance and
 * consumers reach it via `Effect.serviceOption` — a host without the
 * registry simply sees no kinds. Consumers NEVER import another
 * plugin's internals: they resolve `{ kind, ref }` pairs through this
 * service and mount the kind's client `renderer`/`editor` from the
 * `elementKinds` manifest contribution (@ktb/kernel).
 */

/** One thing referencing an element — serializable so it can cross
 * the server-fn boundary into a delete-confirmation dialog. `id` is
 * the referencer's own row id (number for SQL tables, string for
 * document-store rows); `path` is an optional link target. */
export interface ElementReferencerItem {
	readonly id: string | number;
	readonly title: string;
	readonly path?: string;
}

/** Referencers grouped by the plugin that owns them — `owner` is the
 * hook/owner id the contributing plugin's `dialogAction` chrome
 * entries declare (same contract as `RichTextUsageOwner`). */
export interface ElementReferencerGroup {
	readonly owner: string;
	readonly items: readonly ElementReferencerItem[];
}

/** A kind's lifecycle hooks — the generic form of the
 * `RichTextDeleteHooks` contract, keyed on the kind's opaque `ref`
 * instead of a rich-text doc id. Both callbacks capture the owner's
 * services at registration, so their Effect requirements stay
 * `never` (same erasure plugin service layers rely on). */
export interface ElementKindHooks {
	/** Referencers of `ref` grouped by owner — empty when unreferenced.
	 * Hook failures propagate: a hidden referencer is worse than a
	 * failed dialog. */
	readonly usage?: (ref: unknown) => Effect.Effect<readonly ElementReferencerGroup[], unknown>;
	/** Run the admin-chosen `actionId` cleanup; MUST succeed silently
	 * for action ids the kind does not own so one dialog choice can
	 * cascade through several hooks. */
	readonly cleanup?: (ref: unknown, actionId: string) => Effect.Effect<void, unknown>;
}

/** Server-side registration for one element kind. `kind` is the stable
 * string consumers store next to the ref (matches the `elementKinds`
 * manifest entry's `kind`); `label` is the display string. `resolve`
 * maps a stored ref to the renderable payload — its return value is
 * EXACTLY what the kind's client `renderer` receives as `value`
 * (`null`/missing when the ref doesn't resolve). `ref` is kind-owned
 * and opaque to the registry: rich-text uses the numeric document id.
 * `hooks` is optional — kinds without referencers omit it. */
export interface ElementKindDescriptor {
	readonly kind: string;
	readonly label: string;
	readonly resolve: (ref: unknown) => Effect.Effect<unknown, unknown>;
	readonly hooks?: ElementKindHooks;
}

export interface ElementKindsShape {
	/** Register a kind descriptor. `kind` is the global namespace —
	 * registering the same `kind` twice is a packaging bug and dies
	 * (same fail-loud contract as `DocumentRefTargets`). */
	readonly register: (descriptor: ElementKindDescriptor) => Effect.Effect<void>;
	/** The registered descriptor, or undefined when `kind` is unknown. */
	readonly get: (kind: string) => ElementKindDescriptor | undefined;
	/** Every registered descriptor, in registration order. */
	readonly list: () => readonly ElementKindDescriptor[];
}

/**
 * Shared element-kind registry, provided once by the composition root
 * (@ktb/app-host merges `ElementKindsLive` into `core`) so every plugin
 * layer — kind owners registering descriptors AND consumers resolving
 * refs — shares ONE instance. Consumed via `Effect.serviceOption` so
 * plugins keep building when the service is absent.
 */
export class ElementKinds extends Context.Service<ElementKinds, ElementKindsShape>()(
	"@ktb/platform/ElementKinds",
) {}

/** Build a standalone registry value — tests and non-app compositions. */
export const makeElementKinds = (): ElementKindsShape => {
	const kinds = new Map<string, ElementKindDescriptor>();
	return {
		register: (descriptor) =>
			Effect.suspend(() => {
				if (kinds.has(descriptor.kind)) {
					return Effect.die(new Error(`duplicate element kind "${descriptor.kind}"`));
				}
				kinds.set(descriptor.kind, descriptor);
				return Effect.void;
			}),
		get: (kind) => kinds.get(kind),
		list: () => [...kinds.values()],
	};
};

/** Shared-registry layer for the composition root's `core`. */
export const ElementKindsLive = Layer.sync(ElementKinds, makeElementKinds);
