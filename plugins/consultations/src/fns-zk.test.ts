import { beforeEach, describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Db } from "@ktb/db";
import { Tenant, type Tenant as TenantScope } from "@ktb/tenant";
import { Vault } from "@ktb/vault";

const mocks = vi.hoisted(() => ({
	ensureDoctorUser: vi.fn(async () => ({ id: "u1" })),
	getDoctorUser: vi.fn(async () => ({ id: "u1" })),
	runAs: vi.fn<(user: unknown, effect: unknown) => Promise<unknown>>(async () => ({ id: 1 })),
	save: vi.fn(),
	attachAnamnesis: vi.fn(),
	grantAccess: vi.fn(),
}));

// Same fake as fns-attach-input.test.ts: handlers run as plain async
// fns and the validator is applied to the incoming `data`.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((value: unknown) => unknown) | undefined;
		const api = {
			validator: (fn: (value: unknown) => unknown) => {
				validate = fn;
				return api;
			},
			handler: (h: (arg: { data: unknown }) => unknown) => async (call: { data?: unknown }) =>
				h({ data: validate === undefined ? call?.data : validate(call?.data) }),
		};
		return api;
	},
}));
vi.mock("@ktb/server-fns", () => ({
	ensureDoctorUser: mocks.ensureDoctorUser,
	ensureSessionUser: vi.fn(async () => ({ id: "u1" })),
	getDoctorAccess: vi.fn(),
	getDoctorUser: mocks.getDoctorUser,
	getLocale: vi.fn(),
	getServerRuntime: vi.fn(),
	getSessionUser: vi.fn(),
	purgeAudio: vi.fn(),
	runAs: mocks.runAs,
}));
/** Minimal DbClient — `deleteConsultationRow`'s rollback reads the
 * audio key then deletes: `db.select().from().where().limit()` +
 * `db.delete().where()`. */
const fakeDb = {
	select: vi.fn(() => ({
		from: vi.fn(() => ({
			where: vi.fn(() => ({ limit: vi.fn(async () => [{ audioKey: null }]) })),
		})),
	})),
	delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
} as unknown as Db["Service"];

import { Consultations } from "./index.ts";
import { attachAnamnesisFn, saveConsultationFn } from "./fns.ts";

const TENANT_ZK: TenantScope = { id: 9, kind: "clinic", slug: "clinica-zk", role: "member" };

/** Make `runAs` execute the effect against a minimal context — the
 * pieces the fns touch: Consultations, Db, Tenant and (optionally)
 * the Vault service. */
const runEffects = (
	opts: { readonly tenant?: TenantScope | null; readonly vault?: boolean } = {},
) => {
	const { tenant = TENANT_ZK, vault = true } = opts;
	const layer = Layer.mergeAll(
		Layer.succeed(Consultations, {
			save: mocks.save,
			attachAnamnesis: mocks.attachAnamnesis,
		} as unknown as Consultations["Service"]),
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
	mocks.save.mockReturnValue(Effect.succeed({ id: 1 }));
	mocks.attachAnamnesis.mockReturnValue(Effect.succeed(undefined));
	mocks.grantAccess.mockReturnValue(Effect.succeed([]));
});

const section = { content: "x", confidence: "alta", evidence: ["e"] };
const anamnesis = {
	queixa_principal: section,
	hda: section,
	antecedentes: section,
	alergias: section,
	medicamentos_em_uso: section,
	exame_fisico: section,
	hipoteses: section,
	conduta: section,
};
const version = { contentHash: "sha256:abc", signature: "sig-1" };
const grant = { readerKind: "device" as const, readerPubkey: "pub-1", wrappedDek: "w1.x.y" };

/** Envelope-shaped save payload — the browser's ZK write (T-145). */
const cipheredSave = (extra: Record<string, unknown> = {}) => ({
	ciphered: true as const,
	transcript: "v1.aXYtLmN0",
	anamnesis: "v1.YW5hbS5jdA",
	engine: "heuristic",
	version,
	grants: [grant],
	...extra,
});

