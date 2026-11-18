import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, tx, type TxOp } from "@ktb/db";
import {
	documentStoreOpDuration,
	documentStoreOps,
	documentStoreRows,
	recordSafe,
	tagged,
} from "@ktb/observability";
import { Permissions, splitPermission } from "@ktb/rbac";
import { tenantScopeCondition, tenantScopeId, Tenant } from "@ktb/tenant";

import {
	assertCollectionDef,
	DocumentCollections,
	type CollectionPermissionSpec,
	type DocumentCollection,
} from "./collection.ts";
import type { Fields, InferInsert, InferRecord } from "./fields.ts";
import {
	clampLimit,
	clampOffset,
	compileFilter,
	compareData,
	FIND_SCAN_MAX_ROWS,
	matchFilter,
	normalizeSort,
	validateFilter,
	validateSort,
	type FindQuery,
} from "./query.ts";
import {
	documentCollections,
	documentRecords,
	type DocumentCollectionRow,
	type DocumentRecordRow,
} from "./schema.ts";
import { validateDocumentData } from "./validate.ts";

/**
 * DocumentStore (P-089) — runtime-validated document store for
 * plugin-contributed data collections. Collections are declared as
 * data (`defineCollection` + a `document.collection` contribution);
 * records live in `document_records` with the validated payload in a
 * JSON column. Field-level validation (types, required, enum, pattern,
 * defaults, unique) runs here against the field DSL — SQL only fences
 * scope.
 *
 * Tenant/owner fencing reuses the patients pattern: reads AND writes
 * carry `tenantScopeCondition(documentRecords)` (tenant_id NULL or in
 * the caller's accessible set) AND an owner rule — personal rows
 * (`tenant_id IS NULL`) are visible only to their `owner_id`; tenant
 * rows are visible to every member of that tenant. `ctx.ownerId`
 * overrides the bound `Principal` (system flows pass it explicitly);
 * a null principal resolves to `""` — system-owned personal rows are
 * invisible to user callers (fail closed). This is row-level fencing;
 * collections may additionally declare a `permissions` block (T-128)
 * that gates every operation through the rbac `Permissions` service —
 * see {@link CollectionPermissions} in collection.ts. Callers without
 * declared permissions keep the fencing-only contract: plugins still
 * decide WHO may call (PlatformAdmin, audience gates) exactly like
 * every other service.
 *
 * Query evaluation is JS-side over parsed JSON (see query.ts): the v1
 * tradeoff is that `find` scans the collection's in-scope rows. Unique
 * checks and `ref` onDelete policies scan likewise — fine at
 * specialty-pack/intake-form volumes; a hot collection graduates to a
 * dedicated table. SCALE CEILING (T-129, measured by
 * src/benchmark.test.ts on better-sqlite3): `find` scans the whole
 * visible slice in JS — ~17ms at 1k docs, ~35–45ms at the 10k
 * FIND_SCAN_MAX_ROWS ceiling (past that it fails
 * `InvalidDocumentQuery` rather than scanning unboundedly; D1 may be
 * slower). Fine for admin consoles, background jobs and moderate
 * per-request reads; NOT for hot paths over big collections. Beyond
 * ~10k visible docs per collection, declare a typed table instead of
 * growing the document store. Declared `indexes` on a collection def
 * are advisory metadata only (stored in schema_json for tooling) —
 * they do NOT create SQL indexes; filtering stays JS-side by design.
 *
 * WHEN NOT TO USE (see README.md for the full guide): hot list paths,
 * SQL aggregates/joins, DB-level constraints/FKs/cascades, high-write
 * streams, payloads over MAX_DOCUMENT_BYTES, or collections nearing
 * FIND_SCAN_MAX_ROWS. Escape hatch: graduate the collection to a typed
 * drizzle table in the owning plugin's schema.ts (tables ride the
 * manifest `tables` contribution; `bun run gen:db-schema` regenerates
 * packages/db/src/schema.gen.ts) — export, backfill, cut over. Same
 * rule as kv vs documents vs tables: kv = single-key state/TTL,
 * documents = structured queryable collections, tables = hot paths.
 *
 * Concurrency + idempotency (T-127): every record carries a `version`
 * (returned on DocumentRecord) bumped by each committed write;
 * `update(..., { expectedVersion })` is the If-Match guard — a stale
 * expectation fails `DocumentVersionConflict` carrying the actual
 * version (mirrors kv's KvConflictError). `insert(...,
 * { idempotencyKey })` stores a caller key unique per collection —
 * a retry replays the existing record instead of duplicating;
 * keys are COLLECTION-GLOBAL across owner/tenant scopes (callers
 * namespace keys, e.g. prefix the tenant/user id), and a key held by
 * a record outside the caller's visible scope fails
 * `DocumentIdempotencyConflict` rather than leaking it.
 */

export class UnknownCollection extends Data.TaggedError("UnknownCollection")<{
	readonly name: string;
}> {}

export class DocumentValidationError extends Data.TaggedError("DocumentValidationError")<{
	readonly collection: string;
	readonly issues: readonly string[];
}> {}

export class InvalidDocumentQuery extends Data.TaggedError("InvalidDocumentQuery")<{
	readonly collection: string;
	readonly issues: readonly string[];
}> {}

export class RecordNotFound extends Data.TaggedError("RecordNotFound")<{
	readonly collection: string;
	readonly id: number;
}> {}

/** The serialized `data` payload exceeded {@link MAX_DOCUMENT_BYTES}
 * on insert/update — a typed rejection, not a DB error. */
export class DocumentTooLarge extends Data.TaggedError("DocumentTooLarge")<{
	readonly collection: string;
	readonly bytes: number;
}> {}

/** A `unique: true` field already holds the value inside the record's
 * uniqueness bucket (per-owner for personal rows, per-tenant for
 * tenant rows). */
export class DuplicateFieldValue extends Data.TaggedError("DuplicateFieldValue")<{
	readonly collection: string;
	readonly field: string;
	readonly value: unknown;
}> {}

/** A `ref` field on write pointed at a record that does not exist
 * inside the caller's visible scope (or whose target collection is
 * unknown). */
export class BrokenReference extends Data.TaggedError("BrokenReference")<{
	readonly collection: string;
	readonly field: string;
	readonly targetCollection: string;
	readonly targetId: number;
}> {}

/** A `ref` `onDelete: "restrict"` blocked the delete — in-scope records
 * still reference the target. `referencedBy` lists `collection.field`
 * paths for diagnostics. */
export class DocumentInUse extends Data.TaggedError("DocumentInUse")<{
	readonly collection: string;
	readonly id: number;
	readonly referencedBy: readonly string[];
}> {}

/** A batch `insert` op carried an explicit `id` that is already taken
 * (globally — `document_records.id` is the shared primary key). */
export class RecordIdConflict extends Data.TaggedError("RecordIdConflict")<{
	readonly id: number;
}> {}

/** An `update` `expectedVersion` guard missed (T-127): the stored
 * row's `version` differs from the caller's expectation — someone
 * wrote since the caller last read. `actualVersion` carries the
 * current version so the caller can re-read and retry (mirrors kv's
 * KvConflictError). Checked at batch plan time; absent the option,
 * updates stay last-write-wins. */
export class DocumentVersionConflict extends Data.TaggedError("DocumentVersionConflict")<{
	readonly collection: string;
	readonly id: number;
	readonly expectedVersion: number;
	readonly actualVersion: number;
}> {}

/** An `insert` `idempotencyKey` is already held by a record the caller
 * cannot see (T-127). Keys are unique per COLLECTION across every
 * owner/tenant scope — a same-scope hit replays the existing record;
 * a cross-scope hit fails here rather than leaking the stored
 * document. Callers that share key namespaces across scopes should
 * prefix keys (e.g. `${tenantId}:${key}`). Also raised when two ops
 * in ONE batch carry the same key for the same collection — a
 * pending (uncommitted) insert cannot be replayed by id. */
export class DocumentIdempotencyConflict extends Data.TaggedError("DocumentIdempotencyConflict")<{
	readonly collection: string;
	readonly idempotencyKey: string;
}> {}

/** Schema migration (T-130) failed: no migration path covers the
 * document's stored `schema_version`, a `migrate` step threw or
 * returned a non-object, or the migrated document failed validation
 * against the current field DSL. The stored row is left untouched —
 * lazy reads surface this as a typed error; `migrateCollection`
 * collects it per-document instead of failing the sweep. */
export class DocumentMigrationError extends Data.TaggedError("DocumentMigrationError")<{
	readonly collection: string;
	readonly recordId: number | null;
	readonly from: number;
	readonly to: number;
	readonly reason: string;
}> {}

export type DocumentStoreError =
	| UnknownCollection
	| DocumentValidationError
	| InvalidDocumentQuery
	| RecordNotFound
	| DuplicateFieldValue
	| BrokenReference
	| DocumentInUse
	| DocumentTooLarge
	| RecordIdConflict
	| DocumentVersionConflict
	| DocumentIdempotencyConflict
	| DocumentMigrationError
	| Forbidden;

/** Explicit caller context — `ownerId` overrides the bound Principal.
 * Pass `{ ownerId: null }` (or omit in a principal-less system
 * context) for system-owned rows.
 *
 * ⚠ SYSTEM-ONLY escape hatch: `ownerId` bypasses the bound
 * `Principal` and therefore the per-user row fencing entirely — it
 * is an IDOR primitive if it ever reaches wire/user input. Populate
 * it ONLY from trusted server-side system flows (jobs, admin
 * tooling, cross-user maintenance), NEVER from request bodies,
 * query params, or plugin route args derived from caller data.
 * Plugin-facing APIs that need owner-scoped writes should take the
 * principal implicitly (omit `ctx`) instead.
 *
 * `unscoped: true` drops BOTH fences — the tenant scope condition and
 * the owner rule — so every row of the collection is visible and
 * writable regardless of scope. Same trust contract as `ownerId`:
 * system flows only (the platform-admin console is the intended
 * consumer), NEVER wire input. Unique/ref/onDelete semantics are
 * unchanged — they still evaluate the record's own scope bucket. */
export interface DocumentStoreContext {
	readonly ownerId?: string | null;
	readonly unscoped?: boolean;
}

/** A stored record row with `data` parsed and typed by the collection's
 * field map (`InferRecord`). `data` is ALWAYS presented at the current
 * def version — rows stored under an older `schema_version` are
 * migrated in-memory on read when the def declares `migrations`
 * (T-130); `schemaVersion` reports the STORED row version so callers
 * (and the admin console) can see which documents a sweep would
 * still rewrite. */
