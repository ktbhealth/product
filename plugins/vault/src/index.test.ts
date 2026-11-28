import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Audit, type AuditEntryInput } from "@ktb/audit";
import { Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makeTestD1 } from "@ktb/db-testing";
import { TENANT_ROLE_RANK, Tenant, type TenantRole } from "@ktb/tenant";
import {
	approveClinicDevice,
	deviceByWrapPubkey,
	enrollClinicDevice,
	enrollPortalDevice,
	entityDekEnvelope,
	grantEntityDeks,
	listClinicDevices,
	listEntityReaders,
	plugins,
	portalDeviceOf,
	portalDevicesOf,
	requireCipheredWhenZk,
	revokeClinicDevice,
	setTenantZk,
	tenantIsZk,
	tenantZkOrClosed,
	Vault,
	vaultChromePlugin,
	VaultLive,
	vaultPagesPlugin,
	Secrets,
	SecretsLive,
	vaultSecretsPlugin,
	vaultServicesPlugin,
	vaultTablesPlugin,
} from "./index.ts";

// Seed rows only — the real migrations provide `user`, `groups`,
// `clinic_keys`, `entity_deks`, `portal_keys` and `vault_secret`.
const DDL = `INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES
	('ana', 'ana', 'ana@x.com', 0, 0), ('eva', 'eva', 'eva@x.com', 0, 0);`;
const TENANT_ID = 7;

const makeRuntime = (db: DbClient) => {
	// SecretsLive resolves at layer build: Db + the PlatformAdmin gate
	// (no SecretKeyring bound → list still works; put/resolve fail closed).
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
	);
	return ManagedRuntime.make(
		Layer.mergeAll(
			infra,
			VaultLive.pipe(Layer.provide(infra)),
			SecretsLive.pipe(Layer.provide(infra)),
		),
	) as ManagedRuntime.ManagedRuntime<Vault | Secrets, never>;
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<Vault | Secrets, never>,
	effect: Effect.Effect<A, E, Vault | Secrets>,
	options: {
		readonly role?: TenantRole | null;
		readonly userId?: string;
	} = {},
) =>
	runtime.runPromise(
		effect.pipe(
			Effect.provideService(
				Tenant,
				options.role === null
					? null // no bound tenant — personal scope → tenant-mismatch
					: {
							id: TENANT_ID,
							kind: "clinic",
							slug: "clinic-7",
							role: options.role ?? "member",
						},
			),
			Effect.provideService(Principal, { userId: options.userId ?? "u-owner" }),
		),
	);

const seedGroup = (db: DbClient, id: number, zk = false) =>
	db.insert(groups).values({
		id,
		name: "Clinic",
		slug: `clinic-${id}`,
		kind: "clinic",
		zk,
		createdAt: new Date(),
		updatedAt: new Date(),
	});

