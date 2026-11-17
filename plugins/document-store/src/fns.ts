import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { ensureSessionUser, runAs } from "@ktb/server-fns";
import { PlatformAdmin } from "@ktb/platform";

import { DocumentStoreAdmin } from "./admin.ts";
import type { CollectionMigrationReport } from "./service.ts";
import {
	toCollectionWire,
	toDocumentWire,
	toDocumentsPageWire,
	type CollectionWire,
	type DocumentWire,
	type DocumentsPageWire,
} from "./wire.ts";

export type { CollectionWire, DocumentWire, DocumentsPageWire } from "./wire.ts";

// Document-store admin server functions: every fn re-checks the
// PlatformAdmin gate inside runAs (defense in depth — the /platform
// layout, page guard and DocumentStoreAdmin methods gate too). Domain
// failures map to explicit wire results instead of throws so the
// console can render validation issues and "referenced by" details:
// `invalid` carries human-readable issues, `denied` covers
// non-admins/missing rows/unknown collections, `in-use` carries the
// referrers a delete was blocked by. Unexpected errors still
// propagate.

/** Run `eff` as the session user after the PlatformAdmin gate. */
const asAdmin = <A, E>(
	user: { readonly id: string; readonly email?: string },
	eff: Effect.Effect<A, E, unknown>,
): Promise<A> =>
	runAs(
		user,
		Effect.gen(function* () {
			const platformAdmin = yield* PlatformAdmin;
			yield* platformAdmin.requireAdmin();
			return yield* eff;
		}),
	);

const ListInput = Schema.Struct({
	collection: Schema.String,
	limit: Schema.optionalKey(Schema.Number),
	offset: Schema.optionalKey(Schema.Number),
});
const DocumentIdInput = Schema.Struct({ collection: Schema.String, id: Schema.Number });
const CreateInput = Schema.Struct({
	collection: Schema.String,
	data: Schema.Unknown,
	/** Optional idempotent-insert key (T-127) — a retry replays the
	 * stored record instead of duplicating. */
	idempotencyKey: Schema.optionalKey(Schema.String),
});
const UpdateInput = Schema.Struct({
	collection: Schema.String,
	id: Schema.Number,
	data: Schema.Unknown,
	/** Optional If-Match guard (T-127): the patch lands only when the
	 * stored row `version` equals this — mismatch fails the save. */
	expectedVersion: Schema.optionalKey(Schema.Number),
});
const MigrateInput = Schema.Struct({ collection: Schema.String });

const decodeList = Schema.decodeUnknownSync(ListInput);
const decodeDocumentId = Schema.decodeUnknownSync(DocumentIdInput);
const decodeCreate = Schema.decodeUnknownSync(CreateInput);
const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);
const decodeMigrate = Schema.decodeUnknownSync(MigrateInput);

/** `data` arrives as untyped JSON — the store re-validates it against
 * the collection's field DSL; a non-object payload fails there as a
 * DocumentValidationError rather than here. */
const asData = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const HANDLED_TAGS = [
	"Forbidden",
	"UnknownCollection",
	"RecordNotFound",
	"InvalidDocumentQuery",
] as const;

const tagOf = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "_tag" in error
		? String((error as { _tag?: unknown })._tag)
		: undefined;

const isHandled = (error: unknown): boolean => {
	const tag = tagOf(error);
	return tag !== undefined && (HANDLED_TAGS as readonly string[]).includes(tag);
};

/** Validation-class failures → human-readable issues; `null` for
 * anything else (the caller rethrows). Tag-based (not instanceof) so
 * plain-object failures map the same way. */
const issuesOf = (error: unknown): readonly string[] | null => {
	const tag = tagOf(error);
	const e = error as {
		issues?: unknown;
		field?: unknown;
		value?: unknown;
		targetCollection?: unknown;
		targetId?: unknown;
		bytes?: unknown;
	};
	if (tag === "DocumentValidationError") {
		return Array.isArray(e.issues)
			? e.issues.map(String)
			: /* v8 ignore next -- store validation errors always carry issues */ ["invalid document"];
	}
	if (tag === "DuplicateFieldValue") {
		return [`${String(e.field)}: duplicate value ${JSON.stringify(e.value)}`];
	}
	if (tag === "BrokenReference") {
		return [
			`${String(e.field)}: unknown ${String(e.targetCollection)} record #${String(e.targetId)}`,
		];
	}
	if (tag === "DocumentTooLarge") {
		return [`document too large: ${String(e.bytes)} bytes serialized`];
	}
	return null;
};

