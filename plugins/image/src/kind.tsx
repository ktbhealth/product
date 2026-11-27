import { ImageIcon } from "lucide-react";
import * as Effect from "effect/Effect";

import { defineElementKind } from "@ktb/platform/element-kinds";

import type { ImageDeleteHooksShape } from "./delete-hooks.ts";
import type { ImagesShape } from "./service.ts";
import { asImageElementValue } from "./value.ts";
import { ImageElementEditor } from "./views/ImageElementEditor.tsx";
import { ImageView } from "./views/ImageView.tsx";

/**
 * The `"image"` element kind (P-111), declared ONCE via
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
 * Stored refs are the kind's value object — `{ imageId, alt?, fit? }`
 * as the editor emits it (a bare positive integer is tolerated as
 * `{ imageId }` for hand-written content). `resolve` maps the ref to
 * the renderable payload `ImageView` receives: the public serve URL
 * plus the row's intrinsic metadata and the ref's own alt/fit
 * overrides. `hooks` delegates to `ImageDeleteHooks`: that registry IS
 * this kind's referencer-hooks implementation — other plugins register
 * their usage/cleanup into it, and the kind surfaces the aggregated
 * result under the generic `ElementKindHooks` contract so consumers
 * never import image internals.
 */

/** The services the kind's server behavior resolves through — the
 * record `imageElement.live` produces at layer build. */
export interface ImageElementServices {
	readonly images: ImagesShape;
	readonly deleteHooks: ImageDeleteHooksShape;
}

export const imageElement = defineElementKind<ImageElementServices>({
	manifest: {
		kind: "image",
		label: "Image",
		icon: ImageIcon,
		renderer: ImageView,
		editor: ImageElementEditor,
	},
	server: ({ images, deleteHooks }) => ({
		resolve: (ref) => {
			const value = asImageElementValue(ref);
			if (value === null) return Effect.succeed(null);
			return images.getById(value.imageId).pipe(
				Effect.map((row) =>
					row === null
						? null
						: {
								src: `/api/images/${row.id}`,
								// The ref's alt override wins over the
								// library metadata — authors tailor alt
								// per placement.
								alt: value.alt ?? row.alt,
								title: row.title,
								width: row.width,
								height: row.height,
								mime: row.mime,
								fit: value.fit ?? null,
							},
				),
			);
		},
		hooks: {
			usage: (ref) => {
				const value = asImageElementValue(ref);
				return value === null
					? Effect.succeed([])
					: deleteHooks
							.usage(value.imageId)
							.pipe(
								Effect.map((owners) =>
									owners.map((owner) => ({ owner: owner.id, items: owner.items })),
								),
							);
			},
			cleanup: (ref, actionId) => {
				const value = asImageElementValue(ref);
				return value === null ? Effect.void : deleteHooks.cleanup(value.imageId, actionId);
			},
		},
	}),
});