describe("saveConsultationFn — ciphered writes", () => {
	it("persists envelopes, signs the version and grants the DEKs", async () => {
		runEffects();
		await expect(saveConsultationFn({ data: cipheredSave() } as never)).resolves.toEqual({
			id: 1,
		});
		expect(mocks.save).toHaveBeenCalledWith("u1", {
			transcript: "v1.aXYtLmN0",
			anamnesis: "v1.YW5hbS5jdA",
			engine: "heuristic",
			version,
		});
		expect(mocks.grantAccess).toHaveBeenCalledWith({
			tenantId: 9,
			entityType: "consultation",
			entityId: 1,
			grants: [grant],
		});
	});

	it("accepts an empty transcript — an unwritten column is not content", async () => {
		runEffects();
		await expect(
			saveConsultationFn({ data: cipheredSave({ transcript: "" }) } as never),
		).resolves.toEqual({ id: 1 });
	});

	it("rolls the row back when the grant write fails", async () => {
		runEffects();
		mocks.grantAccess.mockReturnValue(Effect.fail(new Error("no vault")));
		await expect(saveConsultationFn({ data: cipheredSave() } as never)).resolves.toBeNull();
		expect(fakeDb.delete).toHaveBeenCalled();
	});

	it("rolls the row back when no vault service is bound", async () => {
		runEffects({ vault: false });
		await expect(saveConsultationFn({ data: cipheredSave() } as never)).resolves.toBeNull();
		expect(fakeDb.delete).toHaveBeenCalled();
	});

	it("rejects a ciphered save without grants", async () => {
		const { grants: _omit, ...noGrants } = cipheredSave();
		for (const data of [noGrants, cipheredSave({ grants: [] })]) {
			await expect(saveConsultationFn({ data } as never)).resolves.toBeNull();
		}
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("rejects a ciphered save without a signed version", async () => {
		const { version: _omit, ...noVersion } = cipheredSave();
		await expect(saveConsultationFn({ data: noVersion } as never)).resolves.toBeNull();
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("rejects non-envelope content on a ciphered write", async () => {
		for (const data of [cipheredSave({ anamnesis }), cipheredSave({ transcript: "plaintext" })]) {
			await expect(saveConsultationFn({ data } as never)).resolves.toBeNull();
		}
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("rejects ZK-only fields on a plaintext write", async () => {
		const base = { transcript: "t", anamnesis, engine: "e" };
		for (const data of [
			{ ...base, grants: [grant] },
			{ ...base, version },
			{ ...base, anamnesis: "v1.a.b" },
		]) {
			await expect(saveConsultationFn({ data } as never)).resolves.toBeNull();
		}
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("saves plaintext writes unchanged (non-ZK tenants)", async () => {
		runEffects();
		await expect(
			saveConsultationFn({
				data: { transcript: "t", anamnesis, engine: "e", patientId: "4" },
			} as never),
		).resolves.toEqual({ id: 1 });
		expect(mocks.save).toHaveBeenCalledWith("u1", {
			transcript: "t",
			anamnesis,
			engine: "e",
			patientId: 4,
			version: undefined,
		});
		expect(mocks.grantAccess).not.toHaveBeenCalled();
	});
});

describe("attachAnamnesisFn — ciphered writes", () => {
	const cipheredAttach = (extra: Record<string, unknown> = {}) => ({
		ciphered: true as const,
		consultationId: 7,
		anamnesis: "v1.YW5hbS5jdA",
		engine: "heuristic",
		version,
		...extra,
	});

	it("attaches the envelope with the client-signed version", async () => {
		runEffects();
		await expect(attachAnamnesisFn({ data: cipheredAttach() } as never)).resolves.toEqual({
			ok: true,
		});
		expect(mocks.attachAnamnesis).toHaveBeenCalledWith("u1", {
			consultationId: 7,
			anamnesis: "v1.YW5hbS5jdA",
			engine: "heuristic",
			version,
		});
		expect(mocks.grantAccess).not.toHaveBeenCalled();
	});

	it("persists additional grants BEFORE attaching", async () => {
		runEffects();
		await expect(
			attachAnamnesisFn({ data: cipheredAttach({ grants: [grant] }) } as never),
		).resolves.toEqual({ ok: true });
		expect(mocks.grantAccess).toHaveBeenCalledWith({
			tenantId: 9,
			entityType: "consultation",
			entityId: 7,
			grants: [grant],
		});
		expect(mocks.attachAnamnesis).toHaveBeenCalledOnce();
	});

	it("skips the attach when a provided grant write fails", async () => {
		runEffects();
		mocks.grantAccess.mockReturnValue(Effect.fail(new Error("no vault")));
		await expect(
			attachAnamnesisFn({ data: cipheredAttach({ grants: [grant] }) } as never),
		).resolves.toEqual({ ok: false });
		expect(mocks.attachAnamnesis).not.toHaveBeenCalled();
	});

	it("rejects plaintext anamnesis or a missing version on a ciphered attach", async () => {
		const { version: _omit, ...noVersion } = cipheredAttach();
		for (const data of [cipheredAttach({ anamnesis }), noVersion]) {
			await expect(attachAnamnesisFn({ data } as never)).resolves.toEqual({ ok: false });
		}
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("rejects ZK-only fields on a plaintext attach", async () => {
		const base = { consultationId: 7, anamnesis, engine: "e" };
		for (const data of [
			{ ...base, grants: [grant] },
			{ ...base, version },
			{ ...base, anamnesis: "v1.a.b" },
		]) {
			await expect(attachAnamnesisFn({ data } as never)).resolves.toEqual({ ok: false });
		}
		expect(mocks.runAs).not.toHaveBeenCalled();
	});
});
