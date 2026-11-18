import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, type TenantRole } from "@ktb/tenant";

import { MACHINES_TEST_DDL, Machines, MachinesLive } from "./index.ts";
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
