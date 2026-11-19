import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";

import { Forbidden } from "@ktb/authz";
import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";

import { assertCollectionDef, DocumentCollections, type DocumentCollection } from "./collection.ts";
import type { Fields } from "./fields.ts";
import { documentCollections, documentRecords } from "./schema.ts";
import { clampLimit, clampOffset, type FindQuery } from "./query.ts";
import {
	DocumentStore,
	type CollectionMigrationReport,
	type DocumentRecord,
	type DocumentStoreError,
	type DocumentWriteOptions,
	type FindResult,
} from "./service.ts";

/**
 * DocumentStoreAdmin — the platform-admin console surface (P-089).
 * Every method re-checks the `PlatformAdmin` env-allowlist gate inside
 * the service (defense in depth — the /platform layout, page guard and
 * server fns gate too), then delegates to `DocumentStore` with
 * `ctx.unscoped` so reads AND writes cross every owner/tenant scope:
 * the console is deployment-global by design. Validation, unique and
 * ref/onDelete semantics are unchanged — they still run inside
 * DocumentStore; only the row fencing is lifted.
 *
 * Writes stamp `owner_id`/`tenant_id` from the ambient context exactly
 * like a normal insert (the admin's principal, personal scope unless a
 * tenant is bound) — unscoped affects VISIBILITY, not attribution.
 */

/** One collection as the console lists it: contributed defs and
 * DB-registered rows merged by name. `fields` carries the decoded
 * field DSL (empty when a stored `schema_json` fails to parse — the
 * row still lists so the corruption is visible). */
export interface AdminCollectionInfo {
	readonly name: string;
	readonly owner: string;
	readonly version: number;
	readonly fields: Fields;
	/** Present in the plugin registry's `document.collection`
	 * contributions (vs. a DB row left behind by an uninstalled def). */
	readonly contributed: boolean;
	/** Has a `document_collections` registry row (records may exist). */
	readonly registered: boolean;
	readonly recordCount: number;
	/** The resolved def declares schema `migrations` (T-130) — stored
	 * documents below `version` can be brought forward by
	 * `migrateCollection` (or lazily on read). Always false for defs
	 * reconstructed from `schema_json` alone (migrations are code and
	 * never persist there). */
	readonly hasMigrations: boolean;
}

/** Options for {@link DocumentStoreAdmin.browseDocuments} — the
 * cross-collection console browser. `limit`/`offset` clamp through
 * the same bounds `find` uses (query.ts). */
export interface BrowseDocumentsOptions {
	readonly collection?: string;
	readonly limit?: number;
	readonly offset?: number;
}

export class DocumentStoreAdmin extends Context.Service<
	DocumentStoreAdmin,
	{
		/** Every known collection — contributed defs plus DB-registered
		 * rows — with per-collection record counts. */
		readonly listCollections: () => Effect.Effect<
			readonly AdminCollectionInfo[],
			Forbidden | DocumentStoreError
		>;
		/** One collection by name (same merged view as listCollections)
		 * — null when the name is unknown to BOTH the contributed
		 * registry and `document_collections`. */
		readonly getCollection: (
			name: string,
		) => Effect.Effect<AdminCollectionInfo | null, Forbidden | DocumentStoreError>;
		/** Paged document listing across ALL scopes of one collection. */
		readonly listDocuments: (
			collection: string,
			query?: FindQuery,
		) => Effect.Effect<FindResult, Forbidden | DocumentStoreError>;
		/** Cross-collection document browser (the /platform/documents
		 * console): SQL-paged rows across every collection, newest
		 * `updated_at` first, optionally narrowed to one collection
		 * name. Returns STORED rows — `data` is the persisted JSON
		 * payload without lazy migration or field re-validation (the
		 * per-collection page is the write surface). An unknown
		 * `collection` filter yields an empty page rather than
		 * UnknownCollection — it is a filter, not a lookup. */
		readonly browseDocuments: (
			options?: BrowseDocumentsOptions,
		) => Effect.Effect<FindResult, Forbidden | DocumentStoreError>;
		/** One document by id across all scopes — null when missing. */
		readonly getDocument: (
			collection: string,
			id: number,
		) => Effect.Effect<DocumentRecord | null, Forbidden | DocumentStoreError>;
		/** Validate + insert a document (all scopes visible to checks).
		 * `options.idempotencyKey` replays a prior keyed insert (T-127). */
		readonly insertDocument: (
			collection: string,
			data: Record<string, unknown>,
			options?: DocumentWriteOptions,
		) => Effect.Effect<DocumentRecord, Forbidden | DocumentStoreError>;
		/** Merge-patch a document across all scopes.
		 * `options.expectedVersion` adds the If-Match guard (T-127). */
		readonly updateDocument: (
			collection: string,
			id: number,
			data: Record<string, unknown>,
			options?: DocumentWriteOptions,
		) => Effect.Effect<DocumentRecord, Forbidden | DocumentStoreError>;
		/** Delete a document across all scopes, applying ref onDelete
		 * policies against every in-scope reference. */
		readonly deleteDocument: (
			collection: string,
			id: number,
		) => Effect.Effect<void, Forbidden | DocumentStoreError>;
		/** Eager schema-migration sweep (T-130): rewrite every stored
		 * document of the collection whose `schema_version` is behind
		 * the current def through its `migrations` chain. Per-document
		 * failures are reported, not thrown. */
		readonly migrateCollection: (
			collection: string,
		) => Effect.Effect<CollectionMigrationReport, Forbidden | DocumentStoreError>;
	}
