import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";

import { Principal } from "@ktb/authz";
import { Db } from "@ktb/db";
import { tenantScopeCondition, tenantScopeId, Tenant } from "@ktb/tenant";

import { assertCollectionDef, DocumentCollections, type DocumentCollection } from "./collection.ts";
import type { Fields, InferInsert, InferRecord } from "./fields.ts";
import {
	clampLimit,
	clampOffset,
	compileFilter,
	compareData,
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
 * invisible to user callers (fail closed). This is row-level fencing,
 * NOT authz: plugins decide WHO may call (PlatformAdmin, Permissions,
 * audience gates) exactly like every other service.
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

export type DocumentStoreError =
	| UnknownCollection
	| DocumentValidationError
	| InvalidDocumentQuery
	| RecordNotFound
	| DuplicateFieldValue
	| BrokenReference
	| DocumentInUse;

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
 * field map (`InferRecord`). */
export interface DocumentRecord<F extends Fields = Fields> {
	readonly id: number;
	readonly collectionId: number;
	readonly collection: string;
	readonly data: InferRecord<F>;
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
	 * [1, 500] (default 100), `offset` to ≥ 0. */
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
	 * `nullify` rewrites the field to `null`). Best-effort and
	 * scope-bound: only references inside the caller's visible scope of
	 * the referencing collection are seen — cross-scope references are
	 * ignored (documented v1 limitation). Cascade is one level deep (no
	 * recursion). */
	readonly delete: <F extends Fields>(
		collection: CollectionRef<F>,
		id: number,
		ctx?: DocumentStoreContext,
	) => Effect.Effect<void, DocumentStoreError>;
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

const toRecord = <F extends Fields>(
	row: DocumentRecordRow,
	collectionName: string,
): DocumentRecord<F> => ({
	id: row.id,
	collectionId: row.collectionId,
	collection: collectionName,
	data: parseData(row.data) as InferRecord<F>,
	ownerId: row.ownerId,
	tenantId: row.tenantId,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const fail = (error: DocumentStoreError): Effect.Effect<never, DocumentStoreError> =>
	Effect.fail(error);

export const DocumentStoreLive = Layer.effect(
	DocumentStore,
	Effect.gen(function* () {
		const db = yield* Db;
		const collections = yield* DocumentCollections;

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
				const schemaJson = JSON.stringify(def);
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

		/** Validate `ref` targets: every non-null ref value must point at
		 * an existing record inside the caller's visible scope of the
		 * TARGET collection (auto-registering the target row when the
		 * target is contributed but not yet registered). Re-checks ALL
		 * ref fields on every write — update passes the merged
		 * document, so untouched refs are re-validated too (a target
		 * deleted out-of-band since the last write fails loudly). */
		const checkRefs = (
			def: DocumentCollection,
			data: Record<string, unknown>,
			ownerId: string,
			unscoped: boolean,
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
					const target = yield* resolveDef(targetName);
					const targetRow = yield* ensureDefRow(target.def, target.row);
					const targetRecord = yield* scopedRow(targetRow.id, targetId, ownerId, unscoped);
					if (targetRecord === null) {
						return yield* fail(
							new BrokenReference({
								collection: def.name,
								field,
								targetCollection: targetName,
								targetId,
							}),
						);
					}
				}
			});

		/** Enforce `unique: true` fields within the record's uniqueness
		 * bucket — tenant rows unique per tenant_id, personal rows per
		 * (tenant NULL + owner_id). v1 scans the bucket in JS. */
		const checkUnique = (
			def: DocumentCollection,
			collectionId: number,
			data: Record<string, unknown>,
			ownerId: string,
			tenantId: number | null,
			excludeId: number | undefined,
			unscoped: boolean,
		): Effect.Effect<void, DocumentStoreError> =>
			Effect.gen(function* () {
				const uniqueFields = Object.entries(def.fields).filter(([, d]) => d.unique === true);
				if (uniqueFields.length === 0) return;
				const all = yield* scopedRows(collectionId, ownerId, unscoped);
				// Uniqueness bucket: tenant rows are unique per exact
				// tenant_id (an accessible-set read may span several
				// tenants — they must not collide); personal rows per
				// (tenant NULL + owner_id).
				const bucket = all.filter((r) => {
					if (excludeId !== undefined && r.id === excludeId) return false;
					if (tenantId !== null) return r.tenantId === tenantId;
					return r.tenantId === null && r.ownerId === ownerId;
				});
				for (const [field] of uniqueFields) {
					const value = data[field];
					if (value === undefined) continue;
					for (const row of bucket) {
						// Field names are top-level keys — read the literal
						// stored key (a dotted name would be stored literally
						// too, so this stays consistent with validate.ts).
						const otherValue = parseData(row.data)[field];
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

		return DocumentStore.of({
			ensureCollection: (def) => ensureRow(def),

			insert: <F extends Fields>(
				collection: CollectionRef<F>,
				data: InferInsert<F>,
				ctx?: DocumentStoreContext,
			) =>
				Effect.gen(function* () {
					const ownerId = yield* resolveOwner(ctx);
					const unscoped = ctx?.unscoped === true;
					const tenant = yield* Tenant;
					const tenantId = tenantScopeId(tenant);
					const { def, row } = yield* resolveDef(collection);
					const targetRow = yield* ensureDefRow(def, row);
					const validated = validateDocumentData(def.fields, data);
					if (!validated.ok) {
						return yield* fail(
							new DocumentValidationError({ collection: def.name, issues: validated.issues }),
						);
					}
					yield* checkRefs(def, validated.data, ownerId, unscoped);
					yield* checkUnique(
						def,
						targetRow.id,
						validated.data,
						ownerId,
						tenantId,
						undefined,
						unscoped,
					);
					const now = new Date();
					const rows = yield* Effect.promise(() =>
						db
							.insert(documentRecords)
							.values({
								collectionId: targetRow.id,
								data: JSON.stringify(validated.data),
								ownerId,
								tenantId,
								createdAt: now,
								updatedAt: now,
							})
							.returning(),
					);
					return toRecord<F>(rows[0] as DocumentRecordRow, def.name);
				}),

			get: <F extends Fields>(
				collection: CollectionRef<F>,
				id: number,
				ctx?: DocumentStoreContext,
			) =>
				Effect.gen(function* () {
					const ownerId = yield* resolveOwner(ctx);
					const unscoped = ctx?.unscoped === true;
					const { def, row } = yield* resolveDef(collection);
					if (row === null) return null;
					const record = yield* scopedRow(row.id, id, ownerId, unscoped);
					return record === null ? null : toRecord<F>(record, def.name);
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
					// Parse once — filter/sort run over the data payload,
					// not the storage row. compileFilter precompiles every
					// $regex ONCE per find (not per row) — see query.ts.
					const prepared = compileFilter(query.filter);
					const parsed = rows.map((r) => ({ row: r, data: parseData(r.data) }));
					const matched = parsed.filter((p) => matchFilter(p.data, prepared));
					const total = matched.length;
					const byData = compareData(normalizeSort(query.sort));
					matched.sort((a, b) => byData(a.data, b.data));
					const offset = clampOffset(query.offset);
					const limit = clampLimit(query.limit);
					return {
						rows: matched.slice(offset, offset + limit).map((p) => toRecord<F>(p.row, def.name)),
						total,
					};
				}),

			update: <F extends Fields>(
				collection: CollectionRef<F>,
				id: number,
				data: Partial<InferInsert<F>>,
				ctx?: DocumentStoreContext,
			) =>
				Effect.gen(function* () {
					const ownerId = yield* resolveOwner(ctx);
					const unscoped = ctx?.unscoped === true;
					const { def, row } = yield* resolveDef(collection);
					const existing = row === null ? null : yield* scopedRow(row.id, id, ownerId, unscoped);
					if (existing === null || row === null) {
						return yield* fail(new RecordNotFound({ collection: def.name, id }));
					}
					const merged = { ...parseData(existing.data), ...data };
					const validated = validateDocumentData(def.fields, merged, { partial: true });
					if (!validated.ok) {
						return yield* fail(
							new DocumentValidationError({ collection: def.name, issues: validated.issues }),
						);
					}
					yield* checkRefs(def, validated.data, ownerId, unscoped);
					yield* checkUnique(def, row.id, validated.data, ownerId, existing.tenantId, id, unscoped);
					const rows = yield* Effect.promise(() =>
						db
							.update(documentRecords)
							.set({ data: JSON.stringify(validated.data), updatedAt: new Date() })
							.where(eq(documentRecords.id, id))
							.returning(),
					);
					return toRecord<F>(rows[0] as DocumentRecordRow, def.name);
				}),

			delete: <F extends Fields>(
				collection: CollectionRef<F>,
				id: number,
				ctx?: DocumentStoreContext,
			) =>
				Effect.gen(function* () {
					const ownerId = yield* resolveOwner(ctx);
					const unscoped = ctx?.unscoped === true;
					const { def, row } = yield* resolveDef(collection);
					const existing = row === null ? null : yield* scopedRow(row.id, id, ownerId, unscoped);
					if (existing === null || row === null) {
						return yield* fail(new RecordNotFound({ collection: def.name, id }));
					}
					// ref onDelete policies — best-effort and scope-bound:
					// only references inside the caller's visible scope of the
					// REFERENCING collection are seen (documented v1
					// limitation — cross-scope refs are invisible to every
					// policy, including restrict).
					const defs = yield* allDefs;
					const referencedBy: string[] = [];
					const cascades: { collectionId: number; ids: number[] }[] = [];
					const nullifies: { row: DocumentRecordRow; field: string; def: DocumentCollection }[] =
						[];
					for (const other of defs) {
						const otherRow = yield* rowFor(other.name);
						if (otherRow === null) continue;
						for (const [field, descriptor] of Object.entries(other.fields)) {
							if (descriptor.kind !== "ref" || descriptor.collection !== def.name) continue;
							const policy = descriptor.onDelete ?? "restrict";
							const candidates = yield* scopedRows(otherRow.id, ownerId, unscoped);
							const hits = candidates.filter((r) => parseData(r.data)[field] === id);
							if (hits.length === 0) continue;
							if (policy === "restrict") {
								referencedBy.push(`${other.name}.${field}`);
							} else if (policy === "cascade") {
								cascades.push({ collectionId: otherRow.id, ids: hits.map((h) => h.id) });
							} else {
								for (const hit of hits) {
									nullifies.push({ row: hit, field, def: other });
								}
							}
						}
					}
					if (referencedBy.length > 0) {
						return yield* fail(new DocumentInUse({ collection: def.name, id, referencedBy }));
					}
					for (const target of nullifies) {
						const data = parseData(target.row.data);
						// Ref fields are top-level field names — the stored
						// document carries them as literal keys.
						data[target.field] = null;
						// Re-validate the patched document before writing —
						// a row whose stored data no longer satisfies the
						// (possibly tightened) schema is skipped
						// (best-effort) rather than written invalid.
						const validated = validateDocumentData(target.def.fields, data, {
							partial: true,
						});
						if (!validated.ok) continue;
						yield* Effect.promise(() =>
							db
								.update(documentRecords)
								.set({ data: JSON.stringify(validated.data), updatedAt: new Date() })
								.where(eq(documentRecords.id, target.row.id)),
						);
					}
					for (const target of cascades) {
						yield* Effect.promise(() =>
							db
								.delete(documentRecords)
								.where(
									and(
										eq(documentRecords.collectionId, target.collectionId),
										inArray(documentRecords.id, target.ids),
									),
								),
						);
					}
					yield* Effect.promise(() => db.delete(documentRecords).where(eq(documentRecords.id, id)));
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
	owner_id TEXT NOT NULL DEFAULT '',
	tenant_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX document_records_collection_idx ON document_records (collection_id);
CREATE INDEX document_records_collection_owner_idx ON document_records (collection_id, owner_id);
CREATE INDEX document_records_collection_tenant_idx ON document_records (collection_id, tenant_id);
`;
