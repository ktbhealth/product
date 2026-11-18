import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Audit } from "@ktb/audit";
import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, type TenantRole } from "@ktb/tenant";

import { MACHINES_TEST_DDL, Machines, MachinesLive } from "./index.ts";
import { insertMachine, updateMachine } from "./machines.ts";

const DDL = MACHINES_TEST_DDL;
const TENANT_ID = 7;
const ADMIN_EMAIL = "admin@x.com";
const USER_EMAIL = "doc@clinic.com";

const makeRuntime = (
	db: DbClient,
	extra: Layer.Layer<never, never, never> | Layer.Layer<Audit, never, never> = Layer.empty,
) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL))),
	);
	return ManagedRuntime.make(
		Layer.mergeAll(MachinesLive.pipe(Layer.provide(infra)), infra, extra) as Layer.Layer<
			unknown,
			never,
			never
		>,
	);
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<unknown, never>,
	effect: Effect.Effect<A, E, unknown>,
	options: {
		role?: TenantRole | null;
		userId?: string;
		email?: string;
		tenantId?: number;
	} = {},
) =>
	runtime.runPromise(
		effect.pipe(
			Effect.provideService(
				Tenant,
				options.role === null
					? null
					: {
							id: options.tenantId ?? TENANT_ID,
							kind: "clinic",
							slug: "clinic-7",
							role: options.role ?? "member",
						},
			),
			Effect.provideService(Principal, {
				userId: options.userId ?? "u1",
				email: options.email ?? ADMIN_EMAIL,
			}),
		),
	);

const asAdmin = { email: ADMIN_EMAIL };
const asMember = { email: USER_EMAIL };
const asTenantAdmin = { email: USER_EMAIL, role: "admin" as TenantRole };

