import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ElementKinds, type ElementKindDescriptor } from "@ktb/platform/element-kinds";

import { BUILDER_BLOCK_KINDS } from "./kinds.tsx";

/**
 * Server-side half of the builder-blocks element kinds (P-108):
 * registers one `ElementKindDescriptor` per kind into the shared
 * `ElementKinds` registry at layer build. The client half —
 * `kind`/`label`/`fields`/`renderer`/`editor` — is the `elementKinds`
 * manifest entry in ./index.ts and ./client.ts; keep the `kind`
 * strings and `label`s in sync across both.
 *
 * Unlike `rich-text` (whose refs point at stored documents), builder
 * blocks are self-contained: there is no server state to resolve, so
 * `resolve` is the identity function — the stored `ref` IS the props
 * payload the kind's `fields` schema describes, passed through
 * unchanged as the renderer's `value`. `hooks` is omitted: blocks own
 * no referencers.
 */
export const BUILDER_BLOCKS_ELEMENT_KINDS_LIVE = Layer.effectDiscard(
	Effect.gen(function* () {
		const kinds = yield* Effect.serviceOption(ElementKinds);
		if (Option.isNone(kinds)) return;
		for (const kind of BUILDER_BLOCK_KINDS) {
			const descriptor: ElementKindDescriptor = {
				kind: kind.kind,
				label: kind.label,
				// Self-contained props payload — the ref is the value.
				resolve: (ref) => Effect.succeed(ref),
			};
			yield* kinds.value.register(descriptor);
		}
	}),
);
