import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
	ElementKinds,
	type ElementKindDescriptor,
	type ElementReferencerGroup,
} from "@ktb/platform/element-kinds";

import { ImageDeleteHooks } from "./delete-hooks.ts";
import { Images } from "./service.ts";
import { asImageElementValue } from "./value.ts";

/**
 * Server-side half of the `"image"` element kind (P-111): the
 * descriptor registered into the shared `ElementKinds` registry at
 * layer build. The client half — `kind`/`label`/`renderer`/`editor` —
 * is the `elementKinds` manifest entry in ./index.ts and ./client.ts;
 * keep the `kind` string and `label` in sync across both.
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

/** The kind id consumers store next to the ref — must match the
 * `elementKinds` manifest entry's `kind` in ./index.ts and
 * ./client.ts. */
export const IMAGE_ELEMENT_KIND = "image";

/**
 * Registration layer — merged into `image.services` via
 * `provideMerge` so `Images` and `ImageDeleteHooks` are visible at
 * build time. Consumes `ElementKinds` optionally: hosts without the
 * registry (tests, non-app compositions) build fine and simply
 * register nothing.
 */
export const ImageElementKindLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const kinds = yield* Effect.serviceOption(ElementKinds);
		if (Option.isNone(kinds)) return;
		const images = yield* Images;
		const deleteHooks = yield* ImageDeleteHooks;
		const descriptor: ElementKindDescriptor = {
			kind: IMAGE_ELEMENT_KIND,
			label: "Image",
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
									Effect.map((owners): readonly ElementReferencerGroup[] =>
										owners.map((owner) => ({ owner: owner.id, items: owner.items })),
									),
								);
				},
				cleanup: (ref, actionId) => {
					const value = asImageElementValue(ref);
					return value === null ? Effect.void : deleteHooks.cleanup(value.imageId, actionId);
				},
			},
		};
		yield* kinds.value.register(descriptor);
	}),
);
