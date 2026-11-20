import { index, integer, sqliteTable, text } from "@ktb/db/table";

// Plugin-owned table definitions (P-061): aggregated into the drizzle
// schema by the generated packages/db/src/schema.gen.ts — consumers
// keep importing them from `@ktb/db/schema` (or `@ktb/rbac-plugin/schema`).

/**
 * Role metadata registry (P-054): named, runtime-managed bundles of
 * (resource, action, effect) grants assignable to users and groups.
 * Grants and memberships live exclusively in `relation_tuples` (P-101)
 * — this table carries only what tuples cannot: the role's
 * description and the `meta` JSON payload (app-defined role
 * templates/attributes). A role's grants are the tuples
 * `(<resource>,'*',<action>,'role',<name>)`; its members are
 * `('role',<name>,'member',<subject>)`.
 */
export const roles = sqliteTable("roles", {
	id: integer().primaryKey({ autoIncrement: true }),
	name: text().notNull().unique(),
	description: text(),
	meta: text(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
});

/**
 * Zanzibar-style relation tuples (P-101): the ONLY grant store — the
 * permission resolver and the RBAC admin repo fns both read/write
 * here (the legacy `role_permissions`/`subject_roles` tables were
 * dropped in migration 0063). Two encodings coexist:
 *
 * - role grant: `objectType` = resource ("patient", "platform", …),
 *   `objectId` = "*" wildcard, `relation` = action ("read",
 *   "messages.read", …), `subjectKind` = "role",
 *   `subjectId` = the role NAME (names are unique — tuples survive
 *   role id changes and read naturally);
 * - role membership: `objectType` = "role", `objectId` = role name,
 *   `relation` = "member", subject = the assignee ("user"/"group").
 *
 * NO foreign keys — object and subject are polymorphic strings by
 * design. `tenantId` NULL = global, set = tenant-scoped (same
 * semantics the dropped `subject_roles.tenant_id` had); `effect`
 * "deny" wins at resolve time. Natural-key uniqueness is enforced by
 * the write path, not the schema (NULLs are distinct in SQLite
 * unique indexes).
 */
export const relationTuples = sqliteTable(
	"relation_tuples",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		objectType: text("object_type").notNull(),
		objectId: text("object_id").notNull(),
		relation: text().notNull(),
		subjectKind: text("subject_kind").notNull(),
		subjectId: text("subject_id").notNull(),
		effect: text().notNull(),
		tenantId: text("tenant_id"),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		grantedBy: text("granted_by"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		// Resolution looks tuples up by object; the subject index
		// serves "what can this subject do" walks. The natural-key
		// index backs the write path's find-then-write upserts.
		index("relation_tuples_object_idx").on(table.objectType, table.objectId, table.relation),
		index("relation_tuples_subject_idx").on(table.subjectKind, table.subjectId),
		index("relation_tuples_natural_idx").on(
			table.objectType,
			table.objectId,
			table.relation,
			table.subjectKind,
			table.subjectId,
		),
	],
);

/**
 * Single-row permission epoch counter (id = 1). Bumped on every write
 * to `relation_tuples` / group-membership-affecting tables; cached
 * grant sets are keyed by it so changes propagate on the next resolve
 * without explicit purging.
 */
export const permissionEpoch = sqliteTable("permission_epoch", {
	id: integer().primaryKey(),
	epoch: integer().notNull().default(0),
});

export type Role = typeof roles.$inferSelect;
export type PermissionEpoch = typeof permissionEpoch.$inferSelect;
export type RelationTuple = typeof relationTuples.$inferSelect;
