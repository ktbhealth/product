import { PenLineIcon } from "lucide-react";
import * as Effect from "effect/Effect";

import { defineElementKind } from "@ktb/platform/element-kinds";

import type { RichTextDeleteHooksShape } from "./delete-hooks.ts";
import type { RichTextsShape } from "./service.ts";
import { RichTextElementEditor } from "./views/RichTextElementEditor.tsx";
import { RichTextView } from "./views/RichTextView.tsx";

/**
 * The `"rich-text"` element kind (P-102), declared ONCE via
 * `defineElementKind` (@ktb/platform): `manifest` feeds the
 * `elementKinds` contribution in BOTH ./index.ts and ./client.ts (the
 * same object, so client/server parity is structural), and `live`
 * (./element-kind.ts) derives the server descriptor registered into
 * the shared `ElementKinds` registry — `kind`/`label` can never drift
 * between the two halves.
 *
 * This module is deliberately CLIENT-SAFE: it is imported by
 * ./client.ts, so it must stay free of the server graph (Db, services,
 * Layers). The service shapes cross the boundary as `import type`
 * (erased at build); the services themselves are only produced inside
 * the registration layer's Effect, which ./element-kind.ts supplies.
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

/** The services the kind's server behavior resolves through — the
 * record `richTextElement.live` produces at layer build. */
export interface RichTextElementServices {
	readonly richTexts: RichTextsShape;
	readonly deleteHooks: RichTextDeleteHooksShape;
}

/** Stored refs are positive integer document ids; anything else
 * resolves to "no content" rather than failing the page. */
const isDocRef = (ref: unknown): ref is number =>
	typeof ref === "number" && Number.isInteger(ref) && ref > 0;

export const richTextElement = defineElementKind<RichTextElementServices>({
	manifest: {
		kind: "rich-text",
		label: "Rich text",
		icon: PenLineIcon,
		renderer: RichTextView,
		editor: RichTextElementEditor,
	},
	server: ({ richTexts, deleteHooks }) => ({
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
								Effect.map((owners) =>
									owners.map((owner) => ({ owner: owner.id, items: owner.items })),
								),
							)
					: Effect.succeed([]),
			cleanup: (ref, actionId) =>
				isDocRef(ref) ? deleteHooks.cleanup(ref, actionId) : Effect.void,
		},
	}),
});
