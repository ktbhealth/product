import { index, integer, sqliteTable, text } from "@ktb/db/table";

/** What the invitee is being let into — picks the copy and where the
 * accept screen leads. */
export const INVITE_KINDS = ["secretary", "patient"] as const;
export type InviteKind = (typeof INVITE_KINDS)[number];

/**
 * Single-use accept links sent in invite emails. A token proves the
 * holder controls `email` (the link was delivered there) and lets them
 * create an account for that address — nothing else: it never signs in
 * to, or verifies, an account that already exists.
 *
 * Only the SHA-256 of the token is stored, so a database read does not
 * yield usable links. What the address was invited *to* stays in the
 * owning plugin's table (`doctor_access`, `patient_access`), keyed by
 * email; this table only carries what the accept screen shows.
 */
export const inviteTokens = sqliteTable(
	"invite_tokens",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		tokenHash: text("token_hash").notNull().unique(),
		/** Invited address, stored lowercased. */
		email: text().notNull(),
		kind: text().$type<InviteKind>().notNull(),
		/** Who sent the invite, as shown to the invitee. */
		inviterName: text("inviter_name").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		/** Set once the link created its account; a consumed link is dead. */
		consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("invite_tokens_email_idx").on(table.email)],
);

export type InviteToken = typeof inviteTokens.$inferSelect;
