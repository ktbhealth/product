import * as Effect from "effect/Effect";

import { elementKindsLive } from "@ktb/platform/element-kinds";

import { BUILDER_BLOCK_KIND_DEFS } from "./kinds.tsx";

/**
 * Server-side half of the builder-blocks element kinds (P-108):
 * registers one `ElementKindDescriptor` per kind into the shared
 * `ElementKinds` registry at layer build. The kinds are declared once
 * in ./kinds.tsx via `defineElementKind` — `BUILDER_BLOCK_KIND_DEFS`
 * carries both the client manifest (`BUILDER_BLOCK_KINDS`, mirrored by
 * ./index.ts and ./client.ts) and the server behavior, so `kind`/`label`
 * cannot drift between the two halves.
 *
 * Unlike `rich-text` (whose refs point at stored documents), builder
 * blocks are self-contained: there is no server state to resolve, so
 * `resolve` is the identity function — the stored `ref` IS the props
 * payload the kind's `fields` schema describes, passed through
 * unchanged as the renderer's `value`. `hooks` is omitted: blocks own
 * no referencers. No plugin services are needed, so the services
 * record is empty.
 */
const NO_KIND_SERVICES = Effect.succeed<Record<string, never>>({});

export const BUILDER_BLOCKS_ELEMENT_KINDS_LIVE = elementKindsLive(
	BUILDER_BLOCK_KIND_DEFS,
	NO_KIND_SERVICES,
);
