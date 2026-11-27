import * as Effect from "effect/Effect";
import { and, eq, isNotNull, or, type SQL } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { consultations } from "@ktb/db/schema";
import { Forbidden } from "@ktb/authz";
import type { PermissionsShape } from "@ktb/rbac";
import { platformAdminAdmits, type PlatformAdminShape } from "@ktb/platform";
import { accessibleTenantIds, tenantScopeCondition } from "@ktb/tenant";
import { tenantIsZk } from "@ktb/vault";

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
 * plugin. A consultation row is visible to the caller when the
 * `tenantScopeCondition` fence admits it (`tenant_id` NULL or in the
 * caller's accessible tenant set — `Tenant`/`TenantAccess`) AND it is
 * either a personal row they own (`user_id` = caller, `tenant_id`
 * NULL) or a tenant-owned row (`tenant_id` NOT NULL — membership
 * already proved by the fence). Personal scope degrades to "own
 * personal rows only".
 */
export const consultationScope = (userId: string) =>
	Effect.map(
		tenantScopeCondition(consultations),
		(fence) =>
			// and() types as SQL|undefined but the fence is always a fragment.
			and(fence, or(eq(consultations.userId, userId), isNotNull(consultations.tenantId))) as SQL,
	);

/** True when `tenantId` is in the caller's accessible tenant set
 * (`Tenant`/`TenantAccess` — empty in personal scope). Ids compare
 * numerically so string|number directory ids both match. */
export const tenantRowVisible = (tenantId: number) =>
	Effect.map(accessibleTenantIds, (ids) => ids.some((id) => Number(id) === tenantId));

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
			if (yield* tenantRowVisible(row.tenantId)) return;
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

const ENVELOPE = /^v1\./;

/** Any populated clinical field already looks like ciphertext. */
const hasCipheredField = (values: readonly (string | null | undefined)[]) =>
	values.some((v) => typeof v === "string" && v !== "" && ENVELOPE.test(v));

/** Under ZK every populated clinical field must be a `v1.` envelope —
 * an absent/empty value is not content and stays allowed (a NOT NULL
 * transcript starts as ""). */
const allCiphered = (values: readonly (string | null | undefined)[]) =>
	values.every(
		(v) => v === null || v === undefined || v === "" || (typeof v === "string" && ENVELOPE.test(v)),
	);

/**
 * ZK write gate (PL-007 F3, T-145) — same fail-closed-both-ways
 * contract as `Patients.requireCipheredWhenZk`: under a ZK tenant
 * every populated clinical field the write carries must already be a
 * `v1.` AEAD envelope; outside ZK (non-ZK tenant or personal scope —
 * no clinic keyring exists there) an envelope write is unreadable
 * forever, so it is denied the same way. `values` arrive already
 * serialized (`serializeAnamnesis` output) so envelopes are
 * detectable. Reads need no gate: rows come back exactly as stored.
 */
export const requireCipheredWhenZk = Effect.fn("Consultations.requireCipheredWhenZk")(function* (
	db: DbClient,
	tenantId: number | null,
	values: readonly (string | null | undefined)[],
	action: "consultation.create" | "consultation.update",
) {
	const zk = tenantId !== null && (yield* Effect.promise(() => tenantIsZk(db, tenantId)));
	if (zk ? !allCiphered(values) : hasCipheredField(values)) {
		yield* Effect.fail(new Forbidden({ path: action }));
	}
});
