import { beforeEach, describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Db } from "@ktb/db";
import { Tenant, type Tenant as TenantScope } from "@ktb/tenant";
import { Vault } from "@ktb/vault";

const mocks = vi.hoisted(() => ({
	ensureDoctorUser: vi.fn(async () => ({ id: "u1" })),
	ensureSessionUser: vi.fn(async () => ({ id: "u1" })),
	runAs: vi.fn<(user: unknown, effect: unknown) => Promise<unknown>>(async () => ({
		ok: true as const,
		patient: { id: 1 },
	})),
	getDoctorUser: vi.fn(async (): Promise<{ id: string } | null> => null),
	adminList: vi.fn(),
	batch: vi.fn(async (_stmts: unknown[]) => [] as unknown[]),
	create: vi.fn(),
	update: vi.fn(),
	adminCreate: vi.fn(),
	grantAccess: vi.fn(),
}));

// Same fake as session-fns.test.ts: handlers run as plain async fns
// and the validator is applied to the incoming `data`.
vi.mock("@tanstack/react-start", () => reactStartMock());
vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return {
		ensureDoctorUser: mocks.ensureDoctorUser,
		ensureSessionUser: mocks.ensureSessionUser,
		getDoctorAccess: vi.fn(),
		getDoctorUser: mocks.getDoctorUser,
		getLocale: vi.fn(),
		getServerRuntime: vi.fn(),
		getSessionUser: vi.fn(),
		purgeAudio: vi.fn(),
		runAs: mocks.runAs,
		forbiddenTo: actual.forbiddenTo,
		...actual.serverFnHandlerMocks(),
	};
});
/** Minimal DbClient — `deletePatientRow`'s rollback calls
 * `db.delete(table).where(cond)` + `db.batch(stmts)`; the P-101 tuple
 * cleanup then runs `db.delete(relationTuples).where(…).returning()`
 * (empty result → no epoch bump). */
const fakeDb = {
	delete: vi.fn(() => ({
		where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
	})),
	batch: mocks.batch,
} as unknown as Db["Service"];

import { Patients } from "./index.ts";
import { Forbidden } from "@ktb/authz";
import {
	adminCreatePatientFn,
	adminListPatientsFn,
	createPatientFn,
	updatePatientFn,
} from "./fns.ts";

const TENANT_ZK: TenantScope = { id: 9, kind: "clinic", slug: "clinica-zk", role: "member" };

/** Make `runAs` execute the effect against a minimal context — the
 * pieces createPatientFn touches: Patients, Db, Tenant and (optionally)
 * the Vault service. */
const runEffects = (
	opts: { readonly tenant?: TenantScope | null; readonly vault?: boolean } = {},
) => {
	const { tenant = TENANT_ZK, vault = true } = opts;
	const layer = Layer.mergeAll(
		Layer.succeed(Patients, {
			create: mocks.create,
			update: mocks.update,
			adminCreate: mocks.adminCreate,
		} as unknown as Patients["Service"]),
		Layer.succeed(Db, fakeDb),
		Layer.succeed(Tenant, tenant),
		...(vault
			? [Layer.succeed(Vault, { grantAccess: mocks.grantAccess } as unknown as Vault["Service"])]
			: []),
	);
	mocks.runAs.mockImplementation(async (_user, effect) =>
		Effect.runPromise(Effect.provide(effect as Effect.Effect<unknown, unknown>, layer)),
	);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.runAs.mockResolvedValue({ ok: true, patient: { id: 1 } });
	// Service methods yield Effects — not promises.
	mocks.create.mockReturnValue(Effect.succeed({ id: 1, tenantId: 9 }));
	mocks.update.mockReturnValue(Effect.succeed({ id: 5 }));
	mocks.adminCreate.mockReturnValue(Effect.succeed({ id: 2 }));
	mocks.grantAccess.mockReturnValue(Effect.succeed([]));
});

/** Envelope-shaped wire draft — the browser's ZK payload (T-144). */
const cipheredDraft = (extra: Record<string, unknown> = {}) => ({
	ciphered: true as const,
	name: "v1.aXYtLmN0",
	birthDate: "v1.ZGF0YQ",
	...extra,
});

const grant = { readerKind: "device" as const, readerPubkey: "pub-1", wrappedDek: "w1.x.y" };

