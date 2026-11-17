import type { Json } from "effect/Schema";

import type { AdminCollectionInfo } from "./admin.ts";
import type { DocumentRecord, FindResult } from "./service.ts";

/**
 * Wire shapes exchanged between the document-store admin server fns /
 * panel loaders and the console views — plain JSON only (Dates become
 * ISO strings; the field DSL rides along as data so the browser can
 * render columns and the generated editor without a second fetch).
 */

/** Serializable collection row for the console. */
export interface CollectionWire {
	readonly name: string;
	readonly owner: string;
	readonly version: number;
	readonly fields: AdminCollectionInfo["fields"];
	readonly contributed: boolean;
	readonly registered: boolean;
	readonly recordCount: number;
	/** Def declares schema migrations (T-130). */
	readonly hasMigrations: boolean;
}

export const toCollectionWire = (info: AdminCollectionInfo): CollectionWire => ({
	name: info.name,
	owner: info.owner,
	version: info.version,
	fields: info.fields,
	contributed: info.contributed,
	registered: info.registered,
	recordCount: info.recordCount,
	hasMigrations: info.hasMigrations,
});

/** Serializable document row — timestamps as ISO strings (Date does
 * not round-trip cleanly through server fns/loaders). */
export interface DocumentWire {
	readonly id: number;
	readonly collection: string;
	/** Stored payload — always JSON-shaped (validate.ts guarantees it);
	 * typed `Json` so server-fn serialization checks accept the wire. */
	readonly data: Record<string, Json>;
	/** Stored `schema_version` — `data` is already migrated to the
	 * current def version on read (T-130); this reports the row's
	 * persisted version so the console can spot unmigrated docs. */
	readonly schemaVersion: number;
	/** Row version for optimistic concurrency (T-127) — the
	 * If-Match token for `expectedVersion` on updates. */
	readonly version: number;
	readonly ownerId: string;
	readonly tenantId: number | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export const toDocumentWire = (record: DocumentRecord): DocumentWire => ({
	id: record.id,
	collection: record.collection,
	data: record.data as Record<string, Json>,
	schemaVersion: record.schemaVersion,
	version: record.version,
	ownerId: record.ownerId,
	tenantId: record.tenantId,
	createdAt: record.createdAt.toISOString(),
	updatedAt: record.updatedAt.toISOString(),
});

export interface DocumentsPageWire {
	readonly rows: readonly DocumentWire[];
	readonly total: number;
}

export const toDocumentsPageWire = (result: FindResult): DocumentsPageWire => ({
	rows: result.rows.map(toDocumentWire),
	total: result.total,
});
