import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden, Principal } from "@ktb/authz";
import { SecretKeyring } from "@ktb/crypto/secret-keyring";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, TenantForbidden, type TenantRole } from "@ktb/tenant";
import { secretKeyringLive } from "@ktb/vault-keyring";

import { Secrets, SecretsLive, SecretError, VAULT_TEST_DDL } from "./index.ts";
import { getSecretById, listSecrets, parseSecretRef, secretRefFor } from "./secrets.ts";

const DDL =
	`CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user (id) VALUES ('u1');` + VAULT_TEST_DDL;
const TENANT_ID = 7;
const MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

const makeRuntime = (db: DbClient, opts: { keyring?: boolean } = {}) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		...(opts.keyring === false
			? []
			: [secretKeyringLive(MASTER_KEY) as Layer.Layer<SecretKeyring>]),
	);
	return ManagedRuntime.make(SecretsLive.pipe(Layer.provide(infra)));
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<Secrets, never>,
	effect: Effect.Effect<A, E, Secrets>,
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
				email: options.email ?? "admin@x.com",
			}),
		),
	);

describe("Secrets", () => {
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

	it("put/resolve round-trips a platform secret; ciphertext never equals plaintext", async () => {
		const rt = makeRuntime(db);
		const meta = await run(
			rt,
			Effect.flatMap(Secrets, (s) =>
				s.put({
					tenantId: null,
					name: "openai-prod",
					value: "sk-live-123",
					provider: "openai",
					kind: "api-key",
				}),
			),
		);
		expect(meta.id).toBeGreaterThan(0);
		expect(meta.version).toBe(1);
		const row = await getSecretById(db, meta.id);
		expect(row!.ciphertext).not.toContain("sk-live-123");
		expect(row!.wrappedDek).not.toContain("sk-live-123");
		const value = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.resolve(secretRefFor(meta.id))),
		);
		expect(value).toBe("sk-live-123");
	});

	it("resolve returns null for foreign refs, missing ids and non-vault spellings", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(Secrets, (s) => s.resolve("env:FOO")),
			),
		).resolves.toBeNull();
		await expect(
			run(
				rt,
				Effect.flatMap(Secrets, (s) => s.resolve("vault:9999")),
			),
		).resolves.toBeNull();
		await expect(
			run(
				rt,
				Effect.flatMap(Secrets, (s) => s.resolve("credential:abc")),
			),
		).resolves.toBeNull();
	});

	it("put upserts on (scope,name) and bumps version", async () => {
		const rt = makeRuntime(db);
		const first = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.put({ tenantId: null, name: "smtp", value: "pw1" })),
		);
		const second = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.put({ tenantId: null, name: "smtp", value: "pw2" })),
		);
		expect(second.id).toBe(first.id);
		expect(second.version).toBe(2);
		const rows = await listSecrets(db, "platform");
		expect(rows.filter((r) => r.name === "smtp")).toHaveLength(1);
	});

	it("rotate keeps the value stable, bumps version, stamps rotatedAt", async () => {
		const rt = makeRuntime(db);
		const meta = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.put({ tenantId: null, name: "rot-me", value: "v1" })),
		);
		const rotated = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.rotate({ id: meta.id })),
		);
		expect(rotated.version).toBe(2);
		expect(rotated.rotatedAt).not.toBeNull();
		const value = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.resolve(secretRefFor(meta.id))),
		);
		expect(value).toBe("v1");
	});

	it("platform writes fail for non-admin principals", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(Secrets, (s) => s.put({ tenantId: null, name: "nope", value: "x" })),
				{
					email: "user@x.com",
				},
			),
		).rejects.toThrow(Forbidden);
	});

	it("tenant scope: member reads, admin writes, cross-tenant denied", async () => {
		const rt = makeRuntime(db);
		const denied = run(
			rt,
			Effect.flatMap(Secrets, (s) => s.put({ tenantId: TENANT_ID, name: "byok", value: "k" })),
			{ role: "member" },
		);
		await expect(denied).rejects.toThrow(TenantForbidden);
		const meta = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.put({ tenantId: TENANT_ID, name: "byok", value: "k" })),
			{ role: "admin" },
		);
		expect(meta.scope).toBe(String(TENANT_ID));
		const list = await run(
			rt,
			Effect.flatMap(Secrets, (s) => s.list({ tenantId: TENANT_ID })),
			{ role: "member" },
		);
		expect(list.some((m) => m.name === "byok")).toBe(true);
	});

	it("fails closed when no SecretKeyring is bound", async () => {
		const rt = makeRuntime(db, { keyring: false });
		await expect(
			run(
				rt,
				Effect.flatMap(Secrets, (s) => s.put({ tenantId: null, name: "x", value: "y" })),
			),
		).rejects.toThrow(SecretError);
	});

	it("parseSecretRef/secretRefFor round-trip", () => {
		expect(parseSecretRef(secretRefFor(42))).toBe(42);
		expect(parseSecretRef("vault:0")).toBeNull();
		expect(parseSecretRef("vault:abc")).toBeNull();
		expect(parseSecretRef("other:1")).toBeNull();
	});
});
