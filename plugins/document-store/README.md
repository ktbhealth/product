# @ktb/document-store

Runtime document store for plugin-contributed data collections (P-089).
Collections are declared as **data** — a `defineCollection` def riding a
`document.collection` contribution — and records live in
`document_records` as schema-validated JSON with JS-side `find` queries,
schema migrations, RBAC gates, batch writes, optimistic concurrency and
idempotency keys. See the module docstrings in `src/service.ts` and
`src/collection.ts` for the full contract.

## When to use — and when NOT to

**Use it for** plugin-contributed or extensible data whose shape evolves
without a deploy of typed schema: clinic custom fields, intake-form-like
records, specialty-pack data, per-tenant configuration blobs that need
structured queries.

**Do NOT use it for:**

- Hot list paths — `find` evaluates filters/sorts in JS over every
  in-scope row. ~17ms at 1k docs, ~35–45ms at the 10k scan ceiling
  (measured in `src/benchmark.test.ts`; D1 may be slower).
- SQL aggregates/joins, or anything needing DB-level constraints,
  indexes or FK cascades — `unique`/`ref` are application-level scans,
  and declared `indexes` are advisory metadata only (they create no SQL
  indexes).
- High-write streams or collections approaching ~10k docs in one
  tenant/owner scope — past `FIND_SCAN_MAX_ROWS` (10,000) `find` fails
  `InvalidDocumentQuery` rather than scanning unboundedly.
- Payloads over 64KB serialized (`MAX_DOCUMENT_BYTES`) — bigger data
  belongs in dedicated storage.

### kv vs documents vs typed tables

| store          | use for                                                      |
| -------------- | ------------------------------------------------------------ |
| `@ktb/kv`      | single-key state, TTL'd values, counters — no queries        |
| document-store | structured, queryable collections declared as data           |
| typed drizzle  | hot paths, relational data, SQL constraints/joins/aggregates |

## Quickstart

A plugin contributes a collection by adding one entry to its manifest's
generic `contributions` array — no kernel changes needed:

```ts
import { defineCollection, documentCollectionContribution, f } from "@ktb/document-store";

export const clinicCustomFields = defineCollection({
	name: "clinic.custom-fields",
	version: 1,
	fields: {
		label: f.string({ required: true, maxLength: 120 }),
		kind: f.enum(["text", "number", "date"] as const),
		options: f.json(),
		ownerId: f.string({ unique: true }),
	},
	indexes: ["ownerId"], // advisory only — see CollectionIndex
	permissions: { read: "clinic.read", write: "clinic.write" },
});

export const myPlugin = definePlugin({
	id: "my-plugin",
	// …
	contributions: [documentCollectionContribution(clinicCustomFields)],
});
```

Field names are top-level `data` keys (`/^[A-Za-z_][A-Za-z0-9_]*$/`,
`__proto__`/`constructor`/`prototype` rejected); collection names match
`/^[a-z][a-z0-9._-]{0,99}$/` and must be unique across contributors
(duplicates throw at composition).

`@ktb/app-host` collects every contributed def once at startup
(`collectDocumentCollections` over the topo-ordered registry) and
provides them as `DocumentCollections`; `DocumentStoreLive`
(`document-store.services` plugin) resolves defs by name at call time —
pass the typed `DocumentCollection` def itself as `collection` to keep
`InferInsert`/`InferRecord` precise, or the name string when only the
registry is in scope.

Declare `requiredDeps: ["document-store.services"]` (or the
`documentStoreServicesPlugin.id` import) on any plugin that calls
`DocumentStore` from routes/CQRS. Ordering vs `document-store.admin` is
handled by the store's own `optionalDeps` on rbac — permissioned
collections need `rbacServicesPlugin` installed or they fail closed.

## Field DSL (`f.*`)

`string` (minLength/maxLength/pattern), `number` (min/max), `boolean`,
`date` (**epoch ms**, finite number), `enum(values)`, `json`,
`array(of, {minLength/maxLength})`, `ref({collection, onDelete})`.
Shared options: `required`, `default` (JSON), `unique`. Types infer via
`InferInsert<F>` / `InferRecord<F>` — `f.*` builders keep literals
precise for that.

`ref` targets another collection; `onDelete` is `restrict` (default —
fails `DocumentInUse`), `cascade` or `nullify`. Scope-bound and
best-effort: only references inside the caller's visible scope are seen;
cascade is one level deep, no recursion.

