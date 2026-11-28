import * as Effect from "effect/Effect";

import { RichTextDeleteHooks } from "./delete-hooks.ts";
import { richTextElement } from "./kind.tsx";
import { RichTexts } from "./service.ts";

/**
 * Server-side half of the `"rich-text"` element kind (P-102): the
 * registration layer that resolves the kind's services and derives the
 * `ElementKindDescriptor` from the shared declaration in ./kind.tsx —
 * `kind`/`label` come from `richTextElement.manifest`, so they cannot
 * drift from the client `elementKinds` manifest (./index.ts and
 * ./client.ts both carry `richTextElement.manifest`).
 *
 * Consumes `ElementKinds` optionally (inside `live`): hosts without
 * the registry (tests, non-app compositions) build fine and simply
 * register nothing.
 */

/** The kind id consumers store next to the ref — the manifest's
 * `kind`, re-exported for callers that need the literal. */
export const RICH_TEXT_ELEMENT_KIND = richTextElement.manifest.kind;

/**
 * Registration layer — merged into `rich-text.services` via
 * `provideMerge` so `RichTexts` and `RichTextDeleteHooks` are visible
 * at build time; the services record is produced here (the only place
 * allowed to import the server graph) and handed to the kind's
 * `server` function.
 */
const richTextElementServices = Effect.gen(function* () {
	return {
		richTexts: yield* RichTexts,
		deleteHooks: yield* RichTextDeleteHooks,
	};
});

export const RichTextElementKindLive = richTextElement.live(richTextElementServices);