describe("vault repo", () => {
	let db: DbClient;

	beforeAll(async () => {
		db = makeDb(makeTestD1(DDL));
		await seedGroup(db, TENANT_ID);
		await seedGroup(db, 8, true);
		await seedGroup(db, 9); // stays non-ZK — setTenantZk flips TENANT_ID
	});

	it("enrolls a device as pending and is idempotent on the wrap pubkey", async () => {
		const first = await enrollClinicDevice(db, {
			tenantId: TENANT_ID,
			userId: "u1",
			wrapPublicKey: "wrapA",
			signPublicKey: "signA",
		});
		expect(first.status).toBe("pending");
		expect(first.wrappedMasterKey).toBeNull();
		const again = await enrollClinicDevice(db, {
			tenantId: TENANT_ID,
			userId: "u1",
			wrapPublicKey: "wrapA",
			signPublicKey: "signA",
		});
		expect(again.id).toBe(first.id);
		expect(await listClinicDevices(db, TENANT_ID)).toHaveLength(1);
	});

	it("approves a pending device with the client-supplied master envelope", async () => {
		const row = await enrollClinicDevice(db, {
			tenantId: TENANT_ID,
			userId: "u2",
			wrapPublicKey: "wrapB",
			signPublicKey: "signB",
		});
		const approved = await approveClinicDevice(db, {
			clinicKeyId: row.id,
			wrappedMasterKey: "w1.eph.master",
			approvedByUserId: "u-admin",
		});
		expect(approved.status).toBe("approved");
		expect(approved.wrappedMasterKey).toBe("w1.eph.master");
		expect(approved.approvedByUserId).toBe("u-admin");
		expect(approved.approvedAt).toBeInstanceOf(Date);
	});

	it("revokes a device without deleting the row", async () => {
		const row = await enrollClinicDevice(db, {
			tenantId: TENANT_ID,
			userId: "u3",
			wrapPublicKey: "wrapC",
			signPublicKey: "signC",
		});
		const revoked = await revokeClinicDevice(db, row.id);
		expect(revoked.status).toBe("revoked");
		expect(await deviceByWrapPubkey(db, TENANT_ID, "wrapC")).not.toBeNull();
	});

	it("grants, replaces, and reads record DEK envelopes", async () => {
		await grantEntityDeks(db, {
			tenantId: TENANT_ID,
			entityType: "patient",
			entityId: 42,
			grantedByUserId: "u-owner",
			grants: [
				{ readerKind: "device", readerPubkey: "wrapA", readerId: "u1", wrappedDek: "w1.e1" },
				{ readerKind: "patient", readerPubkey: "patWrap", readerId: "p42", wrappedDek: "w1.e2" },
			],
		});
		const readers = await listEntityReaders(db, TENANT_ID, "patient", 42);
		expect(readers).toHaveLength(2);
		expect(readers.map((r) => r.readerKind).sort()).toEqual(["device", "patient"]);
		// Re-grant replaces the envelope (DEK rotation).
		await grantEntityDeks(db, {
			tenantId: TENANT_ID,
			entityType: "patient",
			entityId: 42,
			grantedByUserId: "u-owner",
			grants: [{ readerKind: "device", readerPubkey: "wrapA", wrappedDek: "w1.e3" }],
		});
		expect(await listEntityReaders(db, TENANT_ID, "patient", 42)).toHaveLength(2);
		const env = await entityDekEnvelope(db, TENANT_ID, "patient", 42, "wrapA");
		expect(env?.wrappedDek).toBe("w1.e3");
		// Numeric and string entity ids resolve to the same row.
		expect(await entityDekEnvelope(db, TENANT_ID, "patient", "42", "patWrap")).not.toBeNull();
	});

	it("reads the tenant zk flag", async () => {
		expect(await tenantIsZk(db, TENANT_ID)).toBe(false);
		expect(await tenantIsZk(db, 8)).toBe(true);
		expect(await tenantIsZk(db, 999)).toBe(false); // missing → non-ZK
	});

	it("setTenantZk flips the flag one-way", async () => {
		expect(await tenantIsZk(db, TENANT_ID)).toBe(false);
		await setTenantZk(db, TENANT_ID);
		expect(await tenantIsZk(db, TENANT_ID)).toBe(true);
	});

	it("enrolls portal devices idempotently per (user, wrap pubkey)", async () => {
		const first = await enrollPortalDevice(db, {
			userId: "ana",
			wrapPublicKey: "pWrap",
			signPublicKey: "pSign",
		});
		expect(first.userId).toBe("ana");
		const again = await enrollPortalDevice(db, {
			userId: "ana",
			wrapPublicKey: "pWrap",
			signPublicKey: "pSign",
		});
		expect(again.id).toBe(first.id);
		// Same pubkey under another user is a different device row.
		const other = await enrollPortalDevice(db, {
			userId: "eva",
			wrapPublicKey: "pWrap",
			signPublicKey: "pSign",
		});
		expect(other.id).not.toBe(first.id);
	});

	it("finds portal devices by user list and by owner+pubkey", async () => {
		const rows = await portalDevicesOf(db, ["ana", "eva"]);
		expect(rows.map((r) => r.userId).sort()).toEqual(["ana", "eva"]);
		expect(await portalDevicesOf(db, [])).toEqual([]);
		expect(await portalDeviceOf(db, "ana", "pWrap")).toMatchObject({ userId: "ana" });
		expect(await portalDeviceOf(db, "ana", "nope")).toBeNull();
		expect(await portalDeviceOf(db, "nobody", "pWrap")).toBeNull();
	});

	it("tenantZkOrClosed fails closed on anything unresolvable", async () => {
		expect(await tenantZkOrClosed(db, null)).toBe(false); // personal scope — no clinic
		expect(await tenantZkOrClosed(db, 9)).toBe(false);
		expect(await tenantZkOrClosed(db, 8)).toBe(true);
		expect(await tenantZkOrClosed(db, 999)).toBe(true); // missing group → metadata-only
		// A lookup that throws (no groups table) fails closed too.
		const broken = makeDb(makeD1(`CREATE TABLE "user" (id TEXT PRIMARY KEY);`));
		expect(await tenantZkOrClosed(broken, TENANT_ID)).toBe(true);
	});
});