export type SaveDocumentResult =
	| { readonly status: "saved"; readonly record: DocumentWire }
	| { readonly status: "invalid"; readonly issues: readonly string[] }
	| { readonly status: "denied" };

const saveResult = (error: unknown): SaveDocumentResult => {
	if (isHandled(error)) return { status: "denied" };
	const issues = issuesOf(error);
	if (issues === null) throw error;
	return { status: "invalid", issues };
};

/** Every collection for the console index page — `null` for
 * non-admins (same collapse contract as the page fns). */
export const listCollectionsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly CollectionWire[] | null> => {
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* DocumentStoreAdmin;
				return (yield* admin.listCollections()).map(toCollectionWire);
			}),
		).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "_tag" in error) {
				if (String((error as { _tag?: unknown })._tag) === "Forbidden") return null;
			}
			throw error;
		});
	},
);

/** One page of documents for a collection — `null` for non-admins,
 * unknown collections and invalid queries. */
export const documentsFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeList(input))
	.handler(async ({ data }): Promise<DocumentsPageWire | null> => {
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* DocumentStoreAdmin;
				const result = yield* admin.listDocuments(data.collection, {
					...(data.limit === undefined ? {} : { limit: data.limit }),
					...(data.offset === undefined ? {} : { offset: data.offset }),
				});
				return toDocumentsPageWire(result);
			}),
		).catch((error: unknown) => {
			if (isHandled(error)) return null;
			throw error;
		});
	});

/** Insert a document; `denied` for non-admins/unknown collections,
 * `invalid` with issues for validation failures. */
export const createDocumentFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(async ({ data }): Promise<SaveDocumentResult> => {
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* DocumentStoreAdmin;
				const record = yield* admin.insertDocument(data.collection, asData(data.data), {
					...(data.idempotencyKey === undefined ? {} : { idempotencyKey: data.idempotencyKey }),
				});
				return { status: "saved" as const, record: toDocumentWire(record) };
			}),
		).catch(saveResult);
	});

/** Merge-patch a document by id; same result contract as create. */
export const updateDocumentFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(async ({ data }): Promise<SaveDocumentResult> => {
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* DocumentStoreAdmin;
				const record = yield* admin.updateDocument(data.collection, data.id, asData(data.data), {
					...(data.expectedVersion === undefined ? {} : { expectedVersion: data.expectedVersion }),
				});
				return { status: "saved" as const, record: toDocumentWire(record) };
			}),
		).catch(saveResult);
	});

export type DeleteDocumentResult =
	| { readonly status: "deleted" }
	| { readonly status: "in-use"; readonly referencedBy: readonly string[] }
	| { readonly status: "denied" };

/** Delete a document by id; `in-use` carries the `collection.field`
 * referrers that blocked the delete (restrict policy). */
export const deleteDocumentFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeDocumentId(input))
	.handler(async ({ data }): Promise<DeleteDocumentResult> => {
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* DocumentStoreAdmin;
				yield* admin.deleteDocument(data.collection, data.id);
				return { status: "deleted" as const };
			}),
		).catch((error: unknown): DeleteDocumentResult => {
			if (isHandled(error)) return { status: "denied" };
			if (tagOf(error) === "DocumentInUse") {
				const referencedBy = (error as { referencedBy?: unknown }).referencedBy;
				return {
					status: "in-use",
					referencedBy: Array.isArray(referencedBy)
						? referencedBy.map(String)
						: /* v8 ignore next -- DocumentInUse always carries referencedBy */ [],
				};
			}
			throw error;
		});
	});

export type MigrateCollectionResult =
	| { readonly status: "migrated"; readonly report: CollectionMigrationReport }
	| { readonly status: "denied" };

/** Eager schema-migration sweep (T-130): rewrite every stored document
 * of the collection whose `schema_version` is behind the current def.
 * Per-document failures come back inside `report.failed` — the call
 * itself only fails `denied` for non-admins/unknown collections. */
export const migrateCollectionFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeMigrate(input))
	.handler(async ({ data }): Promise<MigrateCollectionResult> => {
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const admin = yield* DocumentStoreAdmin;
				const report = yield* admin.migrateCollection(data.collection);
				return { status: "migrated" as const, report };
			}),
		).catch((error: unknown): MigrateCollectionResult => {
			if (isHandled(error)) return { status: "denied" };
			throw error;
		});
	});
