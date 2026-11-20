import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Template-kind registry (P-107): the plugin-contributed half of the
 * templates capability. A plugin that owns a templatable content kind
 * (layouts today; pages once builderJson lands) registers ONE
 * `TemplateKind` descriptor at layer build — next to its own service
 * layer — via `Effect.serviceOption(TemplateKinds)`, the same pattern
 * `ElementKinds`/`RichTextDeleteHooks` established:
 *
 *   const MyKindLive = Layer.effectDiscard(
 *   	Effect.gen(function* () {
 *   		const kinds = yield* Effect.serviceOption(TemplateKinds);
 *   		if (Option.isNone(kinds)) return; // registry absent
 *   		yield* kinds.value.register({
 *   			kind: "my-kind",
 *   			label: "My kind",
 *   			serialize: (source) => …,
 *   			deserialize: (payload) => …,
 *   			validate: (payload) => …,
 *   		});
 *   	}),
 *   );
 *
 * The registry is provided by `templates.services`
 * (`TemplatesLive.pipe(Layer.provideMerge(TemplateKindsLive))`), so
 * kind owners order AFTER it through `optionalDeps` on
 * `templates.services` and consume it optionally — a host without the
 * templates plugin simply sees no kinds and the owner registers
 * nothing (the `serviceOption` degradation contract). `kind` strings
 * are the global namespace: registering the same `kind` twice is a
 * packaging bug and dies (same fail-loud contract as `ElementKinds`).
 *
 * The payload contract is deliberately opaque to the templates plugin:
 * `serialize` turns the kind's source object (whatever the owning
 * surface hands over — e.g. a layout doc) into a JSON-safe payload,
 * `deserialize` inverts it for `Templates.instantiate`, and
 * `validate` reports issues (empty = storable). A template is a
 * SNAPSHOT, not a live reference (P-107): instantiation goes through
 * the owning plugin's own create path, so deleting a source row never
 * breaks a stored template and vice versa — no delete hooks involved.
 */

/** One registered template kind. All callbacks capture the owner's
 * services at registration, so their Effect requirements stay
 * `never`-compatible (same erasure plugin service layers rely on);
 * failures surface to callers as defects/typed errors the Templates
 * service maps onto `InvalidTemplatePayload`. */
export interface TemplateKind {
	/** Stable kind id stored on `templates.kind` (e.g. `"layout"`). */
	readonly kind: string;
	/** Admin-facing display label (console grouping, pickers). */
	readonly label: string;
	/** Turn a kind-specific `source` object into the JSON-safe payload
	 * stored on the row. Runs on `Templates.save` when the caller
	 * supplies `source` instead of a ready `payload`. */
	readonly serialize: (source: unknown) => Effect.Effect<unknown, unknown>;
	/** Inverse of `serialize`: stored payload back into the source
	 * form `Templates.instantiate` hands to the caller. */
	readonly deserialize: (payload: unknown) => Effect.Effect<unknown, unknown>;
	/** Payload conformance check — returns issue strings; an empty
	 * list means the payload is storable. Runs on every write path
	 * (`save` source/payload, `adminUpdate` payload). */
	readonly validate: (payload: unknown) => Effect.Effect<readonly string[], unknown>;
	/** Optional short human-readable summary of a payload for admin
	 * pickers/previews; `null` when the kind has nothing to say. */
	readonly preview?: (payload: unknown) => Effect.Effect<string | null, unknown>;
}

export interface TemplateKindsShape {
	/** Register a kind. `kind` is the global namespace — registering
	 * the same `kind` twice is a packaging bug and dies. */
	readonly register: (kind: TemplateKind) => Effect.Effect<void>;
	/** The registered kind, or undefined when `kind` is unknown. */
	readonly get: (kind: string) => TemplateKind | undefined;
	/** Every registered kind, in registration order. */
	readonly list: () => readonly TemplateKind[];
}

/**
 * Shared template-kind registry, provided by `templates.services` and
 * consumed via `Effect.serviceOption` so kind owners keep building
 * when the service is absent.
 */
export class TemplateKinds extends Context.Service<TemplateKinds, TemplateKindsShape>()(
	"@ktb/templates/TemplateKinds",
) {}

/** Build a standalone registry value — tests and non-app compositions. */
export const makeTemplateKinds = (): TemplateKindsShape => {
	const kinds = new Map<string, TemplateKind>();
	return {
		register: (kind) =>
			Effect.suspend(() => {
				if (kinds.has(kind.kind)) {
					return Effect.die(new Error(`duplicate template kind "${kind.kind}"`));
				}
				kinds.set(kind.kind, kind);
				return Effect.void;
			}),
		get: (kind) => kinds.get(kind),
		list: () => [...kinds.values()],
	};
};

/** Registry layer merged into `templates.services` — the single
 * instance `Templates` resolves kinds through and kind owners register
 * into. */
export const TemplateKindsLive = Layer.sync(TemplateKinds, makeTemplateKinds);
