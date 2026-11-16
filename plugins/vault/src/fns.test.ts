import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const headers = { current: new Headers() };

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => headers.current,
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

import { vaultServicesPlugin, VAULT_TEST_DDL } from "./index.ts";
import {
	vaultApproveDeviceFn,
	vaultDevicesFn,
	vaultEnableZkFn,
	vaultEnrollDeviceFn,
	vaultEnrollmentFn,
	vaultRevokeDeviceFn,
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
		const services = (vaultServicesPlugin.services as Layer.Layer<unknown, unknown, unknown>).pipe(
			Layer.provideMerge(env),
		) as unknown as Layer.Layer<unknown, never, never>;
		runtime = ManagedRuntime.make(services);
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
		expect(await vaultEnrollmentFn({ data: { wrapPublicKey: "w" } })).toBeNull();
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
});
