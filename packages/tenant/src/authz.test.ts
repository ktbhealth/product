import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { Tenant } from "./index.ts";
import {
	TENANT_ROLE_RANK,
	TenantForbidden,
	requireTenantRole,
	tenantRoleAtLeast,
} from "./authz.ts";
import type { TenantRole } from "./index.ts";

const tenant = (role: TenantRole): Tenant => ({
	id: 1,
	kind: "clinic",
	slug: "clinic",
	role,
});

describe("tenantRoleAtLeast / TENANT_ROLE_RANK", () => {
	it("ranks owner > admin > member", () => {
		expect(TENANT_ROLE_RANK.owner).toBeGreaterThan(TENANT_ROLE_RANK.admin);
		expect(TENANT_ROLE_RANK.admin).toBeGreaterThan(TENANT_ROLE_RANK.member);
	});

	it("compares ranks and rejects null", () => {
		expect(tenantRoleAtLeast("owner", "admin")).toBe(true);
		expect(tenantRoleAtLeast("admin", "admin")).toBe(true);
		expect(tenantRoleAtLeast("member", "admin")).toBe(false);
		expect(tenantRoleAtLeast(null, "member")).toBe(false);
	});
});

describe("requireTenantRole", () => {
	const asTenant = <A, E>(t: Tenant | null, effect: Effect.Effect<A, E>) =>
		Effect.provideService(effect, Tenant, t);

	it("passes at or above the minimum role", async () => {
		await expect(
			Effect.runPromise(asTenant(tenant("admin"), requireTenantRole("member", "x"))),
		).resolves.toBeUndefined();
	});

	it("fails TenantForbidden below the minimum or without a tenant", async () => {
		await expect(
			Effect.runPromise(asTenant(tenant("member"), requireTenantRole("admin", "x"))),
		).rejects.toMatchObject({ path: "x", role: "member", required: "admin" });
		await expect(Effect.runPromise(requireTenantRole("member"))).rejects.toBeInstanceOf(
			TenantForbidden,
		);
	});
});
