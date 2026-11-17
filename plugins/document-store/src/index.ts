import { DatabaseIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import { rbacServicesPlugin } from "@ktb/rbac-plugin";
import * as Effect from "effect/Effect";

import { DocumentStoreAdmin, DocumentStoreAdminLive, type AdminCollectionInfo } from "./admin.ts";
import {
	collectDocumentCollections,
	defineCollection,
	documentCollectionContribution,
	DOCUMENT_COLLECTION_KIND,
	DocumentCollections,
	makeDocumentCollections,
	toDocumentCollection,
	assertCollectionDef,
	type CollectionFieldPermissions,
	type CollectionIndex,
	type CollectionMigration,
	type CollectionPermissionSpec,
	type CollectionPermissions,
	type DocumentCollection,
} from "./collection.ts";
import {
	f,
	type FieldDescriptor,
	type FieldKind,
	type Fields,
	type InferField,
	type InferFields,
	type InferInsert,
	type InferRecord,
} from "./fields.ts";
import {
	clampLimit,
	clampOffset,
	compileFilter,
	compareData,
	FIND_LIMIT_MAX,
	FIND_SCAN_MAX_ROWS,
	getPath as queryGetPath,
	jsonEqual,
	LOGICAL_KEYS,
	MAX_FILTER_DEPTH,
	MAX_FILTER_NODES,
	matchFilter,
	normalizeSort,
	QUERY_OPERATORS,
	REGEX_MAX_PATTERN_LENGTH,
	validateFilter,
	validateSort,
	type DocumentFilter,
	type FieldCondition,
	type FindQuery,
	type QueryOperator,
	type SortTerm,
} from "./query.ts";
import {
	documentCollections,
	documentRecords,
	type DocumentCollectionInsert,
	type DocumentCollectionRow,
	type DocumentRecordInsert,
	type DocumentRecordRow,
} from "./schema.ts";
import {
	BrokenReference,
	COLLECTION_CACHE_TTL_MS,
	DocumentIdempotencyConflict,
	DocumentInUse,
	DocumentMigrationError,
	DocumentStore,
	DocumentStoreLive,
	DocumentTooLarge,
	DocumentValidationError,
	DocumentVersionConflict,
	DuplicateFieldValue,
	InvalidDocumentQuery,
	MAX_COLLECTION_CACHE_ENTRIES,
	MAX_DOCUMENT_BYTES,
	RecordIdConflict,
	RecordNotFound,
	UnknownCollection,
	DOCUMENT_STORE_TEST_DDL,
	type CollectionMigrationReport,
	type CollectionRef,
	type DocumentBatchOp,
	type DocumentBatchResult,
	type DocumentRecord,
	type DocumentStoreContext,
	type DocumentStoreError,
	type DocumentStoreShape,
	type DocumentWriteOptions,
	type FindResult,
} from "./service.ts";
import { isJson, validateDocumentData } from "./validate.ts";
import { DOCUMENTS_PAGE_SIZE } from "./views/field-utils.ts";
import {
	toCollectionWire,
	toDocumentsPageWire,
	type CollectionWire,
	type DocumentsPageWire,
} from "./wire.ts";
import {
	collectionNameFromPath,
	DocumentStoreCollectionPage,
	DocumentStoreCollectionsPage,
} from "./platform-page.tsx";

export {
	// admin console surface
	DocumentStoreAdmin,
	DocumentStoreAdminLive,
	type AdminCollectionInfo,
	// collection declarations (data on the generic contributions channel)
	assertCollectionDef,
	collectDocumentCollections,
	defineCollection,
	documentCollectionContribution,
	DOCUMENT_COLLECTION_KIND,
	DocumentCollections,
	makeDocumentCollections,
	toDocumentCollection,
	type CollectionFieldPermissions,
	type CollectionIndex,
	type CollectionMigration,
	type CollectionPermissionSpec,
	type CollectionPermissions,
	type DocumentCollection,
	// field DSL + inference
	f,
	type FieldDescriptor,
	type FieldKind,
	type Fields,
	type InferField,
	type InferFields,
	type InferInsert,
	type InferRecord,
	// query engine
	clampLimit,
	clampOffset,
	compileFilter,
	compareData,
	FIND_LIMIT_MAX,
	FIND_SCAN_MAX_ROWS,
	jsonEqual,
	LOGICAL_KEYS,
	MAX_FILTER_DEPTH,
	MAX_FILTER_NODES,
	matchFilter,
	normalizeSort,
	QUERY_OPERATORS,
	queryGetPath,
	REGEX_MAX_PATTERN_LENGTH,
	validateFilter,
	validateSort,
	type DocumentFilter,
	type FieldCondition,
	type FindQuery,
	type QueryOperator,
	type SortTerm,
	// drizzle tables
	documentCollections,
	documentRecords,
	type DocumentCollectionInsert,
	type DocumentCollectionRow,
	type DocumentRecordInsert,
	type DocumentRecordRow,
	// service + errors
	BrokenReference,
	COLLECTION_CACHE_TTL_MS,
	DocumentIdempotencyConflict,
	DocumentInUse,
	DocumentMigrationError,
	DocumentStore,
	DocumentStoreLive,
	DocumentTooLarge,
	DocumentValidationError,
	DocumentVersionConflict,
	DuplicateFieldValue,
	InvalidDocumentQuery,
	MAX_COLLECTION_CACHE_ENTRIES,
	MAX_DOCUMENT_BYTES,
	RecordIdConflict,
	RecordNotFound,
	UnknownCollection,
	DOCUMENT_STORE_TEST_DDL,
	type CollectionMigrationReport,
	type CollectionRef,
	type DocumentBatchOp,
	type DocumentBatchResult,
	type DocumentRecord,
	type DocumentStoreContext,
	type DocumentStoreError,
	type DocumentStoreShape,
	type DocumentWriteOptions,
	type FindResult,
	// validation helpers
	isJson,
	validateDocumentData,
};

/** Document-store tables citizen (P-089). */
export const documentStoreTablesPlugin = definePlugin({
	id: "document-store.tables",
	meta: { keywords: ["documents", "tables"] },
	tables: {
		documentCollections,
		documentRecords,
	},
});

/** Document-store service citizen (P-089): the runtime-validated
 * store. Requires `Db` + `DocumentCollections` — the latter is
 * provided by the composition root (@ktb/app-host builds it from the
 * ordered plugin registry, mirroring makePluginStatesLive). */
export const documentStoreServicesPlugin = definePlugin({
	id: "document-store.services",
	meta: { keywords: ["documents", "services"] },
	// Ordering hint only: when the rbac citizen is installed its
	// Permissions service composes BEFORE this layer so collections
	// declaring `permissions` resolve grants. Absence is legal —
	// permissionless collections are unaffected and permissioned ones
	// fail closed (see service.ts specAllowed).
	optionalDeps: [rbacServicesPlugin.id],
	services: DocumentStoreLive,
});

/** Platform-admin console surface (P-089): DocumentStoreAdmin gates
 * every method on PlatformAdmin and reads/writes through DocumentStore
 * with `ctx.unscoped` — the console is deployment-global. The dep edge
 * on document-store.services keeps the store layer ordered first. */
export const documentStoreAdminPlugin = definePlugin({
	id: "document-store.admin",
	meta: { keywords: ["documents", "admin"] },
	requiredDeps: [platformAdminPlugin.id, documentStoreServicesPlugin.id],
	services: DocumentStoreAdminLive,
});

/** Console sidebar entry (System group) for /platform/document-store —
 * same chrome contract as pages.chrome. */
export const documentStoreChromePlugin = definePlugin({
	id: "document-store.chrome",
	meta: { keywords: ["documents", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "document-store.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/document-store",
					label: "Document store",
					icon: DatabaseIcon,
					group: "System",
				},
			},
		},
	],
});