>()("@ktb/document-store/DocumentStoreAdmin") {}

/** Decode a stored `schema_json` blob into a def; malformed rows
 * yield null (the console lists them with empty fields rather than
 * dying — corruption is data, not a defect, at this surface). */
const defFromSchemaJson = (schemaJson: string): DocumentCollection | null => {
	try {
		return assertCollectionDef(JSON.parse(schemaJson), "document_collections.schema_json");
	} catch {
		return null;
	}
};

type CollectionDbRow = typeof documentCollections.$inferSelect;

/** Decode a stored `data` payload for the browse listing — the
 * service only writes valid JSON objects, but a hand-edited or
 * pre-migration row shouldn't 500 the console (mirrors KvAdmin's
 * decodeValue). */
const parseStoredData = (raw: string): DocumentRecord["data"] => {
	try {
		const value: unknown = JSON.parse(raw);
		return (
			typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}
		) as DocumentRecord["data"];
	} catch {
		return {} as DocumentRecord["data"];
	}
};

export const DocumentStoreAdminLive = Layer.effect(
	DocumentStoreAdmin,
	Effect.gen(function* () {
		const db = yield* Db;
		const collections = yield* DocumentCollections;
		const store = yield* DocumentStore;
		const platformAdmin = yield* PlatformAdmin;

		const requireAdmin = platformAdmin.requireAdmin();
		const UNSCOPED = { unscoped: true } as const;

		const contributedMap = () => new Map(collections.collections.map((d) => [d.name, d] as const));

		const rowFor = (name: string) =>
			Effect.promise(
				() =>
					db
						.select()
						.from(documentCollections)
						.where(eq(documentCollections.name, name))
						.limit(1) as Promise<CollectionDbRow[]>,
			).pipe(Effect.map((rows) => rows[0] ?? null));

		const recordCountFor = (collectionId: number) =>
			Effect.promise(async () => {
				const rows = await db
					.select({ n: count() })
					.from(documentRecords)
					.where(eq(documentRecords.collectionId, collectionId));
				/* v8 ignore next -- count() always yields a row */
				return rows[0]?.n ?? 0;
			});

		/** Console view for a `document_collections` row, merged with the
		 * contributed def when one exists (def wins for fields; the row
		 * wins for owner/version when set). A malformed `schema_json`
		 * decodes to empty fields — the row still lists. */
		const infoFromRow = (row: CollectionDbRow, def: DocumentCollection | undefined) =>
			Effect.gen(function* () {
				const resolved = def ?? defFromSchemaJson(row.schemaJson);
				return {
					name: row.name,
					owner: row.ownerPluginId !== "" ? row.ownerPluginId : (resolved?.owner ?? ""),
					version: row.version,
					fields: resolved?.fields ?? {},
					contributed: def !== undefined,
					registered: true,
					recordCount: yield* recordCountFor(row.id),
					hasMigrations: (resolved?.migrations?.length ?? 0) > 0,
				} satisfies AdminCollectionInfo;
			});

		/** Console view for a contributed def with no registry row —
		 * manifest data only, zero records until first write. */
		const infoFromDef = (def: DocumentCollection): AdminCollectionInfo => ({
			name: def.name,
			owner: def.owner ?? "",
			version: def.version,
			fields: def.fields,
			contributed: true,
			registered: false,
			recordCount: 0,
			hasMigrations: (def.migrations?.length ?? 0) > 0,
		});

		return DocumentStoreAdmin.of({
			listCollections: Effect.fn("DocumentStoreAdmin.listCollections")(function* () {
				yield* requireAdmin;
				const contributed = contributedMap();
				const rows = yield* Effect.promise(() =>
					db.select().from(documentCollections).orderBy(asc(documentCollections.name)),
				);
				const seen = new Set<string>();
				const infos: AdminCollectionInfo[] = [];
				for (const row of rows as CollectionDbRow[]) {
					seen.add(row.name);
					infos.push(yield* infoFromRow(row, contributed.get(row.name)));
				}
				// Contributed-but-unregistered defs list too — the console
				// is where an admin sees a collection that exists only as
				// manifest data (zero records until first write).
				for (const def of contributed.values()) {
					if (seen.has(def.name)) continue;
					infos.push(infoFromDef(def));
				}
				return infos.sort((a, b) => a.name.localeCompare(b.name));
			}),

			getCollection: (name) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					const contributed = contributedMap();
					const def = contributed.get(name);
					const row = yield* rowFor(name);
					if (def === undefined) {
						if (row === null) return null;
						return yield* infoFromRow(row, undefined);
					}
					return row === null ? infoFromDef(def) : yield* infoFromRow(row, def);
				}),

			listDocuments: (collection, query) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					return yield* store.find(collection, query, UNSCOPED);
				}),

			browseDocuments: (options) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					const limit = clampLimit(options?.limit);
					const offset = clampOffset(options?.offset);
					const name = options?.collection;
					const conds: (SQL | undefined)[] = [];
					if (name !== undefined && name !== "") {
						conds.push(eq(documentCollections.name, name));
					}
					const where = and(...conds);
					const [rows, totals] = yield* Effect.all([
						Effect.promise(() =>
							db
								.select({
									id: documentRecords.id,
									collectionId: documentRecords.collectionId,
									collection: documentCollections.name,
									data: documentRecords.data,
									schemaVersion: documentRecords.schemaVersion,
									version: documentRecords.version,
									ownerId: documentRecords.ownerId,
									tenantId: documentRecords.tenantId,
									createdAt: documentRecords.createdAt,
									updatedAt: documentRecords.updatedAt,
								})
								.from(documentRecords)
								.innerJoin(
									documentCollections,
									eq(documentRecords.collectionId, documentCollections.id),
								)
								.where(where)
								.orderBy(desc(documentRecords.updatedAt), desc(documentRecords.id))
								.limit(limit)
								.offset(offset),
						),
						Effect.promise(() =>
							db
								.select({ n: count() })
								.from(documentRecords)
								.innerJoin(
									documentCollections,
									eq(documentRecords.collectionId, documentCollections.id),
								)
								.where(where),
						),
					]);
					const records: DocumentRecord[] = rows.map((row) => ({
						id: row.id,
						collectionId: row.collectionId,
						collection: row.collection,
						data: parseStoredData(row.data),
						schemaVersion: row.schemaVersion,
						version: row.version,
						ownerId: row.ownerId,
						tenantId: row.tenantId,
						createdAt: row.createdAt,
						updatedAt: row.updatedAt,
					}));
					return { rows: records, total: totals[0]?.n ?? 0 };
				}),

			getDocument: (collection, id) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					return yield* store.get(collection, id, UNSCOPED);
				}),

			insertDocument: (collection, data, options) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					return yield* store.insert(collection, data, UNSCOPED, options);
				}),

			updateDocument: (collection, id, data, options) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					return yield* store.update(collection, id, data, UNSCOPED, options);
				}),

			deleteDocument: (collection, id) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					yield* store.delete(collection, id, UNSCOPED);
				}),

			migrateCollection: (collection) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					return yield* store.migrateCollection(collection, UNSCOPED);
				}),
		});
	}),
);
