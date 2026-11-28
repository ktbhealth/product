import * as Effect from "effect/Effect";
import type { SQL } from "drizzle-orm";

import { consultations } from "@ktb/db/schema";
import { Forbidden } from "@ktb/authz";
import type { PermissionsShape } from "@ktb/rbac";
import { platformAdminAdmits, type PlatformAdminShape } from "@ktb/platform";
import { tenantIdAccessible, tenantRowScope } from "@ktb/tenant";

/**
 * Owner-scoped authz that a platform admin may override — same pattern
 * as the patients plugin: regular principals must own the row,
 * allowlisted admins pass either way.
 */
const orPlatformAdmin = (
	platformAdmin: PlatformAdminShape,
	check: Effect.Effect<void, Forbidden>,
) =>
	check.pipe(
		Effect.catchTag("Forbidden", (err) =>
			platformAdmin.requireAdmin().pipe(Effect.catchTag("Forbidden", () => Effect.fail(err))),
		),
	);

/** True when the bound principal is a platform admin (never throws). */
export const isPlatformAdmin = (platformAdmin: PlatformAdminShape) =>
	platformAdminAdmits(platformAdmin);

/**
 * Tenant visibility fence (P-053-B) — same model as the patients
 * plugin, built on the shared `tenantRowScope` kit: a consultation row
 * is visible to the caller when the tenant fence admits it
 * (`tenant_id` NULL or in the caller's accessible tenant set —
 * `Tenant`/`TenantAccess`) AND it is either a personal row they own
 * (`user_id` = caller, `tenant_id` NULL) or a tenant-owned row
 * (`tenant_id` NOT NULL — membership already proved by the fence).
 * Personal scope degrades to "own personal rows only".
 */
export const consultationScope = (userId: string): Effect.Effect<SQL> =>
	// and() types as SQL|undefined but the fence is always a fragment.
	Effect.map(tenantRowScope(consultations, consultations.userId, userId), (scope) => scope as SQL);

/**
 * Row-level authz (P-053-B). Tenant-owned rows (`tenant_id` set) are
 * governed by tenant membership: any member of the row's tenant may
 * read/operate it — `userId` stays creator attribution and is NOT an
 * access grant outside the tenant. Everyone else needs the
 * platform-admin override, which works cross-tenant. Personal rows
 * (`tenant_id` NULL) keep the owner-scoped check — now a
 * relation-tuple lookup (T-182): `consultation:<id>#owner@user:<caller>`,
 * the same fence the retired permix `userId === principal.userId` rule
 * enforced. A missing `Permissions` port (rbac plugin not composed)
 * fails closed with the same `rbac.<type>.<id>.<relation>` path
 * `requireObject` reports.
 */
export const authorizeConsultationRow = (
	platformAdmin: PlatformAdminShape,
	permissions: PermissionsShape | null,
	row: { readonly id: number; readonly tenantId: number | null },
	action: "consultation.read" | "consultation.update" | "consultation.delete",
) =>
	Effect.gen(function* () {
		if (row.tenantId !== null) {
			if (yield* tenantIdAccessible(row.tenantId)) return;
			yield* platformAdmin
				.requireAdmin()
				.pipe(Effect.catchTag("Forbidden", () => Effect.fail(new Forbidden({ path: action }))));
			return;
		}
		const check =
			permissions === null
				? Effect.fail(new Forbidden({ path: `rbac.consultation.${row.id}.owner` }))
				: permissions.requireObject("consultation", String(row.id), "owner");
		yield* orPlatformAdmin(platformAdmin, check);
	});
