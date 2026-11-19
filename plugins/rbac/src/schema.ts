import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

// Plugin-owned table definitions (P-061): aggregated into the drizzle
// schema by the generated packages/db/src/schema.gen.ts — consumers
// keep importing them from `@ktb/db/schema` (or `@ktb/rbac-plugin/schema`).

/**
 * Dynamic roles (P-054): named, runtime-managed bundles of
 * (resource, action, effect) grants assignable to users and groups.
 * `meta` is an optional JSON payload stored as text — app-defined
 * role templates/attributes live there.
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
 * Permission grants per role. `resource`/`action` are flat vocabulary
 * strings (see @ktb/rbac/vocabulary); `effect` is "allow" or "deny" —
 * deny always wins at resolution time. The package validates shape, not
 * meaning: apps own the vocabulary.
 */
export const rolePermissions = sqliteTable(
	"role_permissions",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		roleId: integer("role_id")
			.notNull()
			.references(() => roles.id, { onDelete: "cascade" }),
		resource: text().notNull(),
		action: text().notNull(),
		effect: text().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("role_permissions_role_resource_action_idx").on(
			table.roleId,
			table.resource,
			table.action,
		),
	],
);

/**
 * Role assignments. `subjectKind` is "user" or "group" (group
 * resolution goes through the `GroupMembership` port — this package
 * never imports a groups plugin). `tenantId` NULL = global grant;
 * set = grant applies only inside that tenant (P-053). `expiresAt`
 * NULL = never expires; evaluated at resolve time.
 *
 * NOTE: `tenant_id` participates in no unique index — NULLs are
 * distinct in SQLite, so global-grant uniqueness is enforced by the
 * write path (`assignSubject`), not the schema.
 */
export const subjectRoles = sqliteTable(
	"subject_roles",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		subjectKind: text("subject_kind").notNull(),
		subjectId: text("subject_id").notNull(),
		roleId: integer("role_id")
			.notNull()
			.references(() => roles.id, { onDelete: "cascade" }),
		tenantId: text("tenant_id"),
		grantedBy: text("granted_by"),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		// Resolution looks up assignments by subject; uniqueness of a
		// (subject, role, tenant) triple is enforced by the write path.
		index("subject_roles_subject_idx").on(table.subjectKind, table.subjectId),
	],
);

/**
 * Zanzibar-style relation tuples (P-101): the grant graph the
 * permission resolver reads. `role_permissions`/`subject_roles` stay
 * the admin-facing store; every write dual-writes here so the two
 * never drift. Two encodings coexist:
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
 * semantics as `subject_roles.tenant_id`); `effect` "deny" wins at
 * resolve time. Like `subject_roles`, natural-key uniqueness is
 * enforced by the write path, not the schema (NULLs are distinct in
 * SQLite unique indexes).
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
 * to role_permissions / subject_roles / group-membership-affecting
 * tables; cached grant sets are keyed by it so changes propagate on
 * the next resolve without explicit purging.
 */
export const permissionEpoch = sqliteTable("permission_epoch", {
	id: integer().primaryKey(),
	epoch: integer().notNull().default(0),
});

export type Role = typeof roles.$inferSelect;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type SubjectRole = typeof subjectRoles.$inferSelect;
export type PermissionEpoch = typeof permissionEpoch.$inferSelect;
export type RelationTuple = typeof relationTuples.$inferSelect;