export interface DocumentRecord<F extends Fields = Fields> {
	readonly id: number;
	readonly collectionId: number;
	readonly collection: string;
	readonly data: InferRecord<F>;
	readonly schemaVersion: number;
	/** Row version for optimistic concurrency (T-127) — pass back as
	 * `expectedVersion` on `update` for If-Match semantics. Bumps on
	 * every committed write; schema-migration sweeps do not bump it. */
	readonly version: number;
	readonly ownerId: string;
	readonly tenantId: number | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface FindResult<F extends Fields = Fields> {
	/** Page of matching records (after sort + limit/offset). */
	readonly rows: readonly DocumentRecord<F>[];
	/** Total matches before pagination. */
	readonly total: number;
}

/** `collection` accepts a name (resolved through the contributed
 * registry, then the DB registry) or the typed `DocumentCollection`
 * def itself — typed defs keep `InferInsert`/`InferRecord` precise. */
export type CollectionRef<F extends Fields = Fields> = string | DocumentCollection<F>;

/** One op inside {@link DocumentStoreShape.batch} (T-126). `insert`
 * accepts an optional explicit `id` — the ONLY way a later op in the
 * same batch can `ref` it (autoincrement ids don't exist until the
 * transaction commits). Ops apply IN ORDER: each op's validation,
 * permission checks, ref and unique checks see the committed state
 * overlaid with the effects of earlier ops in the same batch. */
export type DocumentBatchOp =
	| {
			readonly op: "insert";
			readonly collection: CollectionRef;
			readonly data: Record<string, unknown>;
			readonly id?: number;
			/** Caller-supplied idempotency key (T-127) — same contract as
			 * `DocumentWriteOptions.idempotencyKey`. A key matching an
			 * existing in-scope record replays it (no write lands); a
			 * key held outside the caller's scope or by another pending
			 * insert in the same batch fails
			 * `DocumentIdempotencyConflict`. */
			readonly idempotencyKey?: string;
	  }
	| {
			readonly op: "update";
			readonly collection: CollectionRef;
			readonly id: number;
			readonly data: Record<string, unknown>;
			/** Optimistic-concurrency guard (T-127) — same contract as
			 * `DocumentWriteOptions.expectedVersion`. Compared against
			 * the version the row will have after earlier ops in the
			 * batch (a pending insert reads as version 1). */
			readonly expectedVersion?: number;
	  }
	| {
			readonly op: "delete";
			readonly collection: CollectionRef;
			readonly id: number;
	  };

/** Optional write modifiers for `insert`/`update` (T-127). Each field
 * applies to one direction only — `idempotencyKey` on inserts,
 * `expectedVersion` on updates; passing the other is ignored. */
export interface DocumentWriteOptions {
	/** Idempotent-insert key (insert only): 1–255 chars, unique per
	 * collection across ALL scopes (see DocumentIdempotencyConflict).
	 * A retry with a key that already produced a visible record
	 * returns THAT record — payload and explicit `id` are ignored on
	 * replay. Omit for ordinary inserts (NULL keys never collide). */
	readonly idempotencyKey?: string;
	/** If-Match guard (update only): the write lands only when the
	 * stored row's `version` equals this positive integer — mismatch
	 * fails `DocumentVersionConflict` with the actual version. Absent
	 * = last-write-wins (pre-T-127 behavior). */
	readonly expectedVersion?: number;
}

/** Per-op result of {@link DocumentStoreShape.batch}, aligned by
 * position with the input ops. `record` is null for `delete` ops and
 * for insert/update writes a same-batch `delete`'s cascade removed
 * before they ever landed. */
export type DocumentBatchResult =
	| { readonly op: "insert" | "update"; readonly record: DocumentRecord | null }
	| { readonly op: "delete" };

/** Outcome of {@link DocumentStoreShape.migrateCollection} (T-130) —
 * the eager sweep counterpart of lazy read-time migration. Per-document
 * failures are collected, never fatal: a bad row stays untouched and
 * is retried on the next sweep (or surfaces as a typed error on read). */
export interface CollectionMigrationReport {
	readonly collection: string;
	/** Rows examined (all in-scope rows of the collection). */
	readonly scanned: number;
	/** Rows rewritten to the current def version. */
	readonly migrated: number;
	/** Rows whose migration failed — stored data untouched. */
	readonly failed: readonly { readonly id: number; readonly reason: string }[];
}

export interface DocumentStoreShape {
	/** Idempotent registry upsert: inserts the collection row or bumps
	 * `version`/`schema_json` when the incoming def is newer. Highest
	 * version wins; equal or older defs are a no-op. Returns the row.
	 * A malformed def dies as a defect (packaging bug, not a runtime
	 * condition). */
	readonly ensureCollection: (
		def: DocumentCollection,
	) => Effect.Effect<DocumentCollectionRow, DocumentStoreError>;
	/** Validate + insert a record. Applies defaults, enforces required
	 * fields, field constraints and `unique` fields, checks `ref`
	 * targets exist in the caller's visible scope, and auto-registers
	 * the collection row when needed. `options.idempotencyKey` (T-127)
	 * makes the insert replayable: a key that already produced a
	 * visible record returns THAT record instead of writing a second
	 * one; a key held outside the caller's scope fails
	 * `DocumentIdempotencyConflict`. */
	readonly insert: <F extends Fields>(
		collection: CollectionRef<F>,
		data: InferInsert<F>,
		ctx?: DocumentStoreContext,
		options?: DocumentWriteOptions,
	) => Effect.Effect<DocumentRecord<F>, DocumentStoreError>;
	/** Fetch one record by id inside the caller's visible scope, or
	 * null (missing and not-visible are indistinguishable — no
	 * existence oracle across scopes). */
	readonly get: <F extends Fields>(
		collection: CollectionRef<F>,
		id: number,
		ctx?: DocumentStoreContext,
	) => Effect.Effect<DocumentRecord<F> | null, DocumentStoreError>;
	/** List records inside the caller's visible scope. `filter` uses
	 * dotted paths with `$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$exists/
	 * $regex` operators plus `$and`/`$or`; evaluation is JS-side over
	 * parsed JSON (see query.ts for the v1 tradeoff). `limit` clamps to
	 * [1, 500] (default 100), `offset` to ≥ 0; filters are structurally
	 * bounded (depth/nodes — see query.ts) and the visible slice is
	 * capped at FIND_SCAN_MAX_ROWS scanned rows (see README.md for the
	 * scale-ceiling guidance before putting `find` on a hot path). */
	readonly find: <F extends Fields>(
		collection: CollectionRef<F>,
		query?: FindQuery,
		ctx?: DocumentStoreContext,
	) => Effect.Effect<FindResult<F>, DocumentStoreError>;
	/** Merge-patch a record: `data` is validated with `partial: true`
	 * (only present keys are checked; required is not re-asserted) and
	 * merged over the stored document — stored values are re-validated
	 * too, so a schema-tightening deploy fails loudly on old rows.
	 * `unique`/`ref` rules apply to the resulting document.
	 * `options.expectedVersion` adds the If-Match guard (T-127): the
	 * patch lands only when the stored `version` matches, else
	 * `DocumentVersionConflict` carries the actual version; absent it,
	 * updates are last-write-wins. */
	readonly update: <F extends Fields>(
		collection: CollectionRef<F>,
		id: number,
		data: Partial<InferInsert<F>>,
		ctx?: DocumentStoreContext,
		options?: DocumentWriteOptions,
	) => Effect.Effect<DocumentRecord<F>, DocumentStoreError>;
	/** Delete a record inside the caller's visible scope, applying each
	 * `ref` field's `onDelete` policy toward it (`restrict` default —
	 * fails `DocumentInUse`, `cascade` deletes the referencing records,
	 * `nullify` rewrites the field to `null`). All writes — nullify
	 * patches, cascade deletes and the target delete — run in ONE
	 * transaction, so a delete can never half-apply (T-126). Still
	 * scope-bound: only references inside the caller's visible scope of
	 * the referencing collection are seen — cross-scope references are
	 * ignored (documented v1 limitation). Cascade is one level deep (no
	 * recursion). */
	readonly delete: <F extends Fields>(
		collection: CollectionRef<F>,
		id: number,
		ctx?: DocumentStoreContext,
	) => Effect.Effect<void, DocumentStoreError>;
	/** Atomic multi-document write (T-126): every op is validated,
	 * permission-checked (`permissions` blocks apply per op, T-128) and
	 * planned against the committed state overlaid with earlier ops'
	 * effects; ALL writes then land in a single `tx()` — any failure
	 * (validation, permissions, refs, unique, id conflicts, a database
	 * error mid-transaction) aborts the whole batch with nothing
	 * written. `ref`/`unique` checks see earlier ops in the same batch:
	 * a `ref` may target an `insert` op's explicit `id` (autoincrement
	 * inserts are unreferenceable — their id doesn't exist until
	 * commit), and refs to docs deleted earlier in the batch fail
	 * `BrokenReference`. `onDelete` cascade/nullify applies to pending
	 * batch writes too: a cascade drops a pending insert/update that
	 * references the deleted doc; a nullify patches its data. See
	 * {@link DocumentBatchOp} for the op shapes. */
	readonly batch: (
		ops: readonly DocumentBatchOp[],
		ctx?: DocumentStoreContext,
	) => Effect.Effect<readonly DocumentBatchResult[], DocumentStoreError>;
	/** Eager schema-migration sweep (T-130): rewrites every in-scope
	 * stored document of `collection` whose `schema_version` is below
	 * the current def version through the def's `migrations` chain and
	 * stamps the new version — the persistent counterpart of lazy
	 * read-time migration. Per-document failures are collected in the
	 * report (row untouched, retried next sweep); the sweep itself is
	 * NOT one transaction — each row update is independent and the
	 * operation is idempotent/resumable. Gated on the collection's
	 * `write` permission like any other mutation. */
	readonly migrateCollection: (
		collection: CollectionRef,
		ctx?: DocumentStoreContext,
	) => Effect.Effect<CollectionMigrationReport, DocumentStoreError>;
}

export class DocumentStore extends Context.Service<DocumentStore, DocumentStoreShape>()(
	"@ktb/document-store/DocumentStore",
) {}

// ---------- internals ----------

const parseData = (raw: string): Record<string, unknown> => {
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// A corrupt row reads as empty data rather than taking the
		// service down — writes re-validate before they persist.
		return {};
	}
};

const fail = (error: DocumentStoreError): Effect.Effect<never, DocumentStoreError> =>
	Effect.fail(error);

/** Serialized-`data` size cap in UTF-8 bytes, enforced on insert and
 * update (T-128). 64KB keeps one document small against the JS-side
 * query scan and worker memory; bigger payloads belong in dedicated
 * storage, not the document store. */