## Query operators (`find`)

```ts
const result =
	yield *
	store.find(def, {
		filter: {
			status: "active", // literal = $eq
			"meta.score": { $gte: 10, $lt: 90 }, // dotted paths walk JSON
			ownerId: { $in: ["a", "b"] },
			archivedAt: { $exists: false },
			note: { $regex: "^follow" }, // case-sensitive, ≤200 chars
			$or: [{ kind: "text" }, { kind: "date" }],
			$and: [{ "meta.score": { $gt: 0 } }],
		},
		sort: [{ field: "updatedAt", dir: "desc" }, "label"],
		limit: 50, // clamps to [1, 500], default 100
		offset: 0,
	});
// result.rows: DocumentRecord<F>[]; result.total: matches before paging
```

Operators: `$eq $ne $gt $gte $lt $lte $in $nin $exists $regex`, plus
`$and`/`$or` arrays (may mix with field conditions; implicit AND across
keys). Missing values sort last; the sort is stable. Filters are
structurally bounded (`MAX_FILTER_DEPTH` 8, `MAX_FILTER_NODES` 100) and
`$regex` patterns reject nested quantifiers/quantified alternations
(ReDoS heuristics) — violations fail `InvalidDocumentQuery` before any
row is scanned.

## Permissions

Collections fence rows by tenant/owner scope automatically (tenant rows
visible to tenant members; personal rows only to `owner_id`). Add an
optional `permissions` block for grant-level RBAC:

```ts
permissions: {
	read: "clinic.read",              // string or string[] (ANY-of)
	write: "clinic.write",
	delete: ["clinic.admin", "clinic.write"],
	fields: {
		options: { read: "clinic.admin" },  // whole-field allow/deny
	},
}
```

`"resource.action"` splits at the FIRST dot (`"i18n.messages.read"` →
resource `i18n`, action `messages.read`) — collection names with dots
stay inside the action segment. Absent `permissions` = fencing only.
Absent `Permissions` service with a permissioned collection = fail
closed. `ctx.unscoped` system flows bypass checks (already gated by
PlatformAdmin). See `CollectionPermissions` in `src/collection.ts`.

## Writes, concurrency, idempotency

- `insert` / `update` (merge-patch) / `delete` / `get` / `find` /
  `batch` / `migrateCollection` — all take an optional
  `DocumentStoreContext` (`ownerId`, `unscoped`; see the IDOR warning on
  the type — system flows only).
- `batch(ops)` runs all ops in ONE transaction — any failure aborts
  everything. `ref`s may target an earlier batch `insert`'s explicit
  `id`; autoincrement ids are unreferenceable until commit.
- Optimistic concurrency: `update(..., { expectedVersion })` is
  If-Match — mismatch fails `DocumentVersionConflict` with the actual
  version. `insert(..., { idempotencyKey })` replays the existing
  record on retry; keys are collection-global across scopes (namespace
  them yourself).
- Schema migrations (T-130): bump `version` and declare pure
  `migrations: [{from, to, migrate}]` steps — lazy on read, or eager
  via `migrateCollection`. Steps are code, stripped from `schema_json`;
  a def reconstructed from the DB row alone has none.

## Limits

| bound                     | value         | behavior                                 |
| ------------------------- | ------------- | ---------------------------------------- |
| `FIND_SCAN_MAX_ROWS`      | 10,000        | `find` fails `InvalidDocumentQuery` past |
| `FIND_LIMIT_MAX`          | 500           | `limit` clamps                           |
| `MAX_DOCUMENT_BYTES`      | 64 KB         | insert/update fail `DocumentTooLarge`    |
| collection registry cache | 128 × 15s TTL | per-isolate; records never cached        |

## Graduating to a typed table (escape hatch)

When a collection outgrows the store — hot reads, joins, aggregates,
DB-level constraints — promote it to a typed drizzle table:

1. Declare the table in the owning plugin's `src/schema.ts` (tables
   ride the manifest's `tables` contribution; `bun run gen:db-schema`
   regenerates `packages/db/src/schema.gen.ts` — never hand-edit it),
   then `db:generate` for the migration.
2. Export the documents (a script or a one-off `DocumentStoreAdmin`-style
   sweep over `document_records`).
3. Backfill the new table, dual-write or cut reads over.
4. Drop the collection def/contribution once nothing reads it.

Keep the field DSL as the contract while both exist — `InferFields`
already gives you the TS types to mirror in the drizzle schema.