/** /platform admin gate shared by both console pages — same contract
 * as pages.panel: hard-404 non-admins via `guard`, and every
 * DocumentStoreAdmin method re-checks inside the service/fns. */
const adminGuard = () =>
	Effect.gen(function* () {
		const platformAdmin = yield* PlatformAdmin;
		return yield* platformAdmin.requireAdmin().pipe(
			Effect.as(true),
			Effect.catchTag("Forbidden", () => Effect.succeed(false)),
		);
	});

/** Console pages: the collections index plus a wildcard browser for
 * /platform/document-store/<name> — `panel.pages` paths are exact, but
 * the host dispatcher resolves "/*" wildcards by longest base (same
 * mechanism the custom-pages plugin uses on the app shell), so one
 * descriptor serves every collection. The guard 404s unknown names;
 * the loader feeds the first documents page. */
export const documentStorePanelPlugin = definePlugin({
	id: "document-store.panel",
	meta: { keywords: ["documents", "ui"] },
	requiredDeps: [platformPanelPlugin.id, documentStoreAdminPlugin.id],
	panel: {
		pages: [
			{
				id: "document-store.collections",
				path: "/platform/document-store",
				component: DocumentStoreCollectionsPage,
				guard: (_path) => adminGuard(),
				loader: (_path) =>
					Effect.gen(function* () {
						const admin = yield* DocumentStoreAdmin;
						const infos = yield* admin
							.listCollections()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
						return infos.map(toCollectionWire);
					}),
			},
			{
				id: "document-store.collection",
				path: "/platform/document-store/*",
				component: DocumentStoreCollectionPage,
				guard: (path) =>
					Effect.gen(function* () {
						const name = collectionNameFromPath(path);
						if (name === null) return false;
						if (!(yield* adminGuard())) return false;
						const admin = yield* DocumentStoreAdmin;
						const info = yield* admin
							.getCollection(name)
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
						return info !== null;
					}),
				loader: (path) =>
					Effect.gen(function* () {
						const name = collectionNameFromPath(path);
						if (name === null) return { collection: null, page: null };
						const admin = yield* DocumentStoreAdmin;
						const info = yield* admin
							.getCollection(name)
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
						if (info === null) return { collection: null, page: null };
						const result = yield* admin.listDocuments(name, { limit: DOCUMENTS_PAGE_SIZE }).pipe(
							Effect.catchTags({
								Forbidden: () => Effect.succeed({ rows: [], total: 0 }),
								UnknownCollection: () => Effect.succeed({ rows: [], total: 0 }),
								InvalidDocumentQuery: () => Effect.succeed({ rows: [], total: 0 }),
							}),
						);
						const page: DocumentsPageWire = toDocumentsPageWire(result);
						const collection: CollectionWire = toCollectionWire(info);
						return { collection, page };
					}),
			},
		],
	},
});

/** Single-concern plugins contributed by this module. */
export const plugins: readonly Plugin[] = [
	documentStoreTablesPlugin,
	documentStoreServicesPlugin,
	documentStoreAdminPlugin,
	documentStoreChromePlugin,
	documentStorePanelPlugin,
];

// Compile-time dep registry.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"document-store.tables": true;
		"document-store.services": true;
		"document-store.admin": true;
		"document-store.chrome": true;
		"document-store.panel": true;
	}
}
