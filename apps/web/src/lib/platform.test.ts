import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const hoisted = vi.hoisted(() => ({
	throwHeaders: false,
	account: null as null | { id: string; email: string; name: string },
	accountFails: false,
	headers: new Headers(),
}));

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => {
		if (hoisted.throwHeaders) throw new Error("no request context");
		return hoisted.headers;
	},
}));

// The session lookup behind requestScopeChain is a server-fn port —
// stub it so tenant-selector tests control the account directly.
vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return {
		...actual,
		getSessionAccount: async () => {
			if (hoisted.accountFails) throw new Error("session store down");
			return hoisted.account;
		},
	};
});

import { groupMembers, groups } from "@ktb/db/schema";
import { GLOBAL_SCOPE, tenantScope } from "@ktb/i18n";
import { Tenant } from "@ktb/tenant";
import { getI18n } from "@ktb/server-fns";

import { ai, auth, BindingLive, db, flushTelemetry, runAs } from "./platform.ts";

// Tenant fixtures (P-053): u1 belongs to exactly one tenant (clinic-a) so
// the resolver's selectDefault auto-picks it; u-multi belongs to two and
// must fall back to personal scope; u-none belongs to none.
let clinicAId = 0;
beforeAll(async () => {
	const [clinicA] = await db
		.insert(groups)
		.values({
			name: "Clinic A",
			slug: "clinic-a",
			kind: "clinic",
			meta: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.returning();
	clinicAId = clinicA!.id;
	const [orgB] = await db
		.insert(groups)
		.values({
			name: "Org B",
			slug: "org-b",
			kind: "org",
			meta: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.returning();
	const [clinicC] = await db
		.insert(groups)
		.values({
			name: "Clinic C",
			slug: "clinic-c",
			kind: "clinic",
			meta: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.returning();
	await db.insert(groupMembers).values([
		{
			groupId: clinicA!.id,
			memberKind: "user",
			memberId: "u1",
			role: "admin",
			createdAt: new Date(),
		},
		{
			groupId: orgB!.id,
			memberKind: "user",
			memberId: "u-multi",
			role: "member",
			createdAt: new Date(),
		},
		{
			groupId: clinicC!.id,
			memberKind: "user",
			memberId: "u-multi",
			role: "member",
			createdAt: new Date(),
		},
	]);
});

const readTenant = () => Effect.flatMap(Tenant, (tenant) => Effect.succeed(tenant));

describe("platform", () => {
	it("exposes db, auth and ai bindings", async () => {
		expect(db).toBeDefined();
		expect(auth).toBeDefined();
		expect(typeof auth.api.getSession).toBe("function");
		expect(typeof ai?.run).toBe("function");
		expect(BindingLive).toBeDefined();
	});

	it("flushTelemetry resolves without rejecting", async () => {
		await expect(flushTelemetry()).resolves.toBeUndefined();
	});

	it("runAs resolves an explicit tenant selector through the directory", async () => {
		const tenant = await runAs({ id: "u1" }, readTenant(), { slug: "clinic-a" });
		expect(tenant).toMatchObject({
			id: clinicAId,
			kind: "clinic",
			slug: "clinic-a",
			role: "admin",
		});
		// Explicit null skips header extraction and takes the default path.
		await expect(runAs({ id: "u1" }, Effect.succeed("ok"), null)).resolves.toBe("ok");
	});

	it("runAs rejects selectors naming tenants the user cannot access", async () => {
		// u1 does not belong to org-b — resolution must not leak it.
		const error = await runAs({ id: "u1" }, Effect.succeed("ok"), {
			slug: "org-b",
		}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).not.toBeNull();
		expect(String(error)).toContain("TenantNotFound");
	});

	it("runAs auto-selects the user's sole membership when no selector is given", async () => {
		const tenant = await runAs({ id: "u1" }, readTenant());
		expect(tenant).toMatchObject({ slug: "clinic-a", role: "admin" });
	});

	it("runAs falls back to personal scope for multi-tenant and non-member users", async () => {
		// Two memberships → selectDefault abstains → fallback "personal".
		await expect(runAs({ id: "u-multi" }, readTenant())).resolves.toBeNull();
		// No memberships at all → personal scope.
		await expect(runAs({ id: "u-none" }, readTenant())).resolves.toBeNull();
		// Outside a request context selector extraction degrades to null.
		await expect(runAs({ id: "u1" }, Effect.succeed("ok"))).resolves.toBe("ok");
	});

	it("i18n capability resolves a request-bound shape and honors caller scope", async () => {
		// No tenant headers/session in tests → global scope chain.
		const i18n = await getI18n();
		expect(i18n.scopeChain).toEqual(GLOBAL_SCOPE);
		expect(typeof i18n.t).toBe("function");
		// An explicit scopeChain still wins (portal-scoped callers).
		const scoped = await getI18n({ scopeChain: tenantScope("t1") });
		expect(scoped.scopeChain).toEqual(tenantScope("t1"));
	});

	it("i18n capability binds tenant scope from request headers + session", async () => {
		const reset = () => {
			hoisted.headers = new Headers();
			hoisted.account = null;
			hoisted.accountFails = false;
			hoisted.throwHeaders = false;
		};
		reset();
		try {
			hoisted.headers = new Headers({ "x-tenant-slug": "clinic-a" });
			hoisted.account = { id: "u1", email: "u@x.com", name: "U" };
			const i18n = await getI18n();
			expect(i18n.scopeChain).toEqual(tenantScope(String(clinicAId)));
		} finally {
			reset();
		}
	});

	it("i18n capability degrades to global scope on selector/session failures", async () => {
		const reset = () => {
			hoisted.headers = new Headers();
			hoisted.account = null;
			hoisted.accountFails = false;
			hoisted.throwHeaders = false;
		};
		reset();
		try {
			// Session lookup throws → `.catch(() => null)` → resolver sees
			// no user → TenantNotFound → caught → personal/global scope.
			hoisted.headers = new Headers({ "x-tenant-slug": "clinic-a" });
			hoisted.accountFails = true;
			expect((await getI18n()).scopeChain).toEqual(GLOBAL_SCOPE);
			// Anonymous account → same degradation.
			hoisted.accountFails = false;
			expect((await getI18n()).scopeChain).toEqual(GLOBAL_SCOPE);
			// Unknown slug with a real account → TenantNotFound → global.
			hoisted.headers = new Headers({ "x-tenant-slug": "no-such-tenant" });
			hoisted.account = { id: "u1", email: "u@x.com", name: "U" };
			expect((await getI18n()).scopeChain).toEqual(GLOBAL_SCOPE);
			// getRequestHeaders throwing → empty headers → no selector.
			hoisted.throwHeaders = true;
			hoisted.account = null;
			expect((await getI18n()).scopeChain).toEqual(GLOBAL_SCOPE);
		} finally {
			reset();
		}
	});
});