describe("requireCipheredWhenZk", () => {
	let db: DbClient;

	beforeAll(async () => {
		db = makeDb(makeTestD1(DDL));
		await seedGroup(db, 8, true); // ZK tenant
		await seedGroup(db, 9); // non-ZK tenant
	});

	const gate = (tenantId: number | null, values: readonly (string | null | undefined)[]) =>
		Effect.runPromise(requireCipheredWhenZk(db, tenantId, values, "patient.create"));

	const denial = (tenantId: number | null, values: readonly (string | null | undefined)[]) =>
		Effect.runPromise(Effect.flip(requireCipheredWhenZk(db, tenantId, values, "patient.create")));

	it("passes plaintext outside ZK (personal scope and non-ZK tenant)", async () => {
		await expect(gate(null, ["plain"])).resolves.toBeUndefined();
		await expect(gate(9, ["plain", null, ""])).resolves.toBeUndefined();
	});

	it("denies an envelope write outside ZK — unreadable without a clinic keyring", async () => {
		for (const tenantId of [null, 9] as const) {
			const err = await denial(tenantId, ["plain", "v1.a.b"]);
			expect(err).toMatchObject({ _tag: "Forbidden", path: "patient.create" });
		}
	});

	it("under ZK admits envelopes plus absent/empty values and denies any plaintext", async () => {
		await expect(gate(8, ["v1.a.b", null, undefined, ""])).resolves.toBeUndefined();
		await expect(gate(8, [])).resolves.toBeUndefined();
		const err = await denial(8, ["v1.a.b", "plain"]);
		expect(err).toMatchObject({ _tag: "Forbidden", path: "patient.create" });
	});
});

