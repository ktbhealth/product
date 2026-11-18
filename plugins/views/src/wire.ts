import type { Json } from "effect/Schema";

import type { DocumentRecord } from "@ktb/document-store";

import type { ViewDef } from "./definition.ts";

/**
 * Wire shapes exchanged between the views server fns / page loader and
 * the view components — plain JSON only (Dates become ISO strings).
 * The resolved {@link ViewDef} rides inside every payload as the
 * server-validated copy; the page component re-resolves the def
 * against `ctx.plugins` (enabled-filtered client registry — see
 * ViewPage) so contributor enablement gates rendering client-side.
 */

/** Serializable document row — same contract as document-store's
 * DocumentWire (timestamps as ISO strings). */
export interface ViewRecordWire {
	readonly id: number;
	readonly collection: string;
	/** Stored payload — always JSON-shaped; typed `Json` so server-fn
	 * serialization checks accept the wire. */
	readonly data: Record<string, Json>;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export const toViewRecordWire = (record: DocumentRecord): ViewRecordWire => ({
	id: record.id,
	collection: record.collection,
	data: record.data as Record<string, Json>,
	createdAt: record.createdAt.toISOString(),
	updatedAt: record.updatedAt.toISOString(),
});

/**
 * Resolved `ref` labels: `"<refCollection>:<id>"` → display text.
 * Only targets on the visible page are resolved (bounded — see
 * REF_LOOKUP_CAP in service.ts); missing targets simply have no entry
 * and cells fall back to `#<id>`.
 */
export type ViewRefLabels = Readonly<Record<string, string>>;

/** Shared wire fields: the mount path (for links/back navigation)
 * and the resolved def. */
interface ViewWireBase {
	/** Mount path without doc id — `/v/<key>` — used for back links
	 * and filter/pagination refetches. */
	readonly path: string;
	readonly def: ViewDef;
}

/** List payload (table/cards kinds, and the detail kind's index). */
export interface ViewListWire extends ViewWireBase {
	readonly mode: "list";
	readonly rows: readonly ViewRecordWire[];
	readonly total: number;
	readonly pageSize: number;
	readonly offset: number;
	readonly refs: ViewRefLabels;
}

/** Detail payload — `record` is null when the id is valid but not
 * visible/found (the component renders the not-found state rather
 * than hard-404ing the whole view). */
export interface ViewDetailWire extends ViewWireBase {
	readonly mode: "detail";
	readonly record: ViewRecordWire | null;
	readonly refs: ViewRefLabels;
}

export type ViewPageWire = ViewListWire | ViewDetailWire;
