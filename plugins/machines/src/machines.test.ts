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
import { Tenant, TenantForbidden, type TenantRole } from "@ktb/tenant";

import {
	MACHINES_TEST_DDL,
	MachineError,
	Machines,
	MachinesLive,
	machinesPanelPlugin,
	type MachineCard,
} from "./index.ts";
import { updateMachine } from "./machines.ts";

const DDL = MACHINES_TEST_DDL;
const TENANT_ID = 7;
const ADMIN_EMAIL = "admin@x.com";
const USER_EMAIL = "doc@clinic.com";

const makeRuntime = (db: DbClient) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL))),
	);
	return ManagedRuntime.make(MachinesLive.pipe(Layer.provide(infra)));
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<Machines, never>,
	effect: Effect.Effect<A, E, Machines>,
	options: { role?: TenantRole | null; userId?: string; email?: string } = {},
) =>
	runtime.runPromise(
		effect.pipe(
			Effect.provideService(
				Tenant,
				options.role === null
					? null
					: {
							id: TENANT_ID,
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
});

describe("Machines edge cases", () => {
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

	it("reads corrupt capabilities JSON as an empty list", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "corrupt-caps", host: "h" })),
			asAdmin,
		);
		await updateMachine(db, card.id, { capabilities: "not-json{" });
		const after = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.get(card.id)),
		);
		expect(after?.capabilities).toEqual([]);
		// Valid JSON that isn't a string array also reads as empty.
		await updateMachine(db, card.id, { capabilities: "42" });
		const scalar = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.get(card.id)),
		);
		expect(scalar?.capabilities).toEqual([]);
		await updateMachine(db, card.id, { capabilities: '[1,"keep",null]' });
		const mixed = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.get(card.id)),
		);
		expect(mixed?.capabilities).toEqual(["keep"]);
	});

	it("list defaults to the platform scope when called without input", async () => {
		const rt = makeRuntime(db);
		const cards = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.list()),
		);
		expect(Array.isArray(cards)).toBe(true);
	});

	it("rejects cross-tenant scope reads with tenant-mismatch", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.list({ scope: "tenant", tenantId: 999 })),
				asMember,
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
	});

	it("check surfaces fetch failures as offline with the error detail", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.create({ name: "fetch-fail", host: "h", healthUrl: "http://x/health" }),
			),
			asAdmin,
		);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("conn refused")));
		try {
			const down = await run(
				rt,
				Effect.flatMap(Machines, (m) => m.check(card.id)),
				asAdmin,
			);
			expect(down?.status).toBe("offline");
			expect(down?.checkError).toBe("conn refused");
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue("plain failure"));
			const down2 = await run(
				rt,
				Effect.flatMap(Machines, (m) => m.check(card.id)),
				asAdmin,
			);
			expect(down2?.checkError).toBe("plain failure");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("create/update reject blank name and host", async () => {
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
				Effect.flatMap(Machines, (m) => m.create({ name: "n", host: " " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "blank-check", host: "h" })),
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
				Effect.flatMap(Machines, (m) => m.update({ id: card.id, host: "" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
	});

	it("update applies the full optional patch", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "full-patch", host: "h" })),
			asAdmin,
		);
		const updated = await run(
			rt,
			Effect.flatMap(Machines, (m) =>
				m.update({
					id: card.id,
					name: "full-patch-2",
					kind: "vm",
					host: "h2",
					port: 2200,
					capabilities: ["tts"],
					secretRef: "env:TOKEN",
					healthUrl: "http://h2/health",
					enabled: true,
				}),
			),
			asAdmin,
		);
		expect(updated.name).toBe("full-patch-2");
		expect(updated.kind).toBe("vm");
		expect(updated.host).toBe("h2");
		expect(updated.port).toBe(2200);
		expect(updated.capabilities).toEqual(["tts"]);
		expect(updated.secretRef).toBe("env:TOKEN");
		expect(updated.healthUrl).toBe("http://h2/health");
	});

	it("beat on a missing id fails not-found", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(Machines, (m) => m.beat(999_999)),
			),
		).rejects.toMatchObject({ reason: "not-found" });
	});

	it("resolve returns enabled cards, null for missing/disabled", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.create({ name: "resolve-me", host: "h" })),
			asAdmin,
		);
		const resolved = await run(
			rt,
			Effect.flatMap(Machines, (m) => m.resolve(card.id)),
		);
		expect(resolved?.name).toBe("resolve-me");
		expect(
			await run(
				rt,
				Effect.flatMap(Machines, (m) => m.resolve(999_999)),
			),
		).toBeNull();
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
	});

	it("records audit entries for mutations and probes when Audit is present", async () => {
		const entries: { action: string; targetType: string; tenantId: number | null }[] = [];
		const auditStub = {
			record: (entry: { action: string; targetType: string; tenantId?: number | null }) =>
				Effect.sync(() => {
					entries.push({
						action: entry.action,
						targetType: entry.targetType,
						tenantId: entry.tenantId ?? null,
					});
				}),
		} as unknown as Audit["Service"];
		// serviceOption reads the ambient context — provide Audit per call.
		const withAudit = <A, E>(effect: Effect.Effect<A, E, Machines>) =>
			effect.pipe(Effect.provideService(Audit, auditStub));
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			withAudit(
				Effect.flatMap(Machines, (m) =>
					m.create({
						scope: "tenant",
						tenantId: TENANT_ID,
						name: "audit-box",
						host: "audit.local",
					}),
				),
			),
			asTenantAdmin,
		);
		await run(
			rt,
			withAudit(Effect.flatMap(Machines, (m) => m.update({ id: card.id, name: "audit-box-2" }))),
			asTenantAdmin,
		);
		await run(rt, withAudit(Effect.flatMap(Machines, (m) => m.beat(card.id))));
		await run(rt, withAudit(Effect.flatMap(Machines, (m) => m.check(card.id))), asMember);
		await run(rt, withAudit(Effect.flatMap(Machines, (m) => m.resolve(card.id))));
		await run(rt, withAudit(Effect.flatMap(Machines, (m) => m.remove(card.id))), asTenantAdmin);
		const actions = entries.map((e) => e.action);
		for (const expected of [
			"machines.create",
			"machines.update",
			"machines.beat",
			"machines.check",
			"machines.resolve",
			"machines.remove",
		]) {
			expect(actions).toContain(expected);
		}
		// Tenant-scoped rows record the numeric tenant id, not the scope string.
		const createEntry = entries.find((e) => e.action === "machines.create");
		expect(createEntry?.tenantId).toBe(TENANT_ID);
		await rt.dispose();
	});

	it("checkAll falls back to the stored card when probe bookkeeping fails", async () => {
		const failingAudit = {
			record: (entry: { action: string }) =>
				entry.action === "machines.check"
					? Effect.fail(new Error("audit down") as never)
					: Effect.void,
		} as unknown as Audit["Service"];
		const rt = makeRuntime(db);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("ok")),
		);
		try {
			const cards = await run(
				rt,
				Effect.flatMap(Machines, (m) => m.checkAll({ scope: "platform" })).pipe(
					Effect.provideService(Audit, failingAudit),
				),
				asAdmin,
			);
			expect(cards.length).toBeGreaterThan(0);
		} finally {
			vi.unstubAllGlobals();
			await rt.dispose();
		}
	});
});