describe("Vault service", () => {
	let db: DbClient;
	let runtime: ManagedRuntime.ManagedRuntime<Vault | Secrets, never>;

	beforeAll(async () => {
		db = makeDb(makeTestD1(DDL));
		await seedGroup(db, TENANT_ID);
		await seedGroup(db, 8, true);
		runtime = makeRuntime(db);
	});

	it("enrolls the caller's device under their principal", async () => {
		const row = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.enrollDevice({ tenantId: TENANT_ID, wrapPublicKey: "wS", signPublicKey: "sS" }),
			),
			{ role: "member", userId: "u-member" },
		);
		expect(row.userId).toBe("u-member");
		expect(row.status).toBe("pending");
	});

	it("lists the tenant's devices for the admin UI", async () => {
		const devices = await run(
			runtime,
			Effect.flatMap(Vault, (v) => v.devices(TENANT_ID)),
			{ role: "admin" },
		);
		expect(devices.length).toBeGreaterThan(0);
		expect(devices.every((d) => d.tenantId === TENANT_ID)).toBe(true);
	});

	it("records empty actor ids when no principal is bound (system context)", async () => {
		// run() always binds a Principal — bind null explicitly to cover
		// the `?.userId ?? ""`/`?? null` fallbacks (jobs/system paths).
		const runSystem = <A, E>(effect: Effect.Effect<A, E, Vault | Secrets>) =>
			runtime.runPromise(
				effect.pipe(
					Effect.provideService(Tenant, {
						id: TENANT_ID,
						kind: "clinic",
						slug: "clinic-7",
						role: "admin" as TenantRole,
					}),
					Effect.provideService(Principal, null),
				),
			);
		const row = await runSystem(
			Effect.flatMap(Vault, (v) =>
				v.enrollDevice({ tenantId: TENANT_ID, wrapPublicKey: "wSys", signPublicKey: "sSys" }),
			),
		);
		expect(row.userId).toBe("");
		const approved = await runSystem(
			Effect.flatMap(Vault, (v) =>
				v.approveDevice({ tenantId: TENANT_ID, clinicKeyId: row.id, wrappedMasterKey: "w1.s" }),
			),
		);
		expect(approved.approvedByUserId).toBe("");
		await runSystem(
			Effect.flatMap(Vault, (v) =>
				v.grantAccess({
					tenantId: TENANT_ID,
					entityType: "patient",
					entityId: 1,
					grants: [
						{
							readerKind: "device" as const,
							readerPubkey: "wSys",
							wrappedDek: "w1.a.b.c",
						},
					],
				}),
			),
		);
		const readers = await runSystem(
			Effect.flatMap(Vault, (v) => v.readers(TENANT_ID, "patient", 1)),
		);
		expect(readers[0]?.grantedByUserId).toBeNull();
	});

	it("fails device-not-found on unknown device ids", async () => {
		const approveExit = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.approveDevice({ tenantId: TENANT_ID, clinicKeyId: 9999, wrappedMasterKey: "w1.x" }),
			).pipe(Effect.exit),
			{ role: "admin" },
		);
		expect(approveExit._tag).toBe("Failure");
		const revokeExit = await run(
			runtime,
			Effect.flatMap(Vault, (v) => v.revokeDevice({ tenantId: TENANT_ID, clinicKeyId: 9999 })).pipe(
				Effect.exit,
			),
			{ role: "member" },
		);
		expect(revokeExit._tag).toBe("Failure");
	});

	it("fails closed without a member role", async () => {
		const exit = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.enrollDevice({ tenantId: TENANT_ID, wrapPublicKey: "wX", signPublicKey: "sX" }),
			).pipe(Effect.exit),
			{ role: null },
		);
		expect(exit._tag).toBe("Failure");
	});

	it("rejects cross-tenant operations with tenant-mismatch", async () => {
		const exit = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.enrollDevice({ tenantId: 8, wrapPublicKey: "wY", signPublicKey: "sY" }),
			).pipe(Effect.exit),
			{ role: "member" }, // bound tenant is 7, target is 8
		);
		expect(exit._tag).toBe("Failure");
	});

	it("approves devices at admin+ and stores the envelope", async () => {
		const pending = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.enrollDevice({ tenantId: TENANT_ID, wrapPublicKey: "wD", signPublicKey: "sD" }),
			),
			{ role: "member", userId: "u-member" },
		);
		// member can't approve
		const denied = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.approveDevice({ tenantId: TENANT_ID, clinicKeyId: pending.id, wrappedMasterKey: "w1.a" }),
			).pipe(Effect.exit),
			{ role: "member" },
		);
		expect(denied._tag).toBe("Failure");
		// admin approves
		const approved = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.approveDevice({ tenantId: TENANT_ID, clinicKeyId: pending.id, wrappedMasterKey: "w1.a" }),
			),
			{ role: "admin", userId: "u-admin" },
		);
		expect(approved.status).toBe("approved");
		expect(approved.wrappedMasterKey).toBe("w1.a");
		expect(approved.approvedByUserId).toBe("u-admin");
		// second approval fails — not pending anymore
		const again = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.approveDevice({ tenantId: TENANT_ID, clinicKeyId: pending.id, wrappedMasterKey: "w1.b" }),
			).pipe(Effect.exit),
			{ role: "admin" },
		);
		expect(again._tag).toBe("Failure");
	});

	it("lets a member revoke their own device but not another's", async () => {
		const mine = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.enrollDevice({ tenantId: TENANT_ID, wrapPublicKey: "wMine", signPublicKey: "sMine" }),
			),
			{ role: "member", userId: "u-me" },
		);
		const revoked = await run(
			runtime,
			Effect.flatMap(Vault, (v) => v.revokeDevice({ tenantId: TENANT_ID, clinicKeyId: mine.id })),
			{ role: "member", userId: "u-me" },
		);
		expect(revoked.status).toBe("revoked");
		// member revoking someone else's device → forbidden
		const other = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.enrollDevice({ tenantId: TENANT_ID, wrapPublicKey: "wOther", signPublicKey: "sOther" }),
			),
			{ role: "member", userId: "u-other" },
		);
		const denied = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.revokeDevice({ tenantId: TENANT_ID, clinicKeyId: other.id }),
			).pipe(Effect.exit),
			{ role: "member", userId: "u-me" },
		);
		expect(denied._tag).toBe("Failure");
	});

	it("serves dek envelopes to member readers and lists readers", async () => {
		await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.grantAccess({
					tenantId: TENANT_ID,
					entityType: "consultation",
					entityId: 9,
					grants: [
						{
							readerKind: "device" as const,
							readerPubkey: "wD",
							wrappedDek: "w1.a.b.c",
						},
					],
				}),
			),
			{ role: "member", userId: "u-member" },
		);
		const env = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.dekEnvelope({
					tenantId: TENANT_ID,
					entityType: "consultation",
					entityId: 9,
					readerPubkey: "wD",
				}),
			),
			{ role: "member" },
		);
		expect(env).toBe("w1.a.b.c");
		const readers = await run(
			runtime,
			Effect.flatMap(Vault, (v) => v.readers(TENANT_ID, "consultation", 9)),
			{ role: "member" },
		);
		expect(readers).toHaveLength(1);
		expect(readers[0]!.readerPubkey).toBe("wD");
		// Revoke is holder-gated too — u-member's approved device wD
		// holds the envelope, so the write is allowed.
		await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.revokeAccess({
					tenantId: TENANT_ID,
					entityType: "consultation",
					entityId: 9,
					readerPubkey: "wD",
				}),
			),
			{ role: "member", userId: "u-member" },
		);
		expect(
			await run(
				runtime,
				Effect.flatMap(Vault, (v) =>
					v.dekEnvelope({
						tenantId: TENANT_ID,
						entityType: "consultation",
						entityId: 9,
						readerPubkey: "wD",
					}),
				),
				{ role: "member" },
			),
		).toBeNull();
	});

	it("denies a member re-granting a record their devices cannot read", async () => {
		// Claim consultation/10 for u-member's approved device wD — the
		// open first write on an unclaimed record.
		await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.grantAccess({
					tenantId: TENANT_ID,
					entityType: "consultation",
					entityId: 10,
					grants: [
						{
							readerKind: "device" as const,
							readerPubkey: "wD",
							wrappedDek: "w1.a.b.c",
						},
					],
				}),
			),
			{ role: "member", userId: "u-member" },
		);
		// u-other holds no envelope for it — overwriting wD's row must
		// fail, not clobber.
		const denied = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v
					.grantAccess({
						tenantId: TENANT_ID,
						entityType: "consultation",
						entityId: 10,
						grants: [
							{
								readerKind: "device" as const,
								readerPubkey: "wD",
								wrappedDek: "w1.e.f.g",
							},
						],
					})
					.pipe(Effect.exit),
			),
			{ role: "member", userId: "u-other" },
		);
		expect(denied._tag).toBe("Failure");
		// The stored envelope is untouched.
		const env = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.dekEnvelope({
					tenantId: TENANT_ID,
					entityType: "consultation",
					entityId: 10,
					readerPubkey: "wD",
				}),
			),
			{ role: "member" },
		);
		expect(env).toBe("w1.a.b.c");
		// u-other cannot revoke it either.
		const revoked = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v
					.revokeAccess({
						tenantId: TENANT_ID,
						entityType: "consultation",
						entityId: 10,
						readerPubkey: "wD",
					})
					.pipe(Effect.exit),
			),
			{ role: "member", userId: "u-other" },
		);
		expect(revoked._tag).toBe("Failure");
	});

	it("lets a member re-grant a record their approved device already reads", async () => {
		// u-member's approved device wD holds consultation/10's envelope —
		// re-granting (DEK re-wrap) is delegation, not vandalism.
		const rows = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.grantAccess({
					tenantId: TENANT_ID,
					entityType: "consultation",
					entityId: 10,
					grants: [
						{
							readerKind: "device" as const,
							readerPubkey: "wD",
							wrappedDek: "w1.h.i.j",
						},
					],
				}),
			),
			{ role: "member", userId: "u-member" },
		);
		expect(rows).toHaveLength(1);
	});

	it("rejects malformed wrappedDek envelopes before any write", async () => {
		const exit = await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v
					.grantAccess({
						tenantId: TENANT_ID,
						entityType: "patient",
						entityId: 10,
						grants: [
							{
								readerKind: "device" as const,
								readerPubkey: "wD",
								wrappedDek: "w1.only.two",
							},
						],
					})
					.pipe(Effect.exit),
			),
			{ role: "member", userId: "u-member" },
		);
		expect(exit._tag).toBe("Failure");
		expect(
			await run(
				runtime,
				Effect.flatMap(Vault, (v) => v.readers(TENANT_ID, "patient", 10)),
				{ role: "member" },
			),
		).toHaveLength(0);
	});

	it("bootstrap grants establish the set authoritatively, wiping planted rows", async () => {
		// First write on an unclaimed record stays open — a member can
		// seed it (creation-time semantics without the flag).
		await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.grantAccess({
					tenantId: TENANT_ID,
					entityType: "patient",
					entityId: 77,
					grants: [
						{
							readerKind: "device" as const,
							readerPubkey: "wD",
							wrappedDek: "w1.p.q.r",
						},
					],
				}),
			),
			{ role: "member", userId: "u-member" },
		);
		// The creation bootstrap replaces the whole set — anything
		// planted before the record existed cannot survive it.
		await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.grantAccess({
					tenantId: TENANT_ID,
					entityType: "patient",
					entityId: 77,
					bootstrap: true,
					grants: [
						{
							readerKind: "patient" as const,
							readerPubkey: "patW",
							wrappedDek: "w1.s.t.u",
						},
					],
				}),
			),
			{ role: "member", userId: "u-member" },
		);
		const readers = await run(
			runtime,
			Effect.flatMap(Vault, (v) => v.readers(TENANT_ID, "patient", 77)),
			{ role: "member" },
		);
		expect(readers.map((r) => r.readerPubkey)).toEqual(["patW"]);
	});

	it("audit-logs grant and revoke writes when the Audit service is bound", async () => {
		const calls: AuditEntryInput[] = [];
		const audit = Audit.of({
			record: (entry: AuditEntryInput) =>
				Effect.sync(() => {
					calls.push(entry);
				}),
			adminList: () => Effect.die("audit stub: adminList"),
			adminVerify: () => Effect.die("audit stub: adminVerify"),
			adminFacets: () => Effect.die("audit stub: adminFacets"),
			activityAccess: () => Effect.succeed(false),
			activityList: () => Effect.die("audit stub: activityList"),
			activityFacets: () => Effect.die("audit stub: activityFacets"),
			patientList: () => Effect.die("audit stub: patientList"),
			patientFacets: () => Effect.die("audit stub: patientFacets"),
		});
		const runAudited = <A, E>(effect: Effect.Effect<A, E, Vault | Secrets>) =>
			runtime.runPromise(
				effect.pipe(
					Effect.provideService(Audit, audit),
					Effect.provideService(Tenant, {
						id: TENANT_ID,
						kind: "clinic",
						slug: "clinic-7",
						role: "admin" as TenantRole,
					}),
					Effect.provideService(Principal, { userId: "u-admin" }),
				),
			);
		await runAudited(
			Effect.flatMap(Vault, (v) =>
				v.grantAccess({
					tenantId: TENANT_ID,
					entityType: "patient",
					entityId: 88,
					grants: [
						{
							readerKind: "device" as const,
							readerPubkey: "wAudit",
							readerId: "dev-1",
							wrappedDek: "w1.m.n.o",
						},
						{
							readerKind: "patient" as const,
							readerPubkey: "patAudit",
							wrappedDek: "w1.p.q.r",
						},
					],
				}),
			),
		);
		await runAudited(
			Effect.flatMap(Vault, (v) =>
				v.revokeAccess({
					tenantId: TENANT_ID,
					entityType: "patient",
					entityId: 88,
					readerPubkey: "wAudit",
				}),
			),
		);
		expect(calls.map((c) => c.action)).toEqual([
			"vault.entity-dek.grant",
			"vault.entity-dek.revoke",
		]);
		expect(calls[0]).toMatchObject({
			targetType: "entity_deks",
			targetId: "patient:88",
			tenantId: TENANT_ID,
		});
		expect(calls[0]?.detail?.readers).toEqual([
			{ kind: "device", pubkey: "wAudit", readerId: "dev-1" },
			{ kind: "patient", pubkey: "patAudit", readerId: null },
		]);
		// Revoke carries a bare pubkey — no kind/readerId correlation.
		expect(calls[1]?.detail?.readers).toEqual([{ pubkey: "wAudit" }]);
	});

	it("denies grant writes on claimed records to principals with no user id", async () => {
		// Claim patient/89 — the record now requires a held envelope.
		await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.grantAccess({
					tenantId: TENANT_ID,
					entityType: "patient",
					entityId: 89,
					grants: [
						{
							readerKind: "device" as const,
							readerPubkey: "wHeld",
							wrappedDek: "w1.x.y.z",
						},
					],
				}),
			),
			{ role: "admin" },
		);
		// Empty-string and absent user ids both resolve to "no approved
		// devices" — the hold-check must fail closed with not-a-reader.
		for (const principal of [{ userId: "" }, null] as const) {
			const exit = await runtime.runPromise(
				Effect.flatMap(Vault, (v) =>
					v.grantAccess({
						tenantId: TENANT_ID,
						entityType: "patient",
						entityId: 89,
						grants: [
							{
								readerKind: "device" as const,
								readerPubkey: "wNew",
								wrappedDek: "w1.x.y.z",
							},
						],
					}),
				).pipe(
					Effect.exit,
					Effect.provideService(Tenant, {
						id: TENANT_ID,
						kind: "clinic",
						slug: "clinic-7",
						role: "member" as TenantRole,
					}),
					Effect.provideService(Principal, principal),
				),
			);
			expect(exit._tag).toBe("Failure");
		}
	});

	it("isZk reflects the bound tenant's flag, false when mismatched", async () => {
		expect(
			await run(
				runtime,
				Effect.flatMap(Vault, (v) => v.isZk(TENANT_ID)),
				{ role: "member" },
			),
		).toBe(false);
		// Bound tenant is 7 but tenant 8 is ZK → out-of-scope read = false.
		expect(
			await run(
				runtime,
				Effect.flatMap(Vault, (v) => v.isZk(8)),
				{ role: "member" },
			),
		).toBe(false);
	});

	it("exposes deviceEnrollment for the client's status poll", async () => {
		await run(
			runtime,
			Effect.flatMap(Vault, (v) =>
				v.enrollDevice({ tenantId: TENANT_ID, wrapPublicKey: "wPoll", signPublicKey: "sPoll" }),
			),
			{ role: "member", userId: "u-poll" },
		);
		const row = await run(
			runtime,
			Effect.flatMap(Vault, (v) => v.deviceEnrollment(TENANT_ID, "wPoll")),
			{ role: "member" },
		);
		expect(row?.status).toBe("pending");
		expect(
			await run(
				runtime,
				Effect.flatMap(Vault, (v) => v.deviceEnrollment(TENANT_ID, "wNope")),
				{ role: "member" },
			),
		).toBeNull();
	});

	it("enableZk is admin-only and one-way", async () => {
		const denied = await run(
			runtime,
			Effect.flatMap(Vault, (v) => v.enableZk(TENANT_ID)).pipe(Effect.exit),
			{ role: "member" },
		);
		expect(denied._tag).toBe("Failure");
		expect(await tenantIsZk(db, TENANT_ID)).toBe(false);
		await run(
			runtime,
			Effect.flatMap(Vault, (v) => v.enableZk(TENANT_ID)),
			{ role: "admin" },
		);
		expect(await tenantIsZk(db, TENANT_ID)).toBe(true);
	});

	it("exposes the vault page loader — bound-tenant scope only", async () => {
		const loader = vaultPagesPlugin.pages[0]!.loader!;
		// Personal scope (no bound tenant) → null fields, no rows.
		const personal = await run(runtime, loader(), { role: null });
		expect(personal).toEqual({
			tenantId: null,
			role: null,
			zk: false,
			devices: [],
			secrets: [],
		});
		// Bound tenant → id/role/zk plus the member-visible device list.
		const scoped = (await run(runtime, loader(), {
			role: "admin",
		})) as { tenantId: number; role: string; zk: boolean; devices: unknown[] };
		expect(scoped.tenantId).toBe(TENANT_ID);
		expect(scoped.role).toBe("admin");
		expect(Array.isArray(scoped.devices)).toBe(true);
		// A role below member degrades the device list to [] (denial as data).
		const denied = (await run(runtime, loader(), {
			role: "viewer" as TenantRole,
		})) as { devices: unknown[] };
		expect(denied.devices).toEqual([]);
	});
});