describe("Machines", () => {
	let db: DbClient;
	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		await db.insert(groups).values({
			id: TENANT_ID,
			name: "Clinic",
			slug: "clinic-7",
			kind: "clinic",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	});

	it("creates a platform machine; card carries metadata, never secret material", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.create({
					name: "gpu-node-1",
					kind: "gpu",
					host: "10.0.0.5",
					port: 22,
					capabilities: ["acp", "eval-runner"],
					secretRef: "vault:3",
					healthUrl: "http://10.0.0.5:8080/health",
				}),
			),
			asAdmin,
		);
		expect(card.id).toBeGreaterThan(0);
		expect(card.scope).toBe("platform");
		expect(card.kind).toBe("gpu");
		expect(card.capabilities).toEqual(["acp", "eval-runner"]);
		expect(card.secretRef).toBe("vault:3");
		expect(card.status).toBe("unknown");
		expect(card.enabled).toBe(true);
	});

	it("denies platform-scope writes to non-admins", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.create({ name: "nope", host: "h" })),
				asMember,
			),
		).rejects.toBeInstanceOf(Forbidden);
	});

	it("rejects duplicate names within a scope", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.create({ name: "gpu-node-1", host: "h2" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "duplicate" });
	});

	it("tenant members list; tenant admins create; members cannot write", async () => {
		const rt = makeRuntime(db);
		const created = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.create({
					scope: "tenant",
					tenantId: TENANT_ID,
					name: "clinic-shell",
					kind: "shell",
					host: "shell.clinic",
				}),
			),
			asTenantAdmin,
		);
		expect(created.scope).toBe(String(TENANT_ID));
		const listed = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.list({ scope: "tenant", tenantId: TENANT_ID })),
			asMember,
		);
		expect(listed.map((c) => c.name)).toContain("clinic-shell");
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) =>
					m.create({
						scope: "tenant",
						tenantId: TENANT_ID,
						name: "member-write",
						host: "h",
					}),
				),
				asMember,
			),
		).rejects.toBeDefined();
	});

	it("beat marks online; draining machines ignore beats", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "beat-box", host: "beat.local" })),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.beat(card.id)),
		);
		const after = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.get(card.id)),
		);
		expect(after?.status).toBe("online");
		expect(after?.lastSeenAt).not.toBeNull();
		// Force draining, then beat must not resurrect it.
		await updateMachine(db, card.id, { status: "draining" });
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.beat(card.id)),
		);
		const drained = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.get(card.id)),
		);
		expect(drained?.status).toBe("draining");
	});

	it("check probes healthUrl and persists the result", async () => {
		const rt = makeRuntime(db);
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const card = await run(
				rt,
				Effect.flatMap(Machines, (m) =>
					m.create({
						name: "probe-me",
						host: "probe.local",
						healthUrl: "http://probe.local/health",
					}),
				),
				asAdmin,
			);
			const checked = await run(
				rt,
				Effect.flatMap(Machines, (m) => m.check(card.id)),
				asAdmin,
			);
			expect(checked?.status).toBe("online");
			expect(checked?.lastCheckAt).not.toBeNull();
			expect(fetchMock).toHaveBeenCalledWith(
				"http://probe.local/health",
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			fetchMock.mockResolvedValue(new Response("no", { status: 503 }));
			const down = await run(
				rt,
				Effect.flatMap(Machines, (m) => m.check(card.id)),
				asAdmin,
			);
			expect(down?.status).toBe("offline");
			expect(down?.checkError).toBe("HTTP 503");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("check derives staleness from lastSeenAt when no healthUrl", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "stale-box", host: "stale.local" })),
			asAdmin,
		);
		// Never seen → unknown.
		const fresh = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.check(card.id)),
			asAdmin,
		);
		expect(fresh?.status).toBe("unknown");
		// Fresh heartbeat → online.
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.beat(card.id)),
		);
		const seen = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.check(card.id)),
			asAdmin,
		);
		expect(seen?.status).toBe("online");
		// Stale heartbeat → offline.
		await updateMachine(db, card.id, {
			lastSeenAt: new Date(Date.now() - 10 * 60_000),
		});
		const stale = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.check(card.id)),
			asAdmin,
		);
		expect(stale?.status).toBe("offline");
		expect(stale?.checkError).toBe("heartbeat stale");
	});

	it("update/remove round-trip; missing ids fail typed", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "doomed", host: "doom.local" })),
			asAdmin,
		);
		const updated = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.update({ id: card.id, name: "doomed-2", enabled: false })),
			asAdmin,
		);
		expect(updated.name).toBe("doomed-2");
		expect(updated.enabled).toBe(false);
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.remove(card.id)),
		);
		const gone = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.get(card.id)),
		);
		expect(gone).toBeNull();
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.remove(card.id)),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.update({ id: card.id, host: "x" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
	});

	it("rejects malformed vault: secretRefs, accepts well-formed and other schemes", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) =>
					m.create({ name: "bad-ref", host: "h", secretRef: "vault:abc" }),
				),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		const ok = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.create({ name: "good-ref", host: "h", secretRef: "vault:12" }),
			),
			asAdmin,
		);
		expect(ok.secretRef).toBe("vault:12");
		const env = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.create({ name: "env-ref", host: "h", secretRef: "env:MACHINE_TOKEN" }),
			),
			asAdmin,
		);
		expect(env.secretRef).toBe("env:MACHINE_TOKEN");
	});

	it("rate-limits beat spam per machine", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "spam-box", host: "spam.local" })),
			asAdmin,
		);
		for (let i = 0; i < 30; i++) {
			await run(
				rt,
				Effect.flatMap(Machines, (m) => m.beat(card.id)),
			);
		}
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.beat(card.id)),
			),
		).rejects.toMatchObject({ reason: "rate-limited" });
	});

	it("checkAll refreshes every machine in scope", async () => {
		const rt = makeRuntime(db);
		// Earlier tests leave machines with healthUrls — stub fetch so
		// probes resolve instantly instead of hitting the network.
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
		try {
			const cards = await run(
				rt,
				Effect.flatMap(Machines, (m) => m.checkAll({ scope: "platform" })),
				asAdmin,
			);
			expect(cards.length).toBeGreaterThan(0);
			expect(cards.every((c) => c.lastCheckAt !== null)).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("tenant scope reads enforce tenant match and member role", async () => {
		const rt = makeRuntime(db);
		// No bound tenant → tenant-mismatch.
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.list({ scope: "tenant", tenantId: TENANT_ID })),
				{ role: null, email: "nobody@x.com" },
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		// Bound to a different tenant → tenant-mismatch.
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.list({ scope: "tenant", tenantId: TENANT_ID })),
				{ ...asMember, tenantId: 99 },
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		// get on a tenant machine by an outsider → tenant-mismatch.
		const tenantMachine = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.create({
					scope: "tenant",
					tenantId: TENANT_ID,
					name: "clinic-gated",
					host: "gated.local",
				}),
			),
			asTenantAdmin,
		);
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.get(tenantMachine.id)),
				{ role: null, email: "nobody@x.com" },
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		// scope "tenant" without tenantId degrades to platform (admin-gated).
		const degraded = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.create({ scope: "tenant", name: "deg-machine", host: "deg.local" }),
			),
			asAdmin,
		);
		expect(degraded.scope).toBe("platform");
		// Bare list() defaults to platform scope.
		const platform = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.list()),
			asAdmin,
		);
		expect(platform.every((c) => c.scope === "platform")).toBe(true);
		await rt.dispose();
	});

	it("rejects blank names/hosts and applies every update field", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.create({ name: "  ", host: "h" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.create({ name: "ok-name", host: "  " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "full-update", host: "fu.local" })),
			asAdmin,
		);
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.update({ id: card.id, name: " " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.update({ id: card.id, host: " " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		const updated = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.update({
					id: card.id,
					name: "full-update-2",
					kind: "vm",
					host: "fu2.local",
					port: 2222,
					capabilities: ["acp"],
					secretRef: "vault:9",
					healthUrl: "http://fu2.local/health",
					enabled: false,
				}),
			),
			asAdmin,
		);
		expect(updated).toMatchObject({
			name: "full-update-2",
			kind: "vm",
			host: "fu2.local",
			port: 2222,
			capabilities: ["acp"],
			secretRef: "vault:9",
			healthUrl: "http://fu2.local/health",
			enabled: false,
		});
		// Minimal update (no name/host) still works.
		const minimal = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.update({ id: card.id, port: null })),
			asAdmin,
		);
		expect(minimal.port).toBeNull();
		await rt.dispose();
	});

	it("probeHealth catch maps thrown errors and non-Error rejections", async () => {
		const rt = makeRuntime(db);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("conn refused")));
		try {
			const card = await run(
				rt,
				Effect.flatMap(Machines, (m) =>
					m.create({
						name: "throw-probe",
						host: "tp.local",
						healthUrl: "http://tp.local/health",
					}),
				),
				asAdmin,
			);
			const down = await run(
				rt,
				Effect.flatMap(Machines, (m) => m.check(card.id)),
				asAdmin,
			);
			expect(down?.status).toBe("offline");
			expect(down?.checkError).toBe("conn refused");
		} finally {
			vi.unstubAllGlobals();
		}
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue("plain failure"));
		try {
			const listed = await run(
				rt,
				Effect.flatMap(Machines, (x) => x.list()),
			);
			const id = listed.find((c) => c.name === "throw-probe")!.id;
			const down = await run(
				rt,
				Effect.flatMap(Machines, (m) => m.check(id)),
				asAdmin,
			);
			expect(down?.checkError).toBe("plain failure");
		} finally {
			vi.unstubAllGlobals();
		}
		await rt.dispose();
	});

	it("beat rejects unknown ids", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.beat(999999)),
			),
		).rejects.toMatchObject({ reason: "not-found" });
		await rt.dispose();
	});

	it("resolve returns enabled cards, null for missing/disabled", async () => {
		const rt = makeRuntime(db);
		expect(
			await run(
				rt,
				Effect.flatMap(Machines, (m) => m.resolve(999999)),
			),
		).toBeNull();
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "resolve-me", host: "rm.local" })),
			asAdmin,
		);
		const resolved = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.resolve(card.id)),
			{ role: null, email: "sys@x.com" },
		);
		expect(resolved?.name).toBe("resolve-me");
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.update({ id: card.id, enabled: false })),
			asAdmin,
		);
		expect(
			await run(
				rt,
				Effect.flatMap(Machines, (m) => m.resolve(card.id)),
			),
		).toBeNull();
		await rt.dispose();
	});

	it("parses malformed and non-array capabilities as filtered lists", async () => {
		const row = await insertMachine(db, {
			scope: "platform",
			tenantId: null,
			name: "caps-row",
			kind: "other",
			host: "caps.local",
			port: null,
			capabilities: "{oops",
			secretRef: null,
			healthUrl: null,
			status: "unknown",
		});
		const rt = makeRuntime(db);
		expect(
			(
				await run(
					rt,
					Effect.flatMap(Machines, (m) => m.get(row.id)),
				)
			)?.capabilities,
		).toEqual([]);
		await updateMachine(db, row.id, { capabilities: '{"a":1}' });
		expect(
			(
				await run(
					rt,
					Effect.flatMap(Machines, (m) => m.get(row.id)),
				)
			)?.capabilities,
		).toEqual([]);
		await updateMachine(db, row.id, { capabilities: '[1,"x",null,"y"]' });
		expect(
			(
				await run(
					rt,
					Effect.flatMap(Machines, (m) => m.get(row.id)),
				)
			)?.capabilities,
		).toEqual(["x", "y"]);
		await rt.dispose();
	});

	it("records audit entries when the Audit service is bound", async () => {
		// checkAll probes healthUrls — keep probes off the network.
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
		const entries: { action: string; tenantId?: unknown }[] = [];
		const audit = Layer.succeed(Audit, {
			record: (entry: { action: string; tenantId?: unknown }) =>
				Effect.sync(() => {
					entries.push(entry);
				}),
		} as never);
		const rt = makeRuntime(db, audit);
		const platform = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "aud-plat", host: "ap.local" })),
			asAdmin,
		);
		const tenant = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.create({
					scope: "tenant",
					tenantId: TENANT_ID,
					name: "aud-ten",
					host: "at.local",
				}),
			),
			asTenantAdmin,
		);
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.update({ id: platform.id, port: 1 })),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.beat(platform.id)),
		);
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.check(tenant.id)),
			asTenantAdmin,
		);
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.resolve(platform.id)),
		);
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.checkAll({ scope: "platform" })),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.remove(platform.id)),
			asAdmin,
		);
		const actions = entries.map((e) => e.action);
		for (const a of [
			"machines.create",
			"machines.update",
			"machines.beat",
			"machines.check",
			"machines.resolve",
			"machines.remove",
		]) {
			expect(actions).toContain(a);
		}
		// Tenant-scoped rows attribute the tenant id; platform rows null.
		expect(entries.some((e) => e.tenantId === TENANT_ID)).toBe(true);
		expect(entries.some((e) => e.action === "machines.create" && e.tenantId === null)).toBe(true);
		vi.unstubAllGlobals();
		await rt.dispose();
	});

	it("audit tenantId falls back to null for non-numeric scopes", async () => {
		const entries: { action: string; tenantId?: unknown }[] = [];
		const audit = Layer.succeed(Audit, {
			record: (entry: { action: string; tenantId?: unknown }) =>
				Effect.sync(() => {
					entries.push(entry);
				}),
		} as never);
		const rt = makeRuntime(db, audit);
		// A row outside the service's scope grammar still audits safely —
		// beat is ungated, so insert directly and beat it.
		const weird = await insertMachine(db, {
			scope: "legacy",
			tenantId: null,
			name: "weird-scope",
			kind: "other",
			host: "weird.local",
			port: null,
			capabilities: null,
			secretRef: null,
			healthUrl: null,
			status: "unknown",
		});
		await run(
			rt,
			Effect.flatMap(Machines, (m) => m.beat(weird.id)),
		);
		const beat = entries.find((e) => e.action === "machines.beat");
		expect(beat?.tenantId).toBeNull();
		await rt.dispose();
	});

	it("checkAll degrades per-row when the probe pipeline fails", async () => {
		// A failing Audit.record makes runCheck fail after the probe —
		// checkAll must still return the (stale) cards.
		const audit = Layer.succeed(Audit, {
			record: () => Effect.fail(new Error("audit down") as never),
		} as never);
		// Probes still hit healthUrls — stub fetch so they resolve fast.
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
		const rt = makeRuntime(db, audit);
		const cards = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.checkAll({ scope: "platform" })),
			asAdmin,
		);
		expect(cards.length).toBeGreaterThan(0);
		expect(cards.every((c) => c.id > 0)).toBe(true);
		vi.unstubAllGlobals();
		await rt.dispose();
	});
});
