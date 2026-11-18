import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { eq } from "drizzle-orm";

import { Principal } from "@ktb/authz";
import { Tenant, type TenantRole } from "@ktb/tenant";
import { SecretKeyring } from "@ktb/crypto/secret-keyring";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { secretKeyringLive } from "@ktb/vault-keyring";

import {
	Secrets,
	SecretsLive,
	SecretError,
	VAULT_TEST_DDL,
	vaultSecret,
	secretRefFor,
} from "./index.ts";
import { getSecretById } from "./secrets.ts";

/**
 * Pen-test-lite (P-098 C5): attack scenarios against the secrets store.
 * Each test names the threat it exercises — these are the cases an
 * attacker with DB read/write or ref-guessing ability would try.
 */

const DDL =
	`CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user (id) VALUES ('u1');` + VAULT_TEST_DDL;
const TENANT_ID = 7;
const OTHER_TENANT_ID = 9;
const MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

const makeRuntime = (db: DbClient) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		secretKeyringLive(MASTER_KEY) as Layer.Layer<SecretKeyring>,
	);
	return ManagedRuntime.make(SecretsLive.pipe(Layer.provide(infra)));
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<Secrets, never>,
	effect: Effect.Effect<A, E, Secrets>,
	options: { tenantId?: number | null; role?: TenantRole } = {},
) =>
	runtime.runPromise(
		effect.pipe(
			Effect.provideService(
				Tenant,
				options.tenantId === undefined || options.tenantId === null
					? null
					: {
							id: options.tenantId,
							kind: "clinic",
							slug: `clinic-${options.tenantId}`,
							role: options.role ?? "admin",
						},
			),
			Effect.provideService(Principal, { userId: "u1", email: "admin@x.com" }),
		),
	);

const putSecret = (
	rt: ManagedRuntime.ManagedRuntime<Secrets, never>,
	name: string,
	value: string,
	scope: { tenantId: number | null } = { tenantId: null },
) =>
	run(
		rt,
		Effect.flatMap(Secrets, (s) => s.put({ ...scope, name, value })),
		{ tenantId: scope.tenantId },
	);

describe("vault pen-test-lite", () => {
	let db: DbClient;
	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		for (const id of [TENANT_ID, OTHER_TENANT_ID]) {
			await db.insert(groups).values({
				id,
				name: `Clinic ${id}`,
				slug: `clinic-${id}`,
				kind: "clinic",
				createdAt: new Date(),
				updatedAt: new Date(),
			});
		}
	});

	it("TAMPER: flipped ciphertext bit → typed decrypt failure, never plaintext", async () => {
		const rt = makeRuntime(db);
		const meta = await putSecret(rt, "tamper-c", "topsecret-A");
		const row = await getSecretById(db, meta.id);
		// Attacker with DB write flips a byte inside the envelope.
		const tampered = row!.ciphertext.slice(0, -2) + (row!.ciphertext.endsWith("A") ? "B" : "A");
		await db.update(vaultSecret).set({ ciphertext: tampered }).where(eq(vaultSecret.id, meta.id));
		await expect(
			run(
				rt,
				Effect.flatMap(Secrets, (s) => s.resolve(secretRefFor(meta.id))),
			),
		).rejects.toMatchObject({ reason: "decrypt-failed" });
	});

	it("TAMPER: transplanted envelope onto another row → AAD rejects it", async () => {
		const rt = makeRuntime(db);
		const a = await putSecret(rt, "aad-a", "value-A");
		const b = await putSecret(rt, "aad-b", "value-B");
		const rowA = await getSecretById(db, a.id);
		const rowB = await getSecretById(db, b.id);
		// Copy A's wrapped DEK + ciphertext onto B's row — AAD binds
		// (scope,name) so B can no longer open its own material.
		await db
			.update(vaultSecret)
			.set({ wrappedDek: rowA!.wrappedDek, ciphertext: rowA!.ciphertext })
			.where(eq(vaultSecret.id, b.id));
		await expect(
			run(
				rt,
				Effect.flatMap(Secrets, (s) => s.resolve(secretRefFor(b.id))),
			),
		).rejects.toMatchObject({ reason: "decrypt-failed" });
		// Restore B so later tests/rows stay consistent.
		await db
			.update(vaultSecret)
			.set({ wrappedDek: rowB!.wrappedDek, ciphertext: rowB!.ciphertext })
			.where(eq(vaultSecret.id, b.id));
	});

	it("TAMPER: swapped DEK envelopes between rows → unwrap fails closed", async () => {
		const rt = makeRuntime(db);
		const a = await putSecret(rt, "dek-a", "value-A");
		const b = await putSecret(rt, "dek-b", "value-B");
		const rowA = await getSecretById(db, a.id);
		const rowB = await getSecretById(db, b.id);
		await db
			.update(vaultSecret)
			.set({ wrappedDek: rowB!.wrappedDek })
			.where(eq(vaultSecret.id, a.id));
		await expect(
			run(
				rt,
				Effect.flatMap(Secrets, (s) => s.resolve(secretRefFor(a.id))),
			),
		).rejects.toBeInstanceOf(SecretError);
		await db
			.update(vaultSecret)
			.set({ wrappedDek: rowA!.wrappedDek })
			.where(eq(vaultSecret.id, a.id));
	});

	it("GUESS: malformed and boundary refs resolve null, never throw or leak", async () => {
		const rt = makeRuntime(db);
		for (const ref of [
			"vault:0",
			"vault:-1",
			"vault:1.5",
			"vault: 1",
			"vault:",
			"vault:abc",
			"VAULT:1",
			"vault:1 " + "x".repeat(100),
			"credential:1",
			"",
		]) {
			await expect(
				run(
					rt,
					Effect.flatMap(Secrets, (s) => s.resolve(ref)),
				),
			).resolves.toBeNull();
		}
	});

	it("DISABLE: non-active rows never resolve", async () => {
		const rt = makeRuntime(db);
		const meta = await putSecret(rt, "disabled-s", "hidden");
		await db.update(vaultSecret).set({ status: "disabled" }).where(eq(vaultSecret.id, meta.id));
		await expect(
			run(
				rt,
				Effect.flatMap(Secrets, (s) => s.resolve(secretRefFor(meta.id))),
			),
		).resolves.toBeNull();
	});

	it("SCOPE: same name in two tenants stays isolated; cross-tenant resolve of ref id still works only server-side", async () => {
		const rt = makeRuntime(db);
		const t1 = await putSecret(rt, "shared-name", "tenant-7-value", { tenantId: TENANT_ID });
		const t2 = await putSecret(rt, "shared-name", "tenant-9-value", { tenantId: OTHER_TENANT_ID });
		expect(t1.id).not.toBe(t2.id);
		// Refs are capabilities — resolve returns the right value per id.
		const v1 = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.resolve(secretRefFor(t1.id))),
		);
		const v2 = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.resolve(secretRefFor(t2.id))),
		);
		expect(v1).toBe("tenant-7-value");
		expect(v2).toBe("tenant-9-value");
	});

	it("AT-REST: every stored column is non-plaintext across scopes", async () => {
		const rt = makeRuntime(db);
		const meta = await putSecret(rt, "at-rest", "plaintext-canary-9f3");
		const row = await getSecretById(db, meta.id);
		for (const col of [row!.wrappedDek, row!.ciphertext]) {
			expect(col).not.toContain("plaintext-canary-9f3");
			expect(col.startsWith("v1.")).toBe(true);
		}
	});
});
