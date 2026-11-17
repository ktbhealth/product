import { integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

/**
 * Generic groups: clinics, orgs, cohorts or any custom grouping. `kind`
 * is free-form; `meta` is an optional JSON payload stored as text.
 *
 * Plugin-owned table definition (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts, so consumers
 * keep importing it from `@ktb/db/schema` (or `@ktb/groups/schema`).
 */
export const groups = sqliteTable("groups", {
	id: integer().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	slug: text().notNull().unique(),
	kind: text().notNull(),
	meta: text(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
	// Zero-knowledge flag (PL-007 F2, T-142): ZK tenants encrypt all
	// record content client-side via the clinic keyring (`@ktb/vault`);
	// non-ZK tenants keep today's plaintext flow during migration.
	// Declared last so the migration is a plain ALTER TABLE ADD COLUMN.
	zk: integer("zk", { mode: "boolean" }).notNull().default(false),
});

/**
 * Group membership — polymorphic `memberKind`/`memberId` pair
 * ("user" today, "patient" later). One row per (group, member).
 */
export const groupMembers = sqliteTable(
	"group_members",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		groupId: integer("group_id")
			.notNull()
			.references(() => groups.id, { onDelete: "cascade" }),
		memberKind: text("member_kind").notNull(),
		memberId: text("member_id").notNull(),
		role: text(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("group_members_group_member_idx").on(
			table.groupId,
			table.memberKind,
			table.memberId,
		),
	],
);
