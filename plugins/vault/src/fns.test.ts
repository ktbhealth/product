import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const headers = { current: new Headers() };

vi.mock("@tanstack/react-start/server", () => ({
	// Fresh Headers per call: @ktb/server-fns memoizes session lookups
	// per request keyed on the Headers identity.
	getRequestHeaders: () => new Headers(headers.current),
}));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const chain = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return chain;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (arg?: { data?: unknown }) =>
				h(arg === undefined ? {} : { ...arg, data: validate ? validate(arg.data) : arg.data }),
		};
		return chain;
	},
}));

import { Auth } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { resetServerRuntime, setServerRuntime } from "@ktb/server-fns";
import { Tenant, type TenantRole } from "@ktb/tenant";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { PlatformAdmin, makePlatformAdminGate, parsePlatformAdminEmails } from "@ktb/platform";
import { secretKeyringLive } from "@ktb/vault-keyring";

import { vaultSecretsPlugin, vaultServicesPlugin, VAULT_TEST_DDL } from "./index.ts";
import {
	vaultApproveDeviceFn,
	vaultDekEnvelopesFn,
	vaultDevicesFn,
	vaultEnableZkFn,
	vaultEnrollDeviceFn,
	vaultEnrollmentFn,
	vaultGrantAccessFn,
	vaultRevokeDeviceFn,
	vaultSecretPutFn,
	vaultSecretsListFn,
	vaultSecretRemoveFn,
	vaultSecretRotateFn,
	vaultStateFn,
} from "./fns.ts";

const DDL = `${VAULT_TEST_DDL}
INSERT INTO groups (id, name, slug, kind) VALUES (7, 'Clinic A', 'clinic-a', 'clinic');
`;

const sessionFor = (email: string | null) =>
	email === null
		? null
		: {
				user: { id: `id-${email}`, email, name: email },
				sessionId: "s1",
				expiresAt: new Date(Date.now() + 3600_000),
			};

const TENANT_FOR = (role: TenantRole | null) =>
	role === null ? null : { id: 7, kind: "clinic", slug: "clinic-a", role };