export const MAX_DOCUMENT_BYTES = 64 * 1024;

/** Per-isolate collection-registry cache bounds (T-129), mirroring the
 * i18n runtime stamp pattern: `document_collections` rows are re-read
 * at most every {@link COLLECTION_CACHE_TTL_MS} — `ensureCollection`
 * writes refresh the entry immediately, and expiry picks up registry
 * changes made by OTHER isolates. Parsed defs are keyed by their
 * `schema_json` content, so a refetched row carrying a different def
 * re-parses exactly once (and a cached live def — including code-only
 * `migrations` — survives as long as its schema_json matches).
 * Document RECORDS are never cached. Both maps are bounded:
 * {@link MAX_COLLECTION_CACHE_ENTRIES} leaves generous headroom over
 * realistic collection counts; Map iterates in insertion order, so
 * eviction drops the oldest entry. */
export const COLLECTION_CACHE_TTL_MS = 15_000;
export const MAX_COLLECTION_CACHE_ENTRIES = 128;

const utf8 = new TextEncoder();

const serializedBytes = (data: Record<string, unknown>): number =>
	utf8.encode(JSON.stringify(data)).byteLength;

export const DocumentStoreLive = Layer.effect(
	DocumentStore,
	Effect.gen(function* () {
		const db = yield* Db;
		const collections = yield* DocumentCollections;
		// Optional rbac citizen (plugins/rbac `rbac.services`): absent →
		// collections WITHOUT a `permissions` block behave exactly as
		// before; collections WITH one fail closed (Forbidden) — see
		// requireOp/specAllowed below. Optional-dep ordering puts
		// rbac.services before this layer when both are installed.
		const permissionsOpt = yield* Effect.serviceOption(Permissions);

		// Def caches (T-129): contributed defs are static per runtime.
		// DB collection ROWS are cached with a TTL stamp (cross-isolate
		// freshness) and bounded; parsed defs are cached against the
		// schema_json they were decoded from — content-keyed invalidation
		// keeps live defs (with code-only `migrations`) valid exactly as
		// long as the row they describe is current.
		const contributed = new Map(collections.collections.map((d) => [d.name, d] as const));
		const registeredDefs = new Map<string, { def: DocumentCollection; schemaJson: string }>();
		const collectionRows = new Map<string, { row: DocumentCollectionRow; at: number }>();

		/** Bounded map insert: re-insert moves the key to the
		 * most-recently-used position; overflow evicts oldest-first. */
		const cachePut = <K, V>(map: Map<K, V>, key: K, value: V): void => {
			map.delete(key);
			map.set(key, value);
			while (map.size > MAX_COLLECTION_CACHE_ENTRIES) {
				// size > MAX ≥ 1 → the iterator always yields.
				map.delete(map.keys().next().value!);
			}
		};

		const rowFor = (name: string): Effect.Effect<DocumentCollectionRow | null> =>
			Effect.gen(function* () {
				const now = Date.now();
				const hit = collectionRows.get(name);
				if (hit !== undefined && now - hit.at < COLLECTION_CACHE_TTL_MS) return hit.row;
				const rows = yield* Effect.promise(() =>
					db.select().from(documentCollections).where(eq(documentCollections.name, name)).limit(1),
				);
				const row = (rows[0] as DocumentCollectionRow | undefined) ?? null;
				// Negative lookups are NOT cached — a first write
				// auto-registers and must be visible immediately.
				if (row !== null) cachePut(collectionRows, name, { row, at: now });
				return row;
			});

		const defFromRow = (row: DocumentCollectionRow): DocumentCollection => {
			const cached = registeredDefs.get(row.name);
			if (cached !== undefined && cached.schemaJson === row.schemaJson) return cached.def;
			// schema_json is written by ensureCollection from a
			// DocumentCollection — a parse failure is corruption, so it
			// dies as a defect rather than a typed error.
			const def = JSON.parse(row.schemaJson) as DocumentCollection;
			cachePut(registeredDefs, row.name, { def, schemaJson: row.schemaJson });
			return def;
		};

		/** Resolve a name or def to { def, row | null }. A name unknown
		 * to BOTH the contributed registry and document_collections
		 * fails UnknownCollection; a contributed-but-unregistered def
		 * resolves with row null (writes auto-register it). */
		const resolveDef = (
			ref: CollectionRef,
		): Effect.Effect<
			{ def: DocumentCollection; row: DocumentCollectionRow | null },
			DocumentStoreError
		> =>
			Effect.gen(function* () {
				if (typeof ref !== "string") {
					return { def: ref, row: yield* rowFor(ref.name) };
				}
				const contributedDef = contributed.get(ref);
				const row = yield* rowFor(ref);
				if (contributedDef !== undefined) return { def: contributedDef, row };
				if (row === null) return yield* fail(new UnknownCollection({ name: ref }));
				return { def: defFromRow(row), row };
			});

		const resolveOwner = (ctx: DocumentStoreContext | undefined) =>
			ctx?.ownerId !== undefined
				? Effect.succeed(ctx.ownerId ?? "")
				: Effect.map(Principal, (p) => p?.userId ?? "");

		/** Visible-scope WHERE: collection + tenant fence + (own
		 * personal row OR tenant-owned row). `unscoped` (system/admin
		 * flows only — see DocumentStoreContext) drops both fences and
		 * matches every row of the collection. */
		const scopeCondition = (
			collectionId: number,
			ownerId: string,
			unscoped: boolean,
		): Effect.Effect<SQL | undefined> =>
			Effect.gen(function* () {
				if (unscoped) return eq(documentRecords.collectionId, collectionId);
				const fence = yield* tenantScopeCondition(documentRecords);
				return and(
					eq(documentRecords.collectionId, collectionId),
					fence,
					or(eq(documentRecords.ownerId, ownerId), isNotNull(documentRecords.tenantId)),
				);
			});

		const scopedRows = (
			collectionId: number,
			ownerId: string,
			unscoped: boolean,
		): Effect.Effect<DocumentRecordRow[]> =>
			Effect.gen(function* () {
				const where = yield* scopeCondition(collectionId, ownerId, unscoped);
				return (yield* Effect.promise(() =>
					db.select().from(documentRecords).where(where),
				)) as DocumentRecordRow[];
			});

		/** One row inside the caller's visible scope — null when missing
		 * OR not visible. */
		const scopedRow = (
			collectionId: number,
			id: number,
			ownerId: string,
			unscoped: boolean,
		): Effect.Effect<DocumentRecordRow | null> =>
			Effect.gen(function* () {
				const where = yield* scopeCondition(collectionId, ownerId, unscoped);
				const rows = yield* Effect.promise(() =>
					db
						.select()
						.from(documentRecords)
						.where(and(where, eq(documentRecords.id, id)))
						.limit(1),
				);
				return (rows[0] as DocumentRecordRow | undefined) ?? null;
			});

		/** Ids of `ids` that exist inside the caller's visible scope of
		 * one collection — the batched counterpart of `scopedRow` used
		 * by `checkRefs` (T-129): one `IN` query per target collection
		 * instead of one point lookup per ref field. Only `id` is
		 * selected — callers need existence, not payloads. `ids` is
		 * always non-empty (checkRefs only queries collected id sets). */
		const scopedExistingIds = (
			collectionId: number,
			ids: readonly number[],
			ownerId: string,
			unscoped: boolean,
		): Effect.Effect<ReadonlySet<number>> =>
			Effect.gen(function* () {
				const where = yield* scopeCondition(collectionId, ownerId, unscoped);
				const rows = yield* Effect.promise(() =>
					db
						.select({ id: documentRecords.id })
						.from(documentRecords)
						.where(and(where, inArray(documentRecords.id, [...ids]))),
				);
				return new Set(rows.map((r) => r.id));
			});

		// ---------- collection permissions (T-128) ----------

		/** Ambient tenant id for tenant-scoped grant lookups (P-084):
		 * the record's own tenant isn't known before the fetch, so every
		 * check binds the ambient `Tenant` — global grants always
		 * satisfy, tenant-pinned grants only inside their tenant.
		 * Personal/system scope resolves `undefined` → global grants
		 * only (rbac treats an absent tenantId as tenant_id NULL). */
		const grantTenantId = Effect.map(Tenant, (t) => {
			const id = tenantScopeId(t);
			return id === null ? undefined : id;
		});

		/** ANY-of permission spec → boolean. Fails CLOSED on every
		 * ambiguity: no `Permissions` service, no bound principal, or no
		 * matching allow grant all resolve false. */
		const specAllowed = (
			spec: CollectionPermissionSpec,
			tenantId: string | number | undefined,
		): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				if (Option.isNone(permissionsOpt)) return false;
				const permissions = permissionsOpt.value;
				const list = typeof spec === "string" ? [spec] : spec;
				for (const entry of list) {
					const { resource, action } = splitPermission(entry);
					if (yield* permissions.can(resource, action, { tenantId })) return true;
				}
				return false;
			});

		/** Collection-level gate: no-op when the def declares no
		 * `permissions` block, the op has no spec, or the caller is
		 * `unscoped` (system/admin flows — DocumentStoreAdmin is already
		 * gated by PlatformAdmin). Denial → `Forbidden`. */
		const requireOp = (
			def: DocumentCollection,
			op: "read" | "write" | "delete",
			unscoped: boolean,
		): Effect.Effect<void, DocumentStoreError> =>
			Effect.gen(function* () {
				const perms = def.permissions;
				if (unscoped || perms === undefined) return;
				const spec = perms[op];
				if (spec === undefined) return;
				const tenantId = yield* grantTenantId;
				if (!(yield* specAllowed(spec, tenantId))) {
					return yield* fail(new Forbidden({ path: `documents.${def.name}.${op}` }));
				}
			});

		/** Write gate for caller-supplied keys: rejects the write when a
		 * `permissions.fields.<name>.write` spec exists AND the caller's
		 * payload carries that key AND the grant is denied. Untouched
		 * stored values of denied fields are not gated — they simply
		 * can't be changed (insert-side `default` injection is likewise
		 * not caller input). */
		const assertWritableData = (
			def: DocumentCollection,
			input: object,
			unscoped: boolean,
		): Effect.Effect<void, DocumentStoreError> =>
			Effect.gen(function* () {
				const fieldPerms = def.permissions?.fields;
				if (unscoped || fieldPerms === undefined) return;
				const checks: { field: string; spec: CollectionPermissionSpec }[] = [];
				for (const [field, rule] of Object.entries(fieldPerms)) {
					if (rule.write !== undefined && Object.hasOwn(input, field)) {
						checks.push({ field, spec: rule.write });
					}
				}
				if (checks.length === 0) return;
				const tenantId = yield* grantTenantId;
				for (const { field, spec } of checks) {
					if (!(yield* specAllowed(spec, tenantId))) {
						return yield* fail(new Forbidden({ path: `documents.${def.name}.${field}.write` }));
					}
				}
			});

		/** Fields whose `permissions.fields.<name>.read` spec denies the
		 * caller — resolved ONCE per call (grants don't vary per row),
		 * then stripped synchronously from every returned document.
		 * Whole-field allow/deny: no partial masking. */
		const deniedReadFields = (
			def: DocumentCollection,
			unscoped: boolean,
		): Effect.Effect<ReadonlySet<string>, DocumentStoreError> =>
			Effect.gen(function* () {
				const denied = new Set<string>();
				const fieldPerms = def.permissions?.fields;
				if (unscoped || fieldPerms === undefined) return denied;
				const tenantId = yield* grantTenantId;
				for (const [field, rule] of Object.entries(fieldPerms)) {
					if (rule.read !== undefined && !(yield* specAllowed(rule.read, tenantId))) {
						denied.add(field);
					}
				}
				return denied;
			});

		const stripDenied = (
			data: Record<string, unknown>,
			denied: ReadonlySet<string>,
		): Record<string, unknown> => {
			if (denied.size === 0) return data;
			const out = { ...data };
			for (const field of denied) delete out[field];
			return out;
		};

		/** Stored row → wire record with read-denied fields stripped.
		 * `data` is supplied by the caller (validated write payload or
		 * lazily-migrated stored payload) — projection never re-parses
		 * `row.data` so migrated reads and write results share one path. */
		const projectRecord = <F extends Fields>(
			def: DocumentCollection,
			row: DocumentRecordRow,
			data: Record<string, unknown>,
			denied: ReadonlySet<string>,
		): DocumentRecord<F> => ({
			id: row.id,
			collectionId: row.collectionId,
			collection: def.name,
			data: stripDenied(data, denied) as InferRecord<F>,
			schemaVersion: row.schemaVersion,
			version: row.version,
			ownerId: row.ownerId,
			tenantId: row.tenantId,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		});

		/** Lazy schema migration (T-130): bring `data` from the row's
		 * stored `schema_version` up to `def.version` through the def's
		 * declared `migrations` chain, then re-validate the result
		 * against the CURRENT field DSL (full validation — required
		 * fields and unknown keys are enforced on the migrated shape).
		 *
		 * `applied` reports whether at least one migration step ran —
		 * sweeps stamp `schema_version` only then. When the def declares
		 * NO migrations the version stays advisory and data passes
		 * through untouched (pre-T-130 semantics: a bare version bump
		 * never broke reads). A stored version AHEAD of the def also
		 * passes through — highest-version-wins means the def should be
		 * current, but reads must not fail on a stale def.
		 *
		 * Every failure is a typed {@link DocumentMigrationError} and
		 * leaves the stored row untouched: no covering migration path,
		 * a `migrate` step that threw or returned a non-object, or a
		 * migrated document that fails validation. */
		const migrateData = (
			def: DocumentCollection,
			data: Record<string, unknown>,
			fromVersion: number,
			recordId: number | null,
		): Effect.Effect<
			{ readonly data: Record<string, unknown>; readonly applied: boolean },
			DocumentStoreError
		> => {
			const target = def.version;
			if (fromVersion >= target) return Effect.succeed({ data, applied: false });
			const steps = def.migrations;
			if (steps === undefined || steps.length === 0) {
				return Effect.succeed({ data, applied: false });
			}
			const failMig = (reason: string) =>
				fail(
					new DocumentMigrationError({
						collection: def.name,
						recordId,
						from: fromVersion,
						to: target,
						reason,
					}),
				);
			return Effect.gen(function* () {
				// Deterministic step order; each applied step strictly
				// increases `current` (from <= current < to), so the loop
				// terminates — versions are small integers.
				const ordered = [...steps].sort((a, b) => a.from - b.from);
				let current = fromVersion;
				let doc = data;
				while (current < target) {
					const step = ordered.find((m) => m.from <= current && m.to > current);
					if (step === undefined) {
						return yield* failMig(`no migration path from version ${current} to ${target}`);
					}
					const raw = yield* Effect.try({
						try: () => step.migrate(doc) as unknown,
						catch: (e) =>
							new DocumentMigrationError({
								collection: def.name,
								recordId,
								from: fromVersion,
								to: target,
								reason: `migration ${step.from}→${step.to} threw: ${String(e)}`,
							}),
					});
					if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
						return yield* failMig(`migration ${step.from}→${step.to} returned a non-object`);
					}
					doc = raw as Record<string, unknown>;
					current = step.to;
				}
				const validated = validateDocumentData(def.fields, doc);
				if (!validated.ok) {
					return yield* failMig(`migrated document invalid: ${validated.issues.join("; ")}`);
				}
				return { data: validated.data, applied: true };
			});
		};

		/** Serialized-size gate shared by insert/update. */
		const checkDocumentSize = (
			def: DocumentCollection,
			data: Record<string, unknown>,
		): Effect.Effect<void, DocumentStoreError> => {
			const bytes = serializedBytes(data);
			return bytes > MAX_DOCUMENT_BYTES
				? fail(new DocumentTooLarge({ collection: def.name, bytes }))
				: Effect.void;
		};

		/** Every def the service knows: contributed defs plus
		 * DB-registered rows (parsed lazily). The delete path scans
		 * these for `ref` fields pointing at the deleted collection. */
		const allDefs = Effect.gen(function* () {
			const defs = new Map(contributed);
			const rows = yield* Effect.promise(() => db.select().from(documentCollections));
			for (const row of rows as DocumentCollectionRow[]) {
				if (!defs.has(row.name)) defs.set(row.name, defFromRow(row));
			}
			return [...defs.values()] as readonly DocumentCollection[];
		});

		const ensureRow = (def: DocumentCollection) =>
			Effect.gen(function* () {
				// Shape-check before the def hits the registry — a
				// malformed contribution is a packaging bug (defect).
				assertCollectionDef(def, "ensureCollection");
				const existing = yield* rowFor(def.name);
				const now = new Date();
				// `migrations` are code (functions) — they ride the
				// contributed def in-process but cannot persist into
				// schema_json; a def reconstructed from a DB row alone
				// resolves without them (documented on the def type).
				const persisted: Record<string, unknown> = { ...def };
				delete persisted.migrations;
				const schemaJson = JSON.stringify(persisted);
				if (existing === null) {
					const rows = yield* Effect.promise(() =>
						db
							.insert(documentCollections)
							.values({
								name: def.name,
								ownerPluginId: def.owner ?? "",
								schemaJson,
								version: def.version,
								createdAt: now,
								updatedAt: now,
							})
							.returning(),
					);
					const row = rows[0] as DocumentCollectionRow;
					cachePut(collectionRows, def.name, { row, at: Date.now() });
					cachePut(registeredDefs, def.name, { def, schemaJson });
					return row;
				}
				// Highest version wins; equal/older defs are a no-op
				// (first registrant keeps ownership at equal versions).
				// Concurrent ensureRow calls can race past the version
				// check — last writer wins on schema_json; acceptable
				// for a registry upsert whose defs are static per deploy.
				if (def.version <= existing.version) return existing;
				const rows = yield* Effect.promise(() =>
					db
						.update(documentCollections)
						.set({
							ownerPluginId: def.owner ?? existing.ownerPluginId,
							schemaJson,
							version: def.version,
							updatedAt: now,
						})
						.where(eq(documentCollections.id, existing.id))
						.returning(),
				);
				// `.returning()` on a matched update always yields the row.
				const row = rows[0] as DocumentCollectionRow;
				cachePut(collectionRows, def.name, { row, at: Date.now() });
				cachePut(registeredDefs, def.name, { def, schemaJson });
				return row;
			});

		/** Ensure a contributed def has a registry row (writes
		 * auto-register; reads do not — an unregistered contributed
		 * collection simply has no records yet). */
		const ensureDefRow = (def: DocumentCollection, row: DocumentCollectionRow | null) =>
			row === null ? ensureRow(def) : Effect.succeed(row);

		// ---------- batch planning state (T-126) ----------

		/** A pending document write inside {@link runBatch}: validated
		 * `data` is MUTABLE until materialization — a later update merges
		 * over it, a delete's nullify patches it, a cascade drops it.
		 * Writes become drizzle ops only after ALL ops are planned, so
		 * later ops always see the final shape of earlier ones. */
		interface PendingWriteBase {
			/** Index of the user op that created this write — fixes the
			 * materialization order (ops apply in order). */
			readonly opIndex: number;
			readonly def: DocumentCollection;
			/** `document_collections.id` the row belongs to. */
			readonly collectionId: number;
			/** The `owner_id`/`tenant_id` the written row will carry —
			 * pending writes join unique buckets exactly like stored rows. */
			readonly ownerId: string;
			readonly tenantId: number | null;
			/** The row `version` after this write materializes (T-127):
			 * inserts are born at 1, an update plans committed+1 (the
			 * materialized UPDATE bumps `version + 1` in SQL, so a
			 * concurrent writer can't be overwritten backwards). Later
			 * ops' `expectedVersion` compares against this planned
			 * value — sequential semantics inside the batch. */
			readonly version: number;
			data: Record<string, unknown>;
			/** Set when a later op removes this write (cascade or delete
			 * of the pending doc itself). */
			dropped: boolean;
		}

		/** insert = new row; `id` is the optional explicit primary key
		 * (null = autoincrement — unreachable by id within the batch).
		 * `idempotencyKey` is the validated op key (null = none). */
		interface PendingInsert extends PendingWriteBase {
			readonly kind: "insert";
			readonly id: number | null;
			readonly idempotencyKey: string | null;
		}

		/** update = patch of a committed row; `id` always set. */
		interface PendingUpdate extends PendingWriteBase {
			readonly kind: "update";
			readonly id: number;
		}

		type PendingWrite = PendingInsert | PendingUpdate;

		/** Per-op batch outcome: record-producing ops point at their
		 * PendingWrite (`record: null` once the write is dropped by a
		 * later delete); deletes produce no record. */
		type OpOutcome =
			| {
					readonly kind: "record";
					readonly op: "insert" | "update";
					readonly write: PendingWrite;
			  }
			| {
					/** Idempotent-insert replay (T-127): the op's key matched
					 * an already-committed record — no write lands and the
					 * result projects the STORED row (migrated + read-field
					 * stripping applied at materialization, like `get`). */
					readonly kind: "replay";
					readonly op: "insert";
					readonly def: DocumentCollection;
					readonly row: DocumentRecordRow;
			  }
			| { readonly kind: "delete" };

		/** Everything a batch needs to overlay committed state: pending
		 * writes, in-batch deletes, and merged nullify patches. One
		 * instance per `batch` call — single ops are batches of one. */
		interface BatchPlan {
			readonly ownerId: string;
			readonly unscoped: boolean;
			readonly tenantId: number | null;
			readonly writes: PendingWrite[];
			/** Id-addressable pending writes: explicit-id inserts and
			 * updates to committed rows (autoincrement inserts are
			 * unreachable by id until commit). */
			readonly byId: Map<number, PendingWrite>;
			/** Committed row ids deleted by delete ops (target + cascade)
			 * → first opIndex that emitted the delete write. */
			readonly rowDeletes: Map<number, number>;
			/** Nullify patches on committed rows: rowId → merged patch
			 * (`opIndex` = first patching op, for write ordering). */
			readonly nullifies: Map<
				number,
				{ def: DocumentCollection; data: Record<string, unknown>; opIndex: number }
			>;
			/** Batched ref-existence lookups (T-129): committed state
			 * doesn't change during planning, so `scopedExistingIds`
			 * results are reusable across ops — key is
			 * `collectionId:sortedIds`. */
			readonly refCache: Map<string, ReadonlySet<number>>;
			readonly outcomes: OpOutcome[];
		}

		/** Effective stored data of a committed row inside the plan:
		 * a pending write's data wins (byId holds only non-dropped
		 * writes), then a nullify patch, then stored JSON. Callers
		 * skip `rowDeletes` rows before asking — a deleted row never
		 * reaches this. */
		const effectiveRowData = (plan: BatchPlan, row: DocumentRecordRow): Record<string, unknown> => {
			const pending = plan.byId.get(row.id);
			if (pending !== undefined) return pending.data;
			const patch = plan.nullifies.get(row.id);
			return patch === undefined ? parseData(row.data) : patch.data;
		};

		/** Validate `ref` targets: every non-null ref value must point at
		 * an existing record inside the caller's visible scope of the
		 * TARGET collection (auto-registering the target row when the
		 * target is contributed but not yet registered). Re-checks ALL
		 * ref fields on every write — update passes the merged
		 * document, so untouched refs are re-validated too (a target
		 * deleted out-of-band since the last write fails loudly).
		 *
		 * Inside a batch the target may also resolve through the plan:
		 * an earlier `insert` op's explicit `id` satisfies the ref, and
		 * a target deleted by an earlier op fails `BrokenReference`
		 * (sequential semantics — ops apply in order). */
		const checkRefs = (
			def: DocumentCollection,
			data: Record<string, unknown>,
			ownerId: string,
			unscoped: boolean,
			plan: BatchPlan,
		): Effect.Effect<void, DocumentStoreError> =>
			Effect.gen(function* () {
				// Phase 1 — classify every ref field in declaration order:
				// plan-resolved (pending write of the target collection),
				// already-broken (missing target collection name, deleted
				// target, or cross-collection pending target), or needing
				// a DB existence check. `pending` keeps field order so
				// phase 3 fails on the FIRST problem exactly like the old
				// per-field loop did.
				interface DbCheck {
					readonly field: string;
					readonly targetName: string;
					readonly targetId: number;
				}
				type Pending =
					| { readonly kind: "broken"; readonly error: DocumentStoreError }
					| { readonly kind: "db"; readonly check: DbCheck };
				const pending: Pending[] = [];
				for (const [field, descriptor] of Object.entries(def.fields)) {
					if (descriptor.kind !== "ref") continue;
					const targetId = data[field];
					if (typeof targetId !== "number") continue;
					const targetName = descriptor.collection;
					if (targetName === undefined) {
						pending.push({
							kind: "broken",
							error: new DocumentValidationError({
								collection: def.name,
								issues: [`${field}: ref field missing target collection`],
							}),
						});
						continue;
					}
					const broken = () =>
						new BrokenReference({
							collection: def.name,
							field,
							targetCollection: targetName,
							targetId,
						});
					// Earlier batch ops win over the committed read: a
					// delete makes the target unreachable even though the
					// row still exists pre-transaction.
					if (plan.rowDeletes.has(targetId)) {
						pending.push({ kind: "broken", error: broken() });
						continue;
					}
					const pendingTarget = plan.byId.get(targetId);
					if (pendingTarget !== undefined) {
						// Resolvable only when the pending write belongs to
						// the referenced collection — an id is global, so a
						// same-id write of ANOTHER collection is still broken.
						if (pendingTarget.def.name !== targetName) {
							pending.push({ kind: "broken", error: broken() });
						}
						continue;
					}
					pending.push({ kind: "db", check: { field, targetName, targetId } });
				}
				// Phase 2 — ONE existence query per target collection for
				// ALL referenced ids (T-129), cached per batch plan.
				// Target-resolution failures (UnknownCollection) are
				// captured per collection and re-thrown in field order
				// during phase 3.
				const idsByTarget = new Map<string, Set<number>>();
				for (const entry of pending) {
					if (entry.kind !== "db") continue;
					const set = idsByTarget.get(entry.check.targetName) ?? new Set<number>();
					set.add(entry.check.targetId);
					idsByTarget.set(entry.check.targetName, set);
				}
				const resolved = new Map<
					string,
					{ found: ReadonlySet<number> } | { error: DocumentStoreError }
				>();
				for (const [targetName, idSet] of idsByTarget) {
					const outcome = yield* Effect.result(
						Effect.gen(function* () {
							const target = yield* resolveDef(targetName);
							const targetRow = yield* ensureDefRow(target.def, target.row);
							const ids = [...idSet].sort((a, b) => a - b);
							const cacheKey = `${targetRow.id}:${ids.join(",")}`;
							const cached = plan.refCache.get(cacheKey);
							const found =
								cached ?? (yield* scopedExistingIds(targetRow.id, ids, ownerId, unscoped));
							if (cached === undefined) plan.refCache.set(cacheKey, found);
							return { found };
						}),
					);
					resolved.set(
						targetName,
						Result.isFailure(outcome) ? { error: outcome.failure } : outcome.success,
					);
				}
				// Phase 3 — fail on the first problem in field order.
				for (const entry of pending) {
					if (entry.kind === "broken") return yield* fail(entry.error);
					const target = resolved.get(entry.check.targetName);
					/* v8 ignore next -- every db entry's target was resolved above */
					if (target === undefined) continue;
					if ("error" in target) return yield* fail(target.error);
					if (!target.found.has(entry.check.targetId)) {
						return yield* fail(
							new BrokenReference({
								collection: def.name,
								field: entry.check.field,
								targetCollection: entry.check.targetName,
								targetId: entry.check.targetId,
							}),
						);
					}
				}
			});

		/** Enforce `unique: true` fields within the record's uniqueness
		 * bucket — tenant rows unique per tenant_id, personal rows per
		 * (tenant NULL + owner_id). v1 scans the bucket in JS; inside a
		 * batch the bucket includes pending writes (with their own
		 * owner/tenant attribution) and excludes rows earlier ops
		 * delete, so two ops in one batch cannot collide silently. */
		const checkUnique = (
			def: DocumentCollection,
			collectionId: number,
			data: Record<string, unknown>,
			ownerId: string,
			tenantId: number | null,
			excludeId: number | undefined,
			unscoped: boolean,
			plan: BatchPlan,
		): Effect.Effect<void, DocumentStoreError> =>
			Effect.gen(function* () {
				const uniqueFields = Object.entries(def.fields).filter(([, d]) => d.unique === true);
				if (uniqueFields.length === 0) return;
				const all = yield* scopedRows(collectionId, ownerId, unscoped);
				// Bucket entries carry effective data + scope attribution,
				// whether committed (with batch overlays applied) or a
				// pending write.
				const bucket: {
					data: Record<string, unknown>;
					tenantId: number | null;
					ownerId: string;
				}[] = [];
				for (const r of all) {
					if (excludeId !== undefined && r.id === excludeId) continue;
					if (plan.rowDeletes.has(r.id)) continue;
					const pending = plan.byId.get(r.id);
					const eff =
						pending !== undefined
							? pending.data
							: (plan.nullifies.get(r.id)?.data ?? parseData(r.data));
					bucket.push({ data: eff, tenantId: r.tenantId, ownerId: r.ownerId });
				}
				for (const w of plan.writes) {
					if (w.dropped || w.collectionId !== collectionId) continue;
					if (excludeId !== undefined && w.id === excludeId) continue;
					bucket.push({ data: w.data, tenantId: w.tenantId, ownerId: w.ownerId });
				}
				// Uniqueness bucket: tenant rows are unique per exact
				// tenant_id (an accessible-set read may span several
				// tenants — they must not collide); personal rows per
				// (tenant NULL + owner_id).
				const scoped = bucket.filter((r) => {
					if (tenantId !== null) return r.tenantId === tenantId;
					return r.tenantId === null && r.ownerId === ownerId;
				});
				for (const [field] of uniqueFields) {
					const value = data[field];
					if (value === undefined) continue;
					for (const row of scoped) {
						// Field names are top-level keys — read the literal
						// stored key (a dotted name would be stored literally
						// too, so this stays consistent with validate.ts).
						const otherValue = row.data[field];
						const same =
							typeof value === "object" && value !== null
								? JSON.stringify(value) === JSON.stringify(otherValue)
								: Object.is(value, otherValue);
						if (same) {
							return yield* fail(new DuplicateFieldValue({ collection: def.name, field, value }));
						}
					}
				}
			});

		// ---------- batch op planners (T-126) ----------

		/** Apply one `ref` onDelete policy toward a delete target —
		 * `hit` is either a committed row or a pending batch INSERT
		 * (pending updates surface through their committed row's
		 * effective data, so they always arrive as committed hits).
		 * Committed hits produce rowDeletes/nullifies entries
		 * (materialized as writes after planning); pending hits
		 * mutate/drop the PendingWrite itself. Nullify stays
		 * best-effort: a patched document that fails re-validation is
		 * skipped, exactly like the pre-batch behavior — the whole
		 * batch still commits atomically. `referencedBy` collects
		 * restrict hits for DocumentInUse. */
		const applyRefPolicy = (
			policy: "restrict" | "cascade" | "nullify",
			other: DocumentCollection,
			field: string,
			hit:
				| { readonly kind: "committed"; readonly row: DocumentRecordRow }
				| { readonly kind: "pending"; readonly write: PendingInsert },
			plan: BatchPlan,
			opIndex: number,
			referencedBy: string[],
		): Effect.Effect<void, DocumentStoreError> => {
			if (policy === "restrict") {
				referencedBy.push(`${other.name}.${field}`);
				return Effect.void;
			}
			// nullify — patch field → null and re-validate; invalid
			// documents are skipped (best-effort), never written invalid.
			const patchDoc = (base: Record<string, unknown>) => {
				const data = { ...base };
				// Ref fields are top-level field names — the stored
				// document carries them as literal keys.
				data[field] = null;
				return validateDocumentData(other.fields, data, { partial: true });
			};
			if (hit.kind === "pending") {
				const w = hit.write;
				if (policy === "cascade") {
					w.dropped = true;
					// Autoincrement inserts (id null) never entered byId.
					if (w.id !== null) plan.byId.delete(w.id);
					return Effect.void;
				}
				// Pending writes are fully validated at plan time, so
				// re-validation can only fail on corrupt COMMITTED data
				// — the guard stays so no path can write an invalid doc.
				const validated = patchDoc(w.data);
				/* v8 ignore next -- unreachable: pending data is pre-validated */
				if (!validated.ok) return Effect.void;
				w.data = validated.data;
				return Effect.void;
			}
			const id = hit.row.id;
			if (policy === "cascade") {
				// Callers skip rowDeletes rows, so this is always the
				// first cascade hit on the row.
				plan.rowDeletes.set(id, opIndex);
				plan.nullifies.delete(id);
				// A pending update on the committed row carries the
				// effective document — it dies with the row.
				const pending = plan.byId.get(id);
				if (pending !== undefined) {
					pending.dropped = true;
					plan.byId.delete(id);
				}
				return Effect.void;
			}
			// nullify on a committed row: patch the pending update's
			// effective data when one exists, else merge into the
			// nullifies overlay (first patching opIndex wins ordering).
			const pending = plan.byId.get(id);
			if (pending !== undefined) {
				const validated = patchDoc(pending.data);
				/* v8 ignore next -- unreachable: pending data is pre-validated */
				if (!validated.ok) return Effect.void;
				pending.data = validated.data;
				return Effect.void;
			}
			const base = plan.nullifies.get(id)?.data ?? parseData(hit.row.data);
			const validated = patchDoc(base);
			if (!validated.ok) return Effect.void;
			const existingPatch = plan.nullifies.get(id);
			plan.nullifies.set(id, {
				def: other,
				data: validated.data,
				opIndex: existingPatch?.opIndex ?? opIndex,
			});
			return Effect.void;
		};

		/** Plan an `insert` op: authz → registry → validate → refs/unique
		 * (batch-aware) → explicit-id checks → PendingWrite. */
		const planInsert = (
			opIndex: number,
			op: Extract<DocumentBatchOp, { op: "insert" }>,
			plan: BatchPlan,
		): Effect.Effect<void, DocumentStoreError> =>
			Effect.gen(function* () {
				const { def, row } = yield* resolveDef(op.collection);
				// Authz before any registry/write side effects: a denied
				// caller must not even auto-register the collection.
				yield* requireOp(def, "write", plan.unscoped);
				yield* assertWritableData(def, op.data, plan.unscoped);
				const targetRow = yield* ensureDefRow(def, row);
				// Idempotent insert (T-127): the key is collection-global
				// across scopes — dedupe BEFORE payload validation so a
				// retry replays the stored record even if the resubmitted
				// payload would now fail (e.g. schema tightened since).
				const idempotencyKey = op.idempotencyKey;
				if (idempotencyKey !== undefined) {
					if (
						typeof idempotencyKey !== "string" ||
						idempotencyKey.length === 0 ||
						idempotencyKey.length > 255
					) {
						return yield* fail(
							new DocumentValidationError({
								collection: def.name,
								issues: ["idempotencyKey must be a non-empty string of at most 255 characters"],
							}),
						);
					}
					// A pending insert with the same key can't be replayed
					// (its id — and record — doesn't exist until commit),
					// so a second keyed insert in one batch conflicts.
					// Dropped writes freed their key.
					for (const w of plan.writes) {
						if (
							w.kind === "insert" &&
							!w.dropped &&
							w.collectionId === targetRow.id &&
							w.idempotencyKey === idempotencyKey
						) {
							return yield* fail(
								new DocumentIdempotencyConflict({
									collection: def.name,
									idempotencyKey,
								}),
							);
						}
					}
					// Committed lookup is deliberately UNSCOPED — the unique
					// index spans every owner/tenant slice of the
					// collection. A hit inside the caller's visible scope
					// replays as a read would (migration + field stripping
					// applied at materialization); a hit outside it fails
					// typed rather than leaking the document.
					const keyed = yield* Effect.promise(() =>
						db
							.select()
							.from(documentRecords)
							.where(
								and(
									eq(documentRecords.collectionId, targetRow.id),
									eq(documentRecords.idempotencyKey, idempotencyKey),
								),
							)
							.limit(1),
					);
					const hit = keyed[0] as DocumentRecordRow | undefined;
					// rowDeletes means an earlier op frees the key — reuse
					// is legal (the delete write lands first in op order).
					if (hit !== undefined && !plan.rowDeletes.has(hit.id)) {
						const visible = yield* scopedRow(targetRow.id, hit.id, plan.ownerId, plan.unscoped);
						if (visible === null) {
							return yield* fail(
								new DocumentIdempotencyConflict({
									collection: def.name,
									idempotencyKey,
								}),
							);
						}
						plan.outcomes[opIndex] = {
							kind: "replay",
							op: "insert",
							def,
							row: visible,
						};
						return;
					}
				}
				const validated = validateDocumentData(def.fields, op.data);
				if (!validated.ok) {
					return yield* fail(
						new DocumentValidationError({ collection: def.name, issues: validated.issues }),
					);
				}
				yield* checkDocumentSize(def, validated.data);
				yield* checkRefs(def, validated.data, plan.ownerId, plan.unscoped, plan);
				yield* checkUnique(
					def,
					targetRow.id,
					validated.data,
					plan.ownerId,
					plan.tenantId,
					undefined,
					plan.unscoped,
					plan,
				);
				let explicitId: number | null = null;
				const requestedId = op.id;
				if (requestedId !== undefined) {
					if (!Number.isInteger(requestedId) || requestedId <= 0) {
						return yield* fail(
							new DocumentValidationError({
								collection: def.name,
								issues: ["id must be a positive integer"],
							}),
						);
					}
					const pendingId = plan.byId.get(requestedId);
					if (pendingId !== undefined && !pendingId.dropped) {
						return yield* fail(new RecordIdConflict({ id: requestedId }));
					}
					// rowDeletes means an earlier op frees the id — reuse is
					// legal (the delete write lands first in op order).
					if (!plan.rowDeletes.has(requestedId)) {
						const existing = yield* Effect.promise(() =>
							db
								.select({ id: documentRecords.id })
								.from(documentRecords)
								.where(eq(documentRecords.id, requestedId))
								.limit(1),
						);
						if (existing.length > 0) {
							return yield* fail(new RecordIdConflict({ id: requestedId }));
						}
					}
					explicitId = requestedId;
				}
				const write: PendingInsert = {
					opIndex,
					kind: "insert",
					def,
					collectionId: targetRow.id,
					id: explicitId,
					ownerId: plan.ownerId,
					tenantId: plan.tenantId,
					version: 1,
					data: validated.data,
					dropped: false,
					idempotencyKey: idempotencyKey ?? null,
				};
				plan.writes.push(write);
				if (explicitId !== null) plan.byId.set(explicitId, write);
				plan.outcomes[opIndex] = { kind: "record", op: "insert", write };
			});

		/** Plan an `update` op: the patch merges over the EFFECTIVE
		 * document — a pending batch write's data when the id resolves
		 * inside the plan, else the committed row migrated to the current
		 * def version first (T-130). */
		const planUpdate = (
			opIndex: number,
			op: Extract<DocumentBatchOp, { op: "update" }>,
			plan: BatchPlan,
		): Effect.Effect<void, DocumentStoreError> =>
			Effect.gen(function* () {
				const { def, row } = yield* resolveDef(op.collection);
				yield* requireOp(def, "write", plan.unscoped);
				yield* assertWritableData(def, op.data, plan.unscoped);
				// If-Match guard (T-127): positive-integer expectation or
				// a typed validation failure — checked before any row
				// lookup so a malformed guard can't mask RecordNotFound.
				const expectedVersion = op.expectedVersion;
				if (
					expectedVersion !== undefined &&
					(!Number.isInteger(expectedVersion) || expectedVersion < 1)
				) {
					return yield* fail(
						new DocumentValidationError({
							collection: def.name,
							issues: ["expectedVersion must be a positive integer"],
						}),
					);
				}
				if (row === null || plan.rowDeletes.has(op.id)) {
					return yield* fail(new RecordNotFound({ collection: def.name, id: op.id }));
				}
				const pending = plan.byId.get(op.id);
				if (pending !== undefined && pending.collectionId === row.id) {
					// Sequential semantics: the guard compares against the
					// version the row will carry after earlier ops (a
					// pending insert reads as version 1).
					if (expectedVersion !== undefined && expectedVersion !== pending.version) {
						return yield* fail(
							new DocumentVersionConflict({
								collection: def.name,
								id: op.id,
								expectedVersion,
								actualVersion: pending.version,
							}),
						);
					}
					// Update lands on a pending write of the SAME collection
					// (explicit-id insert or earlier update) — merge over
					// its data; the shared write produces both records.
					const merged = { ...pending.data, ...op.data };
					const validated = validateDocumentData(def.fields, merged, { partial: true });
					if (!validated.ok) {
						return yield* fail(
							new DocumentValidationError({ collection: def.name, issues: validated.issues }),
						);
					}
					yield* checkDocumentSize(def, validated.data);
					yield* checkRefs(def, validated.data, plan.ownerId, plan.unscoped, plan);
					yield* checkUnique(
						def,
						row.id,
						validated.data,
						plan.ownerId,
						pending.tenantId,
						op.id,
						plan.unscoped,
						plan,
					);
					pending.data = validated.data;
					plan.outcomes[opIndex] = { kind: "record", op: "update", write: pending };
					return;
				}
				const existing = yield* scopedRow(row.id, op.id, plan.ownerId, plan.unscoped);
				if (existing === null) {
					return yield* fail(new RecordNotFound({ collection: def.name, id: op.id }));
				}
				if (expectedVersion !== undefined && existing.version !== expectedVersion) {
					return yield* fail(
						new DocumentVersionConflict({
							collection: def.name,
							id: op.id,
							expectedVersion,
							actualVersion: existing.version,
						}),
					);
				}
				// Lazy migration before merge: the patch applies to the
				// CURRENT-shape document and the write re-stamps
				// schema_version — an unmigratable row fails typed here.
				const migrated = yield* migrateData(
					def,
					parseData(existing.data),
					existing.schemaVersion,
					existing.id,
				);
				const merged = { ...migrated.data, ...op.data };
				const validated = validateDocumentData(def.fields, merged, { partial: true });
				if (!validated.ok) {
					return yield* fail(
						new DocumentValidationError({ collection: def.name, issues: validated.issues }),
					);
				}
				yield* checkDocumentSize(def, validated.data);
				yield* checkRefs(def, validated.data, plan.ownerId, plan.unscoped, plan);
				yield* checkUnique(
					def,
					row.id,
					validated.data,
					plan.ownerId,
					existing.tenantId,
					op.id,
					plan.unscoped,
					plan,
				);
				const write: PendingUpdate = {
					opIndex,
					kind: "update",
					def,
					collectionId: row.id,
					id: op.id,
					ownerId: existing.ownerId,
					tenantId: existing.tenantId,
					version: existing.version + 1,
					data: validated.data,
					dropped: false,
				};
				plan.writes.push(write);
				plan.byId.set(op.id, write);
				plan.outcomes[opIndex] = { kind: "record", op: "update", write };
			});

		/** Plan a `delete` op: locate the target (committed row or a
		 * pending explicit-id insert), scan every `ref` field pointing at
		 * the collection — committed rows AND pending batch writes — and
		 * apply each field's onDelete policy into the plan. */
		const planDelete = (
			opIndex: number,
			op: Extract<DocumentBatchOp, { op: "delete" }>,
			plan: BatchPlan,
		): Effect.Effect<void, DocumentStoreError> =>
			Effect.gen(function* () {
				const { def, row } = yield* resolveDef(op.collection);
				yield* requireOp(def, "delete", plan.unscoped);
				if (row === null || plan.rowDeletes.has(op.id)) {
					return yield* fail(new RecordNotFound({ collection: def.name, id: op.id }));
				}
				const pendingTarget = plan.byId.get(op.id);
				const pendingInsert =
					pendingTarget !== undefined &&
					pendingTarget.kind === "insert" &&
					pendingTarget.collectionId === row.id
						? pendingTarget
						: undefined;
				if (pendingInsert === undefined) {
					const existing = yield* scopedRow(row.id, op.id, plan.ownerId, plan.unscoped);
					if (existing === null) {
						return yield* fail(new RecordNotFound({ collection: def.name, id: op.id }));
					}
					// A pending update on the committed target loses to
					// the delete (sequential semantics).
					if (
						pendingTarget !== undefined &&
						pendingTarget.kind === "update" &&
						pendingTarget.collectionId === row.id
					) {
						pendingTarget.dropped = true;
						plan.byId.delete(op.id);
					}
				}
				// ref onDelete policies — best-effort and scope-bound:
				// only references inside the caller's visible scope of the
				// REFERENCING collection are seen (documented v1
				// limitation — cross-scope refs are invisible to every
				// policy, including restrict). Pending batch writes are
				// scanned too, so a same-batch insert/update can't dodge
				// the policy.
				const defs = yield* allDefs;
				const referencedBy: string[] = [];
				for (const other of defs) {
					const otherRow = yield* rowFor(other.name);
					if (otherRow === null) continue;
					for (const [field, descriptor] of Object.entries(other.fields)) {
						if (descriptor.kind !== "ref" || descriptor.collection !== def.name) continue;
						const policy = descriptor.onDelete ?? "restrict";
						const candidates = yield* scopedRows(otherRow.id, plan.ownerId, plan.unscoped);
						for (const r of candidates) {
							if (plan.rowDeletes.has(r.id)) continue;
							const eff = effectiveRowData(plan, r);
							if (eff[field] !== op.id) continue;
							yield* applyRefPolicy(
								policy,
								other,
								field,
								{ kind: "committed", row: r },
								plan,
								opIndex,
								referencedBy,
							);
						}
						for (const w of plan.writes) {
							// Inserts only — a pending update's committed row
							// is already scanned above via effectiveRowData.
							if (w.kind !== "insert" || w.dropped || w.collectionId !== otherRow.id) {
								continue;
							}
							if (w.data[field] !== op.id) continue;
							yield* applyRefPolicy(
								policy,
								other,
								field,
								{ kind: "pending", write: w },
								plan,
								opIndex,
								referencedBy,
							);
						}
					}
				}
				if (referencedBy.length > 0) {
					return yield* fail(new DocumentInUse({ collection: def.name, id: op.id, referencedBy }));
				}
				if (pendingInsert !== undefined) {
					// The target never committed — dropping its write IS
					// the delete (plus whatever the ref scan just applied).
					pendingInsert.dropped = true;
					plan.byId.delete(op.id);
				} else {
					plan.rowDeletes.set(op.id, opIndex);
				}
				plan.outcomes[opIndex] = { kind: "delete" };
			});

		/** Materialize the plan into drizzle ops and run them in ONE
		 * `tx()` — all-or-nothing on every dialect (D1 batch /
		 * better-sqlite3 transaction). Write order follows op order:
		 * each PendingWrite emits at its opIndex, row deletes and
		 * nullify patches at the first opIndex that produced them — so
		 * a reused explicit id inserts AFTER the delete that freed it. */
		const runBatch = (
			ops: readonly DocumentBatchOp[],
			ctx?: DocumentStoreContext,
		): Effect.Effect<readonly DocumentBatchResult[], DocumentStoreError> =>
			Effect.gen(function* () {
				const ownerId = yield* resolveOwner(ctx);
				const unscoped = ctx?.unscoped === true;
				const tenant = yield* Tenant;
				const tenantId = tenantScopeId(tenant);
				const plan: BatchPlan = {
					ownerId,
					unscoped,
					tenantId,
					writes: [],
					byId: new Map(),
					rowDeletes: new Map(),
					nullifies: new Map(),
					refCache: new Map(),
					outcomes: [],
				};
				for (const [opIndex, op] of ops.entries()) {
					if (op.op === "insert") yield* planInsert(opIndex, op, plan);
					else if (op.op === "update") yield* planUpdate(opIndex, op, plan);
					else yield* planDelete(opIndex, op, plan);
				}
				const now = new Date();
				const entries: { order: number; seq: number; op: TxOp; write?: PendingWrite }[] = [];
				let seq = 0;
				for (const w of plan.writes) {
					if (w.dropped) continue;
					entries.push({
						order: w.opIndex * 2,
						seq: seq++,
						write: w,
						op:
							w.kind === "insert"
								? db
										.insert(documentRecords)
										.values({
											...(w.id === null ? {} : { id: w.id }),
											collectionId: w.collectionId,
											data: JSON.stringify(w.data),
											ownerId: w.ownerId,
											tenantId: w.tenantId,
											schemaVersion: w.def.version,
											idempotencyKey: w.idempotencyKey,
											createdAt: now,
											updatedAt: now,
										})
										.returning()
								: db
										.update(documentRecords)
										.set({
											data: JSON.stringify(w.data),
											schemaVersion: w.def.version,
											// Bump in SQL, not from the plan-time
											// read — a concurrent writer between
											// plan and commit still advances the
											// version (T-127).
											version: sql`${documentRecords.version} + 1`,
											updatedAt: now,
										})
										.where(eq(documentRecords.id, w.id))
										.returning(),
					});
				}
				for (const [id, opIdx] of plan.rowDeletes) {
					entries.push({
						order: opIdx * 2 + 1,
						seq: seq++,
						op: db.delete(documentRecords).where(eq(documentRecords.id, id)),
					});
				}
				for (const [id, n] of plan.nullifies) {
					entries.push({
						order: n.opIndex * 2 + 1,
						seq: seq++,
						op: db
							.update(documentRecords)
							.set({
								data: JSON.stringify(n.data),
								// A nullify rewrites the document — bump the
								// row version like any other write (T-127).
								version: sql`${documentRecords.version} + 1`,
								updatedAt: now,
							})
							.where(eq(documentRecords.id, id)),
					});
				}
				entries.sort((a, b) => a.order - b.order || a.seq - b.seq);
				const writeOps = entries.map((e) => e.op);
				const writeIndex = new Map<PendingWrite, number>();
				for (const [i, e] of entries.entries()) {
					if (e.write !== undefined) writeIndex.set(e.write, i);
				}
				const txResults: readonly unknown[] =
					writeOps.length === 0
						? []
						: yield* Effect.promise(() => tx(db, writeOps as [TxOp, ...TxOp[]]));
				// Read-denied fields resolve once per def per batch.
				const deniedCache = new Map<string, ReadonlySet<string>>();
				const deniedFor = (def: DocumentCollection) => {
					const cached = deniedCache.get(def.name);
					if (cached !== undefined) return Effect.succeed(cached);
					return Effect.map(deniedReadFields(def, unscoped), (set) => {
						deniedCache.set(def.name, set);
						return set;
					});
				};
				const results: DocumentBatchResult[] = [];
				for (const outcome of plan.outcomes) {
					if (outcome.kind === "delete") {
						results.push({ op: "delete" });
						continue;
					}
					if (outcome.kind === "replay") {
						// Idempotent-insert hit: project the STORED row like
						// `get` does — lazy migration + read-field stripping.
						const migrated = yield* migrateData(
							outcome.def,
							parseData(outcome.row.data),
							outcome.row.schemaVersion,
							outcome.row.id,
						);
						const denied = yield* deniedFor(outcome.def);
						results.push({
							op: "insert",
							record: projectRecord(
								outcome.def,
								outcome.row,
								migrated.data,
								denied,
							) as DocumentRecord,
						});
						continue;
					}
					const w = outcome.write;
					if (w.dropped) {
						results.push({ op: outcome.op, record: null });
						continue;
					}
					const recordRow = (
						txResults[writeIndex.get(w)!] as DocumentRecordRow[]
					)[0] as DocumentRecordRow;
					const denied = yield* deniedFor(w.def);
					results.push({
						op: outcome.op,
						record: projectRecord(w.def, recordRow, parseData(recordRow.data), denied),
					});
				}
				return results;
			});

		// ---------- telemetry (T-131) ----------

		/** Collection name for span attributes — plugin-defined and
		 * therefore bounded; record ids and payloads never leave the
		 * service boundary into telemetry. */
		const spanCollection = (ref: CollectionRef): string =>
			typeof ref === "string" ? ref : ref.name;

		/** One `documents.<method>` span + op metrics per public call —
		 * mirrors the app-host cqrs/plugin instrumentation: the span
		 * carries bounded attributes (collection name, batch size),
		 * metrics record on EVERY exit via `Effect.exit` and stay
		 * best-effort through `recordSafe`, so telemetry can never fail
		 * the operation. Duration rides the span; the histogram is the
		 * Prometheus RED signal. Single ops (insert/update/delete)
		 * delegate to `runBatch` internally, so wrapping at this level
		 * yields exactly one span per public method — `batch` gets its
		 * own. */
		const instrument = <A, E, R>(
			method: string,
			attributes: Record<string, string | number>,
			self: Effect.Effect<A, E, R>,
		): Effect.Effect<A, E, R> =>
			Effect.gen(function* () {
				const start = yield* Clock.currentTimeMillis;
				const exit = yield* Effect.exit(self);
				const elapsed = (yield* Clock.currentTimeMillis) - start;
				const outcome = Exit.isSuccess(exit) ? "success" : "error";
				yield* recordSafe(tagged(documentStoreOps, { op: method, outcome }), 1);
				yield* recordSafe(tagged(documentStoreOpDuration, { op: method }), elapsed);
				if (Exit.isSuccess(exit)) {
					return exit.value;
				}
				return yield* Effect.failCause(exit.cause);
			}).pipe(Effect.withSpan(`documents.${method}`, { attributes }));

		return DocumentStore.of({
			ensureCollection: (def) =>
				instrument("ensureCollection", { "documents.collection": def.name }, ensureRow(def)),

			insert: <F extends Fields>(
				collection: CollectionRef<F>,
				data: InferInsert<F>,
				ctx?: DocumentStoreContext,
				options?: DocumentWriteOptions,
			) =>
				instrument(
					"insert",
					{ "documents.collection": spanCollection(collection) },
					Effect.map(
						runBatch(
							[
								{
									op: "insert",
									collection,
									data: data as Record<string, unknown>,
									...(options?.idempotencyKey === undefined
										? {}
										: { idempotencyKey: options.idempotencyKey }),
								},
							],
							ctx,
						),
						(rs) =>
							(rs[0] as Extract<DocumentBatchResult, { op: "insert" | "update" }>)
								.record as DocumentRecord<F>,
					),
				),

			get: <F extends Fields>(
				collection: CollectionRef<F>,
				id: number,
				ctx?: DocumentStoreContext,
			) =>
				instrument(
					"get",
					{ "documents.collection": spanCollection(collection) },
					Effect.gen(function* () {
						const ownerId = yield* resolveOwner(ctx);
						const unscoped = ctx?.unscoped === true;
						const { def, row } = yield* resolveDef(collection);
						yield* requireOp(def, "read", unscoped);
						if (row === null) return null;
						const record = yield* scopedRow(row.id, id, ownerId, unscoped);
						if (record === null) return null;
						// Lazy migration (T-130): data is always presented at the
						// current def version; schemaVersion still reports the
						// stored row version.
						const migrated = yield* migrateData(
							def,
							parseData(record.data),
							record.schemaVersion,
							record.id,
						);
						const denied = yield* deniedReadFields(def, unscoped);
						return projectRecord<F>(def, record, migrated.data, denied);
					}),
				),

			find: <F extends Fields>(
				collection: CollectionRef<F>,
				query: FindQuery = {},
				ctx?: DocumentStoreContext,
			) =>
				instrument(
					"find",
					{ "documents.collection": spanCollection(collection) },
					Effect.gen(function* () {
						const ownerId = yield* resolveOwner(ctx);
						const unscoped = ctx?.unscoped === true;
						const { def, row } = yield* resolveDef(collection);
						yield* requireOp(def, "read", unscoped);
						// row === null here means a contributed def with no
						// registry row yet — no records can exist, so the
						// honest answer is an empty page (unknown NAMES
						// already failed inside resolveDef).
						if (row === null) return { rows: [], total: 0 };
						const queryIssues = [
							...(query.filter !== undefined ? validateFilter(query.filter) : []),
							...validateSort(query.sort),
						];
						if (queryIssues.length > 0) {
							return yield* fail(
								new InvalidDocumentQuery({ collection: def.name, issues: queryIssues }),
							);
						}
						const rows = yield* scopedRows(row.id, ownerId, unscoped);
						// Scan-cost signal (T-131): the visible slice size find
						// pays for — recorded before the cap check so capped
						// scans still count.
						yield* recordSafe(
							tagged(documentStoreRows, { op: "find", kind: "scanned" }),
							rows.length,
						);
						// Total-scan cap (T-128): find evaluates in JS over the
						// whole visible slice — past FIND_SCAN_MAX_ROWS the
						// typed error beats a multi-second scan.
						if (rows.length > FIND_SCAN_MAX_ROWS) {
							return yield* fail(
								new InvalidDocumentQuery({
									collection: def.name,
									issues: [`visible rows (${rows.length}) exceed scan cap ${FIND_SCAN_MAX_ROWS}`],
								}),
							);
						}
						// Parse + lazily migrate once per row — filter/sort run
						// over the CURRENT-shape data payload, not the storage
						// row. compileFilter precompiles every $regex ONCE per
						// find (not per row) — see query.ts.
						const prepared = compileFilter(query.filter);
						const parsed = yield* Effect.forEach(rows, (r) =>
							Effect.map(migrateData(def, parseData(r.data), r.schemaVersion, r.id), (m) => ({
								row: r,
								data: m.data,
							})),
						);
						const matched = parsed.filter((p) => matchFilter(p.data, prepared));
						const total = matched.length;
						const byData = compareData(normalizeSort(query.sort));
						matched.sort((a, b) => byData(a.data, b.data));
						const offset = clampOffset(query.offset);
						const limit = clampLimit(query.limit);
						const denied = yield* deniedReadFields(def, unscoped);
						return {
							rows: matched
								.slice(offset, offset + limit)
								.map((p) => projectRecord<F>(def, p.row, p.data, denied)),
							total,
						};
					}),
				),

			update: <F extends Fields>(
				collection: CollectionRef<F>,
				id: number,
				data: Partial<InferInsert<F>>,
				ctx?: DocumentStoreContext,
				options?: DocumentWriteOptions,
			) =>
				instrument(
					"update",
					{ "documents.collection": spanCollection(collection) },
					Effect.map(
						runBatch(
							[
								{
									op: "update",
									collection,
									id,
									data: data as Record<string, unknown>,
									...(options?.expectedVersion === undefined
										? {}
										: { expectedVersion: options.expectedVersion }),
								},
							],
							ctx,
						),
						(rs) =>
							(rs[0] as Extract<DocumentBatchResult, { op: "insert" | "update" }>)
								.record as DocumentRecord<F>,
					),
				),

			delete: <F extends Fields>(
				collection: CollectionRef<F>,
				id: number,
				ctx?: DocumentStoreContext,
			) =>
				instrument(
					"delete",
					{ "documents.collection": spanCollection(collection) },
					Effect.asVoid(runBatch([{ op: "delete", collection, id }], ctx)),
				),

			batch: (ops, ctx) =>
				instrument(
					"batch",
					{ "documents.ops": ops.length },
					Effect.gen(function* () {
						// Batch-size signal (T-131) — counted up front: the
						// ops were submitted regardless of the outcome.
						yield* recordSafe(tagged(documentStoreRows, { op: "batch", kind: "ops" }), ops.length);
						return yield* runBatch(ops, ctx);
					}),
				),

			migrateCollection: (collection, ctx) =>
				instrument(
					"migrateCollection",
					{ "documents.collection": spanCollection(collection) },
					Effect.gen(function* () {
						const ownerId = yield* resolveOwner(ctx);
						const unscoped = ctx?.unscoped === true;
						const { def, row } = yield* resolveDef(collection);
						// Schema migration rewrites stored documents — gate it
						// like any other mutation.
						yield* requireOp(def, "write", unscoped);
						let scanned = 0;
						let migrated = 0;
						const failed: { id: number; reason: string }[] = [];
						if (row !== null) {
							const rows = yield* scopedRows(row.id, ownerId, unscoped);
							const now = new Date();
							for (const r of rows) {
								scanned += 1;
								if (r.schemaVersion >= def.version) continue;
								const outcome = yield* migrateData(
									def,
									parseData(r.data),
									r.schemaVersion,
									r.id,
								).pipe(Effect.result);
								if (Result.isFailure(outcome)) {
									// migrateData fails only with
									// DocumentMigrationError — the cast is its
									// contract, not a guess.
									failed.push({
										id: r.id,
										reason: (outcome.failure as DocumentMigrationError).reason,
									});
									continue;
								}
								if (!outcome.success.applied) continue;
								yield* Effect.promise(() =>
									db
										.update(documentRecords)
										.set({
											data: JSON.stringify(outcome.success.data),
											schemaVersion: def.version,
											updatedAt: now,
										})
										.where(eq(documentRecords.id, r.id)),
								);
								migrated += 1;
							}
						}
						// Sweep telemetry (T-131): rows examined, rewritten and
						// failed — the same counts the report returns.
						yield* recordSafe(
							tagged(documentStoreRows, { op: "migrateCollection", kind: "scanned" }),
							scanned,
						);
						yield* recordSafe(
							tagged(documentStoreRows, { op: "migrateCollection", kind: "migrated" }),
							migrated,
						);
						yield* recordSafe(
							tagged(documentStoreRows, { op: "migrateCollection", kind: "failed" }),
							failed.length,
						);
						return { collection: def.name, scanned, migrated, failed };
					}),
				),
		});
	}),
);

/**
 * Test-only DDL mirroring the document-store migration — same
 * convention as CUSTOM_PAGES_TEST_DDL / I18N_TEST_DDL. Never used by
 * production code. `groups` must exist for the tenant_id FK — tests
 * create a minimal groups stub alongside.
 */
export const DOCUMENT_STORE_TEST_DDL = `
CREATE TABLE document_collections (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	owner_plugin_id TEXT NOT NULL DEFAULT '',
	schema_json TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX document_collections_name_idx ON document_collections (name);
CREATE TABLE document_records (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	collection_id INTEGER NOT NULL REFERENCES document_collections(id) ON DELETE CASCADE,
	data TEXT NOT NULL,
	schema_version INTEGER NOT NULL DEFAULT 1,
	version INTEGER NOT NULL DEFAULT 1,
	owner_id TEXT NOT NULL DEFAULT '',
	tenant_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
	idempotency_key TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX document_records_collection_idx ON document_records (collection_id);
CREATE INDEX document_records_collection_owner_idx ON document_records (collection_id, owner_id);
CREATE INDEX document_records_collection_tenant_idx ON document_records (collection_id, tenant_id);
CREATE UNIQUE INDEX document_records_idempotency_idx ON document_records (collection_id, idempotency_key);
`;
