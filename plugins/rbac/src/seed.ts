import { eq } from "drizzle-orm";

import { insertAuditEntry } from "@ktb/audit";
import type { DbClient } from "@ktb/db";
import { bumpEpoch, PERMISSION_CATALOG, rolePermissions, roles, splitPermission } from "@ktb/rbac";

/**
 * Built-in superadmin role: a role named `superadmin` carrying an
 * `allow` grant for EVERY catalog permission — entity actions and
 * platform actions alike. Assigning it to a user (RBAC console →
 * subject assignment) makes the platform-admin gate admit them through
 * the RBAC `grantFor` hook, which is what "access to everything" keys
 * on.
 *
 * The seed runs at service-layer build and is create-only: it inserts
 * the role plus its full grant set when the name is absent, then
 * bumps the permission epoch and writes a system-actor audit row.
 * An existing `superadmin` role is left untouched — grants an admin
 * revoked stay revoked. The result distinguishes the two "exists"
 * cases so the caller can warn when a HAND-MADE role squats the name
 * (it keeps its own permission set and the seed never repairs it —
 * rename or delete it to hand the name back to the system role).
 */
export const SUPERADMIN_ROLE_NAME = "superadmin";

export type SuperadminSeedResult = "created" | "exists" | "custom";

export async function ensureSuperadminRole(db: DbClient): Promise<SuperadminSeedResult> {
	const existing = await db
		.select({ id: roles.id, meta: roles.meta })
		.from(roles)
		.where(eq(roles.name, SUPERADMIN_ROLE_NAME));
	const found = existing[0];
	if (found !== undefined) {
		// meta {"system":true} marks the seed-created role; anything
		// else under this name is an operator-owned role the seed
		// must not touch — surfaced as "custom" for a boot warning.
		const system = (() => {
			try {
				return (JSON.parse(found.meta ?? "") as { system?: unknown }).system === true;
			} catch {
				return false;
			}
		})();
		return system ? "exists" : "custom";
	}
	// onConflictDoNothing covers a concurrent boot racing the same
	// seed — the unique name index picks one winner, then we re-read.
	const created = await db
		.insert(roles)
		.values({
			name: SUPERADMIN_ROLE_NAME,
			description: "Built-in superuser — every catalog permission",
			meta: JSON.stringify({ system: true }),
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.onConflictDoNothing()
		.returning({ id: roles.id });
	const roleId = created[0]?.id;
	/* v8 ignore next -- losing the insert race means the other boot owns the seed */
	if (roleId === undefined) return "exists";
	const now = new Date();
	await db.insert(rolePermissions).values(
		PERMISSION_CATALOG.map((key) => {
			const { resource, action } = splitPermission(key);
			return { roleId, resource, action, effect: "allow", createdAt: now };
		}),
	);
	// New grants change resolution — bump so cached grant sets re-resolve.
	await bumpEpoch(db);
	// System-actor audit row (null principal fields) — best-effort:
	// schemas without admin_audit (partial test DDLs) must not fail
	// an otherwise committed seed.
	try {
		await insertAuditEntry(db, {
			action: "rbac.role.seed",
			targetType: "role",
			targetId: roleId,
			detail: { system: true, grantCount: PERMISSION_CATALOG.length },
			actorUserId: null,
			actorEmail: null,
		});
	} catch {
		// admin_audit absent — the role and grants are already committed.
	}
	return "created";
}
