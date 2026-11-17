import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, eq, isNotNull, or, type SQL } from "drizzle-orm";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, tx, type TxOp } from "@ktb/db";
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
 * dedicated table.
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
	  }
	| {
			readonly op: "update";
			readonly collection: CollectionRef;
			readonly id: number;
			readonly data: Record<string, unknown>;
	  }
	| {
			readonly op: "delete";
			readonly collection: CollectionRef;
			readonly id: number;
	  };

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
	 * the collection row when needed. */
	readonly insert: <F extends Fields>(
		collection: CollectionRef<F>,
		data: InferInsert<F>,
		ctx?: DocumentStoreContext,
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
	 * capped at FIND_SCAN_MAX_ROWS scanned rows. */
	readonly find: <F extends Fields>(
		collection: CollectionRef<F>,
		query?: FindQuery,
		ctx?: DocumentStoreContext,
	) => Effect.Effect<FindResult<F>, DocumentStoreError>;
	/** Merge-patch a record: `data` is validated with `partial: true`
	 * (only present keys are checked; required is not re-asserted) and
	 * merged over the stored document — stored values are re-validated
	 * too, so a schema-tightening deploy fails loudly on old rows.
	 * `unique`/`ref` rules apply to the resulting document. */
	readonly update: <F extends Fields>(
		collection: CollectionRef<F>,
		id: number,
		data: Partial<InferInsert<F>>,
		ctx?: DocumentStoreContext,
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

		// Def caches: contributed defs are static per runtime; DB rows
		// (ensureCollection) are cached and invalidated on upsert.
		const contributed = new Map(collections.collections.map((d) => [d.name, d] as const));
		const registeredDefs = new Map<string, DocumentCollection>();
		const collectionRows = new Map<string, DocumentCollectionRow>();

		const rowFor = (name: string): Effect.Effect<DocumentCollectionRow | null> =>
			Effect.gen(function* () {
				const cached = collectionRows.get(name);
				if (cached !== undefined) return cached;
				const rows = yield* Effect.promise(() =>
					db.select().from(documentCollections).where(eq(documentCollections.name, name)).limit(1),
				);
				const row = (rows[0] as DocumentCollectionRow | undefined) ?? null;
				if (row !== null) collectionRows.set(name, row);
				return row;
			});

		const defFromRow = (row: DocumentCollectionRow): DocumentCollection => {
			const cached = registeredDefs.get(row.name);
			if (cached !== undefined) return cached;
			// schema_json is written by ensureCollection from a
			// DocumentCollection — a parse failure is corruption, so it
			// dies as a defect rather than a typed error.
			const def = JSON.parse(row.schemaJson) as DocumentCollection;
			registeredDefs.set(row.name, def);
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
					collectionRows.set(def.name, row);
					registeredDefs.set(def.name, def);
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
				collectionRows.set(def.name, row);
				registeredDefs.set(def.name, def);
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
			data: Record<string, unknown>;
			/** Set when a later op removes this write (cascade or delete
			 * of the pending doc itself). */
			dropped: boolean;
		}

		/** insert = new row; `id` is the optional explicit primary key
		 * (null = autoincrement — unreachable by id within the batch). */
		interface PendingInsert extends PendingWriteBase {
			readonly kind: "insert";
			readonly id: number | null;
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
				for (const [field, descriptor] of Object.entries(def.fields)) {
					if (descriptor.kind !== "ref") continue;
					const targetId = data[field];
					if (typeof targetId !== "number") continue;
					const targetName = descriptor.collection;
					if (targetName === undefined) {
						return yield* fail(
							new DocumentValidationError({
								collection: def.name,
								issues: [`${field}: ref field missing target collection`],
							}),
						);
					}
					const broken = () =>
						fail(
							new BrokenReference({
								collection: def.name,
								field,
								targetCollection: targetName,
								targetId,
							}),
						);
					// Earlier batch ops win over the committed read: a
					// delete makes the target unreachable even though the
					// row still exists pre-transaction.
					if (plan.rowDeletes.has(targetId)) return yield* broken();
					const pendingTarget = plan.byId.get(targetId);
					if (pendingTarget !== undefined) {
						// Resolvable only when the pending write belongs to
						// the referenced collection — an id is global, so a
						// same-id write of ANOTHER collection is still broken.
						if (pendingTarget.def.name === targetName) continue;
						return yield* broken();
					}
					const target = yield* resolveDef(targetName);
					const targetRow = yield* ensureDefRow(target.def, target.row);
					const targetRecord = yield* scopedRow(targetRow.id, targetId, ownerId, unscoped);
					if (targetRecord === null) return yield* broken();
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
					data: validated.data,
					dropped: false,
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
				if (row === null || plan.rowDeletes.has(op.id)) {
					return yield* fail(new RecordNotFound({ collection: def.name, id: op.id }));
				}
				const pending = plan.byId.get(op.id);
				if (pending !== undefined && pending.collectionId === row.id) {
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
											createdAt: now,
											updatedAt: now,
										})
										.returning()
								: db
										.update(documentRecords)
										.set({
											data: JSON.stringify(w.data),
											schemaVersion: w.def.version,
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
							.set({ data: JSON.stringify(n.data), updatedAt: now })
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

		return DocumentStore.of({
			ensureCollection: (def) => ensureRow(def),

			insert: <F extends Fields>(
				collection: CollectionRef<F>,
				data: InferInsert<F>,
				ctx?: DocumentStoreContext,
			) =>
				Effect.map(
					runBatch([{ op: "insert", collection, data: data as Record<string, unknown> }], ctx),
					(rs) =>
						(rs[0] as Extract<DocumentBatchResult, { op: "insert" | "update" }>)
							.record as DocumentRecord<F>,
				),

			get: <F extends Fields>(
				collection: CollectionRef<F>,
				id: number,
				ctx?: DocumentStoreContext,
			) =>
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

			find: <F extends Fields>(
				collection: CollectionRef<F>,
				query: FindQuery = {},
				ctx?: DocumentStoreContext,
			) =>
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

			update: <F extends Fields>(
				collection: CollectionRef<F>,
				id: number,
				data: Partial<InferInsert<F>>,
				ctx?: DocumentStoreContext,
			) =>
				Effect.map(
					runBatch([{ op: "update", collection, id, data: data as Record<string, unknown> }], ctx),
					(rs) =>
						(rs[0] as Extract<DocumentBatchResult, { op: "insert" | "update" }>)
							.record as DocumentRecord<F>,
				),

			delete: <F extends Fields>(
				collection: CollectionRef<F>,
				id: number,
				ctx?: DocumentStoreContext,
			) => Effect.asVoid(runBatch([{ op: "delete", collection, id }], ctx)),

			batch: (ops, ctx) => runBatch(ops, ctx),

			migrateCollection: (collection, ctx) =>
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
					return { collection: def.name, scanned, migrated, failed };
				}),
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
	owner_id TEXT NOT NULL DEFAULT '',
	tenant_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX document_records_collection_idx ON document_records (collection_id);
CREATE INDEX document_records_collection_owner_idx ON document_records (collection_id, owner_id);
CREATE INDEX document_records_collection_tenant_idx ON document_records (collection_id, tenant_id);
`;