describe("createPatientFn — ciphered drafts", () => {
	it("accepts envelope-shaped fields, grants the DEKs and saves", async () => {
		runEffects();
		await expect(createPatientFn({ data: cipheredDraft({ grants: [grant] }) })).resolves.toEqual({
			ok: true,
			patient: { id: 1, tenantId: 9 },
		});
		expect(mocks.create).toHaveBeenCalledOnce();
		expect(mocks.grantAccess).toHaveBeenCalledWith({
			tenantId: 9,
			entityType: "patient",
			entityId: 1,
			bootstrap: true,
			grants: [grant],
		});
	});

	it("rejects a ciphered create carrying no grants", async () => {
		for (const data of [cipheredDraft(), cipheredDraft({ grants: [] })]) {
			await expect(createPatientFn({ data })).resolves.toEqual({ ok: false, errors: {} });
		}
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("rejects grants on a plaintext write", async () => {
		await expect(
			createPatientFn({ data: { name: "Maria", birthDate: "1984-03-05", grants: [grant] } }),
		).resolves.toEqual({ ok: false, errors: {} });
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("skips the vault grant write for plaintext creates", async () => {
		runEffects();
		const res = await createPatientFn({ data: { name: "Ana", birthDate: "1984" } });
		expect(res).toEqual({ ok: true, patient: { id: 1, tenantId: 9 } });
		expect(mocks.create).toHaveBeenCalledWith(
			"u1",
			expect.objectContaining({ name: "Ana", birthDate: "1984", active: true }),
		);
		expect(mocks.grantAccess).not.toHaveBeenCalled();
	});

	it("rolls the row back when the grant write fails", async () => {
		runEffects();
		mocks.grantAccess.mockReturnValueOnce(Effect.fail("vault down"));
		await expect(createPatientFn({ data: cipheredDraft({ grants: [grant] }) })).resolves.toEqual({
			ok: false,
			errors: {},
		});
		expect(mocks.batch).toHaveBeenCalledOnce();
		expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(2);
	});

	it("rolls the row back when no vault service is bound", async () => {
		runEffects({ vault: false });
		await expect(createPatientFn({ data: cipheredDraft({ grants: [grant] }) })).resolves.toEqual({
			ok: false,
			errors: {},
		});
		expect(mocks.batch).toHaveBeenCalledOnce();
		expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(2);
	});

	it("rolls the row back in personal scope (no tenant to grant under)", async () => {
		runEffects({ tenant: null });
		await expect(createPatientFn({ data: cipheredDraft({ grants: [grant] }) })).resolves.toEqual({
			ok: false,
			errors: {},
		});
		expect(mocks.batch).toHaveBeenCalledOnce();
		expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(2);
	});

	it("reports { ok: false } when create returns null", async () => {
		runEffects();
		mocks.create.mockReturnValueOnce(Effect.succeed(null));
		await expect(createPatientFn({ data: cipheredDraft({ grants: [grant] }) })).resolves.toEqual({
			ok: false,
			errors: {},
		});
		expect(mocks.grantAccess).not.toHaveBeenCalled();
	});

	it("rejects a plaintext value inside a ciphered write", async () => {
		await expect(
			createPatientFn({ data: cipheredDraft({ name: "Maria", grants: [grant] }) }),
		).resolves.toEqual({ ok: false, errors: {} });
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("rejects ciphered drafts missing required envelopes", async () => {
		for (const data of [
			cipheredDraft({ name: null, grants: [grant] }),
			cipheredDraft({ birthDate: null, grants: [grant] }),
			cipheredDraft({ birthDate: "1984-03-05", grants: [grant] }),
		]) {
			await expect(createPatientFn({ data })).resolves.toEqual({ ok: false, errors: {} });
		}
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("rejects when an optional field stays plaintext", async () => {
		await expect(
			createPatientFn({ data: cipheredDraft({ phone: "11999990000", grants: [grant] }) }),
		).resolves.toEqual({ ok: false, errors: {} });
	});

	it("treats empty strings as absent fields", async () => {
		await expect(
			createPatientFn({ data: cipheredDraft({ phone: "", active: false, grants: [grant] }) }),
		).resolves.toEqual({ ok: true, patient: { id: 1 } });
	});
});

describe("createPatientFn — plaintext drafts", () => {
	it("runs semantic validation and saves valid drafts", async () => {
		await expect(
			createPatientFn({ data: { name: "Maria", birthDate: "1984-03-05" } }),
		).resolves.toEqual({ ok: true, patient: { id: 1 } });
	});

	it("returns field errors for invalid plaintext drafts", async () => {
		const res = await createPatientFn({ data: { birthDate: "not-a-date" } });
		expect(res.ok).toBe(false);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});
});

describe("updatePatientFn — ciphered drafts", () => {
	it("accepts envelope-shaped fields and saves", async () => {
		await expect(updatePatientFn({ data: { id: 5, ...cipheredDraft() } })).resolves.toEqual({
			ok: true,
			patient: { id: 1 },
		});
	});

	it("rejects plaintext in a ciphered update", async () => {
		await expect(
			updatePatientFn({ data: { id: 5, ...cipheredDraft({ city: "SP" }) } }),
		).resolves.toEqual({ ok: false, errors: {} });
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("tolerates a numeric string id", async () => {
		await expect(
			updatePatientFn({ data: { id: "5" as unknown as number, ...cipheredDraft() } }),
		).resolves.toEqual({ ok: true, patient: { id: 1 } });
	});

	it("returns field errors for invalid plaintext updates", async () => {
		const res = await updatePatientFn({ data: { id: 5, name: "", birthDate: "bad" } });
		expect(res.ok).toBe(false);
	});

	it("returns the updated patient on success", async () => {
		mocks.runAs.mockImplementation(async (_user, effect) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<unknown, unknown>,
					Layer.succeed(Patients, {
						update: mocks.update,
					} as unknown as Patients["Service"]),
				),
			),
		);
		await expect(
			updatePatientFn({ data: { id: 5, name: "Ana", birthDate: "1984" } }),
		).resolves.toEqual({ ok: true, patient: { id: 5 } });
	});

	it("maps a missing or forbidden row to { ok: false }", async () => {
		mocks.update
			.mockReturnValueOnce(Effect.fail({ _tag: "Forbidden" }))
			.mockReturnValueOnce(Effect.succeed(null));
		mocks.runAs.mockImplementation(async (_user, effect) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<unknown, unknown>,
					Layer.succeed(Patients, {
						update: mocks.update,
					} as unknown as Patients["Service"]),
				),
			),
		);
		await expect(
			updatePatientFn({ data: { id: 5, name: "Ana", birthDate: "1984" } }),
		).resolves.toEqual({ ok: false, errors: {} });
		await expect(
			updatePatientFn({ data: { id: 5, name: "Ana", birthDate: "1984" } }),
		).resolves.toEqual({ ok: false, errors: {} });
	});
});

describe("adminCreatePatientFn", () => {
	it("validates the plaintext draft before delegating", async () => {
		await expect(
			adminCreatePatientFn({ data: { ownerId: "u2", name: "Bia", birthDate: "1990-01-01" } }),
		).resolves.toEqual({ ok: true, patient: { id: 1 } });
	});

	it("rejects invalid drafts without touching the service", async () => {
		const res = await adminCreatePatientFn({ data: { ownerId: "u2", name: "" } });
		expect(res.ok).toBe(false);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("returns the created patient on success", async () => {
		mocks.runAs.mockImplementation(async (_user, effect) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<unknown, unknown>,
					Layer.succeed(Patients, {
						adminCreate: mocks.adminCreate,
					} as unknown as Patients["Service"]),
				),
			),
		);
		await expect(
			adminCreatePatientFn({ data: { ownerId: "u2", name: "Bia", birthDate: "1990" } }),
		).resolves.toEqual({ ok: true, patient: { id: 2 } });
	});

	it("maps a denied adminCreate to { ok: false }", async () => {
		mocks.adminCreate.mockReturnValueOnce(Effect.fail({ _tag: "Forbidden" }));
		mocks.runAs.mockImplementation(async (_user, effect) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<unknown, unknown>,
					Layer.succeed(Patients, {
						adminCreate: mocks.adminCreate,
					} as unknown as Patients["Service"]),
				),
			),
		);
		await expect(
			adminCreatePatientFn({ data: { ownerId: "u2", name: "Bia", birthDate: "1990" } }),
		).resolves.toEqual({ ok: false, errors: {} });
	});
});

describe("adminListPatientsFn", () => {
	const runAdmin = () =>
		mocks.runAs.mockImplementation(async (_user, effect) =>
			Effect.runPromise(
				Effect.provide(
					effect as Effect.Effect<unknown, unknown>,
					Layer.succeed(Patients, { adminList: mocks.adminList } as unknown as Patients["Service"]),
				),
			),
		);

	it("returns an empty feed without a session user", async () => {
		await expect(adminListPatientsFn()).resolves.toEqual([]);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("returns the cross-owner rows for a platform admin", async () => {
		mocks.getDoctorUser.mockResolvedValueOnce({ id: "u1" });
		mocks.adminList.mockReturnValue(Effect.succeed([{ id: 1 }]));
		runAdmin();
		await expect(adminListPatientsFn()).resolves.toEqual([{ id: 1 }]);
		expect(mocks.adminList).toHaveBeenCalledOnce();
	});

	it("collapses Forbidden to the same empty feed", async () => {
		mocks.getDoctorUser.mockResolvedValueOnce({ id: "u1" });
		mocks.adminList.mockReturnValue(Effect.fail(new Forbidden({ path: "x" })));
		runAdmin();
		await expect(adminListPatientsFn()).resolves.toEqual([]);
	});
});
