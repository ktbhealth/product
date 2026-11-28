import * as Effect from "effect/Effect";

import { ImageDeleteHooks } from "./delete-hooks.ts";
import { imageElement } from "./kind.tsx";
import { Images } from "./service.ts";

/**
 * Server-side half of the `"image"` element kind (P-111): the
 * registration layer that resolves the kind's services and derives the
 * `ElementKindDescriptor` from the shared declaration in ./kind.tsx —
 * `kind`/`label` come from `imageElement.manifest`, so they cannot
 * drift from the client `elementKinds` manifest (./index.ts and
 * ./client.ts both carry `imageElement.manifest`).
 *
 * Consumes `ElementKinds` optionally (inside `live`): hosts without
 * the registry (tests, non-app compositions) build fine and simply
 * register nothing.
 */

/** The kind id consumers store next to the ref — the manifest's
 * `kind`, re-exported for callers that need the literal. */
export const IMAGE_ELEMENT_KIND = imageElement.manifest.kind;

/**
 * Registration layer — merged into `image.services` via
 * `provideMerge` so `Images` and `ImageDeleteHooks` are visible at
 * build time; the services record is produced here (the only place
 * allowed to import the server graph) and handed to the kind's
 * `server` function.
 */
const imageElementServices = Effect.gen(function* () {
	return {
		images: yield* Images,
		deleteHooks: yield* ImageDeleteHooks,
	};
});

export const ImageElementKindLive = imageElement.live(imageElementServices);
