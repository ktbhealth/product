import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { Tenant, type TenantRole } from "./context.ts";

/**
 * Tenant role semantics (P-053): the rank table and role assertions
 * every tenant-gated guard shares. The package owns the role ordering
 * (owner > admin > member); fine-grained grants live in @ktb/rbac
 * tuples.
 */

/** Role ranking — higher outranks lower. */
export const TENANT_ROLE_RANK: Record<TenantRole, number> = {
	member: 1,
	admin: 2,
	owner: 3,
};

/** True when `role` exists and ranks at or above `min`. */
export const tenantRoleAtLeast = (role: TenantRole | null, min: TenantRole): boolean =>
	role !== null && TENANT_ROLE_RANK[role] >= TENANT_ROLE_RANK[min];

/** Denial error for tenant-role assertions — the tenant counterpart of
 * authz's `Forbidden`. */
export class TenantForbidden extends Data.TaggedError("TenantForbidden")<{
	readonly path: string;
	readonly role: TenantRole | null;
	readonly required: TenantRole;
}> {}

/**
 * Assert the bound `Tenant`'s role ranks at or above `min` — for guards
 * that don't go through the permission layer (e.g. "only an owner may
 * delete the tenant"). Fails `TenantForbidden` in personal scope or on
 * insufficient rank; `TenantRequired` never fires here — a missing
 * tenant is a `TenantForbidden` with `role: null`.
 */
export const requireTenantRole = (min: TenantRole, path = "tenant") =>
	Effect.flatMap(Tenant, (tenant) =>
		tenant !== null && tenantRoleAtLeast(tenant.role, min)
			? Effect.void
			: Effect.fail(
					new TenantForbidden({
						path,
						role: tenant?.role ?? null,
						required: min,
					}),
				),
	);