describe("machinesPanelPlugin page", () => {
	it("guard mirrors PlatformAdmin and loader lists platform machines", async () => {
		const page = machinesPanelPlugin.panel!.pages![0]!;
		expect(page.path).toBe("/platform/ai/machines");
		const rt = makeRuntime(makeDb(makeD1(DDL)));
		const gate = makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL));
		const provideCaller = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.provideService(Principal, { userId: "u1", email: ADMIN_EMAIL }),
				Effect.provideService(PlatformAdmin, gate),
				Effect.provideService(Tenant, {
					id: TENANT_ID,
					kind: "clinic",
					slug: "clinic-7",
					role: "member" as TenantRole,
				}),
			);
		const allowed = await rt.runPromise(provideCaller(page.guard!() as Effect.Effect<boolean>));
		expect(allowed).toBe(true);
		const loaded = await rt.runPromise(
			provideCaller(page.loader!() as Effect.Effect<readonly MachineCard[]>),
		);
		expect(Array.isArray(loaded)).toBe(true);
		// Non-admin callers: guard denies, loader degrades to [].
		const memberCaller = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.provideService(Principal, {
					userId: "u2",
					email: USER_EMAIL,
				}),
				Effect.provideService(PlatformAdmin, gate),
				Effect.provideService(Tenant, {
					id: TENANT_ID,
					kind: "clinic",
					slug: "clinic-7",
					role: "member" as TenantRole,
				}),
			);
		expect(await rt.runPromise(memberCaller(page.guard!() as Effect.Effect<boolean>))).toBe(false);
		expect(
			await rt.runPromise(memberCaller(page.loader!() as Effect.Effect<readonly MachineCard[]>)),
		).toEqual([]);
		await rt.dispose();
	});

	it("loader collapses MachineError and TenantForbidden to []", async () => {
		const page = machinesPanelPlugin.panel!.pages![0]!;
		const loader = page.loader!() as Effect.Effect<readonly MachineCard[]>;
		const stub = (err: MachineError | TenantForbidden) =>
			({ list: () => Effect.fail(err) }) as unknown as Machines["Service"];
		for (const err of [
			new MachineError({ reason: "not-found" }),
			new TenantForbidden({ path: "machines.admin", role: null, required: "admin" }),
		]) {
			const out = await Effect.runPromise(loader.pipe(Effect.provideService(Machines, stub(err))));
			expect(out).toEqual([]);
		}
	});
});