describe("vault plugins", () => {
	it("exports the tables + services + pages + chrome plugins for host discovery", () => {
		expect(plugins).toEqual([
			vaultTablesPlugin,
			vaultServicesPlugin,
			vaultSecretsPlugin,
			vaultPagesPlugin,
			vaultChromePlugin,
		]);
		expect(vaultTablesPlugin.id).toBe("vault.tables");
		expect(vaultServicesPlugin.id).toBe("vault.services");
		expect(vaultSecretsPlugin.id).toBe("vault.secrets");
		expect(vaultPagesPlugin.id).toBe("vault.pages");
		expect(vaultPagesPlugin.pages.map((p) => p.path)).toEqual([
			"/portal/doctor/vault",
			"/portal/secretary/vault",
		]);
		expect(vaultChromePlugin.id).toBe("vault.chrome");
		expect(vaultChromePlugin.chrome.map((c) => c.portal)).toEqual(["doctor", "secretary"]);
	});

	it("gates the page and sidebar entry to tenant admins", async () => {
		for (const page of vaultPagesPlugin.pages) {
			expect(page.guard).toBeDefined();
		}
		const guard = vaultPagesPlugin.pages[0]!.guard!;
		const asRole = (role: TenantRole) =>
			Effect.runPromise(
				guard().pipe(
					Effect.provideService(Tenant, {
						id: TENANT_ID,
						kind: "clinic",
						slug: "clinic-7",
						role,
					}),
				),
			);
		// No bound tenant (personal scope) and member-or-below → denied.
		await expect(Effect.runPromise(guard())).resolves.toBe(false);
		await expect(asRole("member")).resolves.toBe(false);
		await expect(asRole("admin")).resolves.toBe(true);
		await expect(asRole("owner")).resolves.toBe(true);
		for (const contribution of vaultChromePlugin.chrome) {
			expect(contribution.when?.minUserCounts).toEqual({
				tenantRoleRank: TENANT_ROLE_RANK.admin,
			});
		}
	});
});
