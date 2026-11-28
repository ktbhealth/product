import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ElementKind } from "@ktb/kernel";

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

/** The server half of an element kind — the `resolve`/`hooks` fields
 * of an {@link ElementKindDescriptor} minus the `kind`/`label`
 * identity, which the factory takes from the manifest so the two
 * sides can never drift. */
export type ElementKindServerParts = Pick<ElementKindDescriptor, "resolve" | "hooks">;

/** One element kind declared once via {@link defineElementKind}:
 * `manifest` is the client-consumed `elementKinds` contribution entry,
 * `live` derives the server registration layer from the same
 * declaration. */
export interface ElementKindDefinition<S> {
	/** The client manifest entry — feed `elementKinds: [def.manifest]`
	 * on BOTH the server index.ts and the client.ts mirror; sharing the
	 * object makes manifest parity structural instead of asserted. */
	readonly manifest: ElementKind;
	/** The server half of the declaration: derives the descriptor's
	 * `resolve`/`hooks` from the plugin's service record. `kind`/`label`
	 * come from `manifest`, so identity can never drift between sides. */
	readonly server: (services: S) => ElementKindServerParts;
	/** Build the registration layer. `services` is an Effect producing
	 * the record `server` derives the descriptor from — the plugin's
	 * own services (yielded via `Effect.gen` in the plugin's server
	 * module) become the layer's requirements, so existing
	 * `provideMerge` wiring is unchanged. Consumes `ElementKinds`
	 * optionally: hosts without the registry build fine and register
	 * nothing. */
	readonly live: <R>(services: Effect.Effect<S, never, R>) => Layer.Layer<never, never, R>;
}

/**
 * Declare an element kind ONCE — manifest (client) and server
 * descriptor (registry) derived from a single spec, replacing the
 * keep-`kind`/`label`-in-sync-by-comment contract between a plugin's
 * `elementKinds` manifest and its `ElementKindDescriptor`.
 *
 * `manifest` is the {@link ElementKind} contribution entry verbatim.
 * `server` is a function from the plugin's service record to the
 * descriptor's `resolve`/`hooks` — kept as a function (not an Effect)
 * so the declaration can live in a CLIENT-SAFE module: the services
 * record is only produced inside `live`'s layer effect, which the
 * plugin's server module supplies. Service shapes cross the boundary
 * as `import type` (erased at build), so the client bundle never sees
 * the server graph.
 *
 * ```ts
 * export const myKind = defineElementKind<MyServices>({
 *   manifest: { kind: "my-kind", label: "My kind", renderer: MyView },
 *   server: ({ myService }) => ({ resolve: (ref) => myService.get(ref) }),
 * });
 * // client + server manifests: elementKinds: [myKind.manifest]
 * // server layer: myKind.live(Effect.gen(function* () {
 * //   return { myService: yield* MyService };
 * // }))
 * ```
 */
export const defineElementKind = <S>(spec: {
	readonly manifest: ElementKind;
	readonly server: (services: S) => ElementKindServerParts;
}): ElementKindDefinition<S> => {
	const definition: ElementKindDefinition<S> = {
		manifest: { ...spec.manifest },
		server: spec.server,
		live: (services) => elementKindsLive([definition], services),
	};
	return definition;
};

/**
 * Registration layer for a set of {@link ElementKindDefinition}s —
 * the multi-kind counterpart of `def.live(services)` (builder-blocks
 * registers nine kinds through ONE layer). Registers every kind into
 * `ElementKinds` in declaration order when the registry is present;
 * builds fine without it. `services` is produced once and shared by
 * every kind's `server`.
 */
export const elementKindsLive = <S, R>(
	kinds: readonly ElementKindDefinition<S>[],
	services: Effect.Effect<S, never, R>,
): Layer.Layer<never, never, R> =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const registry = yield* Effect.serviceOption(ElementKinds);
			if (Option.isNone(registry)) return;
			const svc = yield* services;
			for (const kind of kinds) {
				yield* registry.value.register({
					kind: kind.manifest.kind,
					label: kind.manifest.label,
					...kind.server(svc),
				});
			}
		}),
	);