describe("vault fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	let currentRole: TenantRole | null = null;

	beforeAll(async () => {
		const db = makeDb(makeD1(DDL));
		const env = Layer.succeed(Db, db);
		const servicesLayer = (plugin: { services?: unknown }) =>
			(plugin.services as Layer.Layer<unknown, unknown, unknown>).pipe(
				Layer.provideMerge(env),
			) as unknown as Layer.Layer<unknown, never, never>;
		// Secrets needs the keyring port too — the env driver under test.
		const secretsEnv = Layer.mergeAll(
			env,
			secretKeyringLive("0".repeat(64)) as Layer.Layer<unknown>,
			Layer.succeed(
				PlatformAdmin,
				makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
			) as Layer.Layer<unknown>,
		);
		const secretsLayer = (
			vaultSecretsPlugin.services as Layer.Layer<unknown, unknown, unknown>
		).pipe(Layer.provideMerge(secretsEnv)) as unknown as Layer.Layer<unknown, never, never>;
		const services = Layer.mergeAll(servicesLayer(vaultServicesPlugin), secretsLayer);
		runtime = ManagedRuntime.make(services as Layer.Layer<unknown, never, never>);
		const auth = Auth.of({
			setUserBanned: async () => {},
			getSession: async () => sessionFor(currentEmail) as never,
		});
		setServerRuntime({
			run: (effect) => runtime.runPromise(effect.pipe(Effect.provideService(Auth, auth))),
			runAs: (user, effect) =>
				runtime.runPromise(
					effect.pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
						}),
						Effect.provideService(Tenant, TENANT_FOR(currentRole)),
					),
				),
			audioTranscribeModel: "test-model",
			getLocale: () => "en",
		});
	});

	afterAll(() => {
		resetServerRuntime();
		return runtime.dispose();
	});

	it("reports personal scope when no tenant is bound", async () => {
		currentEmail = "user@x.com";
		currentRole = null;
		expect(await vaultStateFn()).toEqual({ tenantId: null, role: null, zk: false });
		expect(await vaultDevicesFn()).toEqual([]);
		expect(await vaultEnrollmentFn({ data: { wrapPublicKey: "w" } })).toBeNull();
		expect(
			await vaultDekEnvelopesFn({
				data: { entityType: "patient", entityIds: [1], wrapPublicKey: "w" },
			}),
		).toEqual({});
		expect(
			await vaultGrantAccessFn({
				data: {
					entityType: "patient",
					entityId: 1,
					grants: [{ readerKind: "device", readerPubkey: "w", wrappedDek: "w1.x" }],
				},
			}),
		).toEqual({ ok: false });
		expect(await vaultEnrollDeviceFn({ data: { wrapPublicKey: "w", signPublicKey: "s" } })).toEqual(
			{ ok: false },
		);
		expect(await vaultEnableZkFn()).toEqual({ ok: false });
		expect(
			await vaultApproveDeviceFn({ data: { clinicKeyId: 1, wrappedMasterKey: "w1.x" } }),
		).toEqual({ ok: false });
		expect(await vaultRevokeDeviceFn({ data: { clinicKeyId: 1 } })).toEqual({ ok: false });
	});

	it("rejects anonymous callers on mutating fns", async () => {
		currentEmail = null;
		currentRole = "admin";
		await expect(
			vaultEnrollDeviceFn({ data: { wrapPublicKey: "w", signPublicKey: "s" } }),
		).rejects.toThrow("unauthenticated");
		await expect(vaultEnableZkFn()).rejects.toThrow("unauthenticated");
		await expect(
			vaultApproveDeviceFn({ data: { clinicKeyId: 1, wrappedMasterKey: "w1.x" } }),
		).rejects.toThrow("unauthenticated");
		await expect(vaultRevokeDeviceFn({ data: { clinicKeyId: 1 } })).rejects.toThrow(
			"unauthenticated",
		);
		// Read fns degrade instead.
		expect(await vaultStateFn()).toEqual({ tenantId: null, role: null, zk: false });
		expect(await vaultDevicesFn()).toEqual([]);
		expect(await vaultSecretsListFn()).toEqual([]);
		expect(await vaultEnrollmentFn({ data: { wrapPublicKey: "w" } })).toBeNull();
		expect(
			await vaultDekEnvelopesFn({
				data: { entityType: "patient", entityIds: [1], wrapPublicKey: "w" },
			}),
		).toEqual({});
		await expect(
			vaultGrantAccessFn({
				data: {
					entityType: "patient",
					entityId: 1,
					grants: [{ readerKind: "device", readerPubkey: "w", wrappedDek: "w1.x" }],
				},
			}),
		).rejects.toThrow("unauthenticated");
	});

	it("runs the member enrollment → admin approval lifecycle", async () => {
		currentEmail = "member@x.com";
		currentRole = "member";

		const enrolled = await vaultEnrollDeviceFn({
			data: { wrapPublicKey: "wMem", signPublicKey: "sMem" },
		});
		expect(enrolled.ok).toBe(true);
		expect(enrolled.ok && enrolled.data.status).toBe("pending");
		expect(enrolled.ok && enrolled.data.userId).toBe("id-member@x.com");

		const own = await vaultEnrollmentFn({ data: { wrapPublicKey: "wMem" } });
		expect(own?.status).toBe("pending");

		// Members cannot approve; admins can.
		expect(
			await vaultApproveDeviceFn({ data: { clinicKeyId: own!.id, wrappedMasterKey: "w1.a" } }),
		).toEqual({ ok: false });

		currentEmail = "admin@x.com";
		currentRole = "admin";
		const approved = await vaultApproveDeviceFn({
			data: { clinicKeyId: own!.id, wrappedMasterKey: "w1.a" },
		});
		expect(approved.ok).toBe(true);

		// Approving a non-pending device fails; a missing device does too.
		expect(
			await vaultApproveDeviceFn({ data: { clinicKeyId: own!.id, wrappedMasterKey: "w1.b" } }),
		).toEqual({ ok: false });
		expect(
			await vaultApproveDeviceFn({ data: { clinicKeyId: 9999, wrappedMasterKey: "w1.b" } }),
		).toEqual({ ok: false });
	});

	it("lets the owner revoke their own device and admins any", async () => {
		currentEmail = "member@x.com";
		currentRole = "member";
		const enrolled = await vaultEnrollDeviceFn({
			data: { wrapPublicKey: "wRev", signPublicKey: "sRev" },
		});
		expect(enrolled.ok).toBe(true);
		const id = enrolled.ok ? enrolled.data.id : -1;
		expect((await vaultRevokeDeviceFn({ data: { clinicKeyId: id } })).ok).toBe(true);
		// Another member cannot revoke someone else's device.
		currentEmail = "other@x.com";
		expect((await vaultRevokeDeviceFn({ data: { clinicKeyId: id } })).ok).toBe(false);
		// Admin revokes; missing id fails.
		currentEmail = "admin@x.com";
		currentRole = "admin";
		expect((await vaultRevokeDeviceFn({ data: { clinicKeyId: 9999 } })).ok).toBe(false);
	});

	it("lists devices and flips zk under admin", async () => {
		currentEmail = "admin@x.com";
		currentRole = "admin";
		const devices = await vaultDevicesFn();
		expect(devices.length).toBeGreaterThan(0);
		expect(await vaultStateFn()).toEqual({ tenantId: 7, role: "admin", zk: false });
		expect(await vaultEnableZkFn()).toEqual({ ok: true, data: null });
		expect(await vaultStateFn()).toEqual({ tenantId: 7, role: "admin", zk: true });
	});

	it("denies zk enable to members", async () => {
		currentEmail = "member@x.com";
		currentRole = "member";
		expect(await vaultEnableZkFn()).toEqual({ ok: false });
	});

	it("stores record DEK grants and returns the caller's envelopes", async () => {
		currentEmail = "member@x.com";
		currentRole = "member";

		const grant = await vaultGrantAccessFn({
			data: {
				entityType: "patient",
				entityId: 42,
				grants: [
					{ readerKind: "device", readerPubkey: "wMem", wrappedDek: "w1.dek42" },
					{ readerKind: "device", readerPubkey: "wOther", wrappedDek: "w1.dek42b" },
				],
			},
		});
		expect(grant.ok).toBe(true);
		expect(grant.ok && grant.data).toHaveLength(2);

		// Only the caller's pubkey resolves; non-granted ids are absent.
		expect(
			await vaultDekEnvelopesFn({
				data: { entityType: "patient", entityIds: [42, 43], wrapPublicKey: "wMem" },
			}),
		).toEqual({ "42": "w1.dek42" });
		expect(
			await vaultDekEnvelopesFn({
				data: { entityType: "patient", entityIds: [42], wrapPublicKey: "wNobody" },
			}),
		).toEqual({});
	});

	it("manages tenant secrets end-to-end under admin (P-098 C2)", async () => {
		currentEmail = "admin@x.com";
		currentRole = "admin";

		const put = await vaultSecretPutFn({
			data: {
				name: "openai-prod",
				value: "sk-live-test-1",
				provider: "openai",
				kind: "api-key",
			},
		});
		expect(put.ok).toBe(true);
		const meta = put.ok ? put.data : null;
		expect(meta?.name).toBe("openai-prod");
		expect(meta?.tenantId).toBe(7);
		const id = meta!.id;

		// Metadata list never carries the value or ciphertext.
		const list = await vaultSecretsListFn();
		const row = list.find((r) => r.id === id);
		expect(row?.name).toBe("openai-prod");
		expect(JSON.stringify(list)).not.toContain("sk-live-test-1");

		// Upsert on (scope,name) bumps the version.
		const again = await vaultSecretPutFn({
			data: { name: "openai-prod", value: "sk-live-test-2", provider: "openai" },
		});
		expect(again.ok).toBe(true);
		expect(again.ok ? again.data.id : null).toBe(id);
		expect(again.ok ? again.data.version : null).toBe(2);

		const rotated = await vaultSecretRotateFn({ data: { id } });
		expect(rotated.ok).toBe(true);
		expect(rotated.ok ? rotated.data.version : null).toBe(3);

		const removed = await vaultSecretRemoveFn({ data: { id } });
		expect(removed.ok).toBe(true);
		expect((await vaultSecretsListFn()).some((r) => r.id === id)).toBe(false);
	});

	it("denies secret writes to members but allows listing", async () => {
		currentEmail = "member@x.com";
		currentRole = "member";

		const denied = await vaultSecretPutFn({ data: { name: "smtp", value: "pw" } });
		expect(denied.ok).toBe(false);
		// List is member-readable (metadata only).
		expect(Array.isArray(await vaultSecretsListFn())).toBe(true);
	});

	it("degrades secret fns in personal scope and on service errors", async () => {
		// Personal scope (no bound tenant): list → [], put → { ok: false }.
		currentEmail = "user@x.com";
		currentRole = null;
		expect(await vaultSecretsListFn()).toEqual([]);
		expect(await vaultSecretPutFn({ data: { name: "x", value: "y" } })).toEqual({ ok: false });

		// Tenant admin: blank-after-trim name → SecretError → { ok: false }.
		currentEmail = "admin@x.com";
		currentRole = "admin";
		expect(await vaultSecretPutFn({ data: { name: "   ", value: "y" } })).toEqual({
			ok: false,
		});
		// Unknown id → SecretError not-found on rotate/remove.
		expect(await vaultSecretRotateFn({ data: { id: 999999 } })).toEqual({ ok: false });
		expect(await vaultSecretRemoveFn({ data: { id: 999999 } })).toEqual({ ok: false });
	});
});
