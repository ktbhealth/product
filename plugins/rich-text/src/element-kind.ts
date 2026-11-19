import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
	ElementKinds,
	type ElementKindDescriptor,
	type ElementReferencerGroup,
} from "@ktb/platform/element-kinds";

import { RichTextDeleteHooks } from "./delete-hooks.ts";
import { RichTexts } from "./service.ts";

/**
 * Server-side half of the `"rich-text"` element kind (P-102): the
 * descriptor registered into the shared `ElementKinds` registry at
 * layer build. The client half — `kind`/`label`/`renderer`/`editor` —
 * is the `elementKinds` manifest entry in ./index.ts and ./client.ts;
 * keep the `kind` string and `label` in sync across both.
 *
 * `resolve` maps the stored ref (the numeric `rich_text.id`) to the
 * renderable payload — the parsed Plate value, exactly what the
 * manifest `renderer` (`RichTextView`) receives as `value`. `hooks`
 * delegates to `RichTextDeleteHooks`: that registry IS this kind's
 * referencer-hooks implementation — other plugins register their
 * usage/cleanup into it, and the kind surfaces the aggregated result
 * under the generic `ElementKindHooks` contract so consumers never
 * import rich-text internals.
 */

/** The kind id consumers store next to the ref — must match the
 * `elementKinds` manifest entry's `kind` in ./index.ts and
 * ./client.ts. */
export const RICH_TEXT_ELEMENT_KIND = "rich-text";

/** Stored refs are positive integer document ids; anything else
 * resolves to "no content" rather than failing the page. */
const isDocRef = (ref: unknown): ref is number =>
	typeof ref === "number" && Number.isInteger(ref) && ref > 0;

/**
 * Registration layer — merged into `rich-text.services` via
 * `provideMerge` so `RichTexts` and `RichTextDeleteHooks` are visible
 * at build time. Consumes `ElementKinds` optionally: hosts without the
 * registry (tests, non-app compositions) build fine and simply
 * register nothing.
 */
export const RichTextElementKindLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const kinds = yield* Effect.serviceOption(ElementKinds);
		if (Option.isNone(kinds)) return;
		const richTexts = yield* RichTexts;
		const deleteHooks = yield* RichTextDeleteHooks;
		const descriptor: ElementKindDescriptor = {
			kind: RICH_TEXT_ELEMENT_KIND,
			label: "Rich text",
			resolve: (ref) =>
				isDocRef(ref)
					? richTexts.getById(ref).pipe(Effect.map((doc) => doc?.content ?? null))
					: Effect.succeed(null),
			hooks: {
				usage: (ref) =>
					isDocRef(ref)
						? deleteHooks
								.usage(ref)
								.pipe(
									Effect.map((owners): readonly ElementReferencerGroup[] =>
										owners.map((owner) => ({ owner: owner.id, items: owner.items })),
									),
								)
						: Effect.succeed([]),
				cleanup: (ref, actionId) =>
					isDocRef(ref) ? deleteHooks.cleanup(ref, actionId) : Effect.void,
			},
		};
		yield* kinds.value.register(descriptor);
	}),
);
