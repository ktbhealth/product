import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

import { Event } from "@effect-server-utils/cqrs";

/**
 * Document-store write events — published on the app-wide `EventBus`
 * after every successful `insert`/`update`/`delete` (see service.ts).
 * Consumers (the `@ktb/triggers` engine is the first) subscribe via
 * `EventBus.stream`/`subscribeAfterCommit`; the bus needs no
 * enumeration — events are plain data routed by `_tag`.
 *
 * `depth` is the cascade counter for declarative write→write
 * reactions: external writes publish `0`; a consumer that writes back
 * into the store inside `Effect.provideService(DocumentWriteDepth, n)`
 * publishes `n`. The triggers engine refuses to fire past its cap, so
 * collection-write actions cannot loop forever.
 */

/** Write-op vocabulary — mirrors the public DocumentStore methods. */
export const DOCUMENT_WRITE_OPS = ["insert", "update", "remove"] as const;
export type DocumentWriteOp = (typeof DOCUMENT_WRITE_OPS)[number];

/**
 * Cascade-depth reference read by DocumentStoreLive when stamping
 * {@link DocumentRecordWritten}. Default `0` — ordinary request/system
 * writes are depth 0. Reaction engines bump it around their own store
 * calls (`Effect.provideService(DocumentWriteDepth, depth + 1)`); a
 * `Context.Reference` (not a service) so it needs no layer and stays
 * invisible to callers that never opt in.
 */
export const DocumentWriteDepth = Context.Reference<number>(
	"@ktb/document-store/DocumentWriteDepth",
	{ defaultValue: () => 0 },
);

/**
 * One committed document-store write. `data` is the record's validated
 * `data` payload for insert/update and the last-known payload for
 * remove; `ownerId`/`tenantId` are the row's stored attribution.
 * `depth` see module doc — 0 for writes that did not originate inside
 * a bounded reaction.
 */
export const DocumentRecordWritten = Event.make("document-store.record-written", {
	collection: Schema.String,
	id: Schema.Number,
	op: Schema.Literals(DOCUMENT_WRITE_OPS),
	data: Schema.Record(Schema.String, Schema.Json),
	ownerId: Schema.String,
	tenantId: Schema.NullOr(Schema.Number),
	depth: Schema.Number,
});

/** Decoded payload type — what subscribers receive. */
export type DocumentRecordWrittenEvent = Event.Type<typeof DocumentRecordWritten>;

/** The bus tag subscribers filter on (`EventBus.stream([tag])`). */
export const DOCUMENT_RECORD_WRITTEN_TAG = DocumentRecordWritten.tag;
