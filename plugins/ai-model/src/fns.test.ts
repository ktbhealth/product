import { beforeEach, describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	ensureSessionUser: vi.fn(),
	runAs: vi.fn(),
}));

// Same fake as the sibling plugin fns tests: handlers run as plain
// async fns; `runAs` executes the Effect for real against a runtime
// wired with the test Db so the service/denial branches are hit.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const api = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return api;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (call?: { data?: unknown }) =>
				h({ ...(call ?? {}), data: validate ? validate(call?.data) : call?.data }),
		};
		return api;
	},
}));
vi.mock("@ktb/server-fns", () => ({
	getSessionUser: mocks.getSessionUser,
	ensureSessionUser: mocks.ensureSessionUser,
	runAs: mocks.runAs,
}));

import { Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant } from "@ktb/tenant";

import { AI_MODEL_TEST_DDL, AiModels, AiModelsLive, aiModel, type ModelCard } from "./index.ts";
import { modelsCreateFn, modelsListFn, modelsRemoveFn, modelsUpdateFn } from "./fns.ts";

const ADMIN_EMAIL = "admin@x.com";
const MEMBER_EMAIL = "doc@clinic.com";
const TENANT_ID = 7;

const makeRuntime = (db: DbClient) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL))),
	);
	return ManagedRuntime.make(AiModelsLive.pipe(Layer.provide(infra)));
};

describe("ai-model fns", () => {
	let db: DbClient;
	let runtime: ManagedRuntime.ManagedRuntime<AiModels, never>;

	beforeEach(async () => {
		vi.clearAllMocks();
		db = makeDb(makeD1(AI_MODEL_TEST_DDL));
		runtime = makeRuntime(db);
		mocks.getSessionUser.mockResolvedValue({ id: "u1", email: ADMIN_EMAIL });
		mocks.ensureSessionUser.mockResolvedValue({ id: "u1", email: ADMIN_EMAIL });
		mocks.runAs.mockImplementation(
			async (
				user: { id: string; email: string },
				effect: Effect.Effect<unknown, unknown, unknown>,
			) =>
				runtime.runPromise(
					effect.pipe(
						Effect.provideService(Principal, { userId: user.id, email: user.email }),
						Effect.provideService(Tenant, {
							id: TENANT_ID,
							kind: "clinic",
							slug: "clinic-7",
							role: "admin",
						}),
					) as Effect.Effect<unknown, unknown, never>,
				),
		);
	});

	it("modelsListFn returns [] for anonymous callers", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(modelsListFn()).resolves.toEqual([]);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("modelsListFn lists platform models for admins and degrades on denial", async () => {
		await modelsCreateFn({ data: { name: "fn-model", modelId: "fn/m1" } });
		const rows = (await modelsListFn()) as readonly ModelCard[];
		expect(rows.map((r) => r.name)).toContain("fn-model");

		mocks.getSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		await expect(modelsListFn()).resolves.toEqual([]);
	});

	it("modelsCreateFn returns the card and applies service defaults", async () => {
		const result = (await modelsCreateFn({
			data: { name: "full-model", modelId: "provider/x", kind: "vision" },
		})) as { ok: true; data: ModelCard };
		expect(result.ok).toBe(true);
		expect(result.data.scope).toBe("platform");
		expect(result.data.name).toBe("full-model");
		expect(result.data.kind).toBe("vision");
		expect(result.data.enabled).toBe(true);
	});

	it("modelsCreateFn forwards every optional field", async () => {
		const result = (await modelsCreateFn({
			data: {
				name: "rich-model",
				modelId: "provider/rich",
				endpointId: 11,
				kind: "asr",
				capabilities: ["asr", "streaming"],
				contextTokens: 16_384,
				costTier: "low",
				isDefault: true,
			},
		})) as { ok: true; data: ModelCard };
		expect(result.ok).toBe(true);
		expect(result.data.endpointId).toBe(11);
		expect(result.data.capabilities).toEqual(["asr", "streaming"]);
		expect(result.data.contextTokens).toBe(16_384);
		expect(result.data.costTier).toBe("low");
		expect(result.data.isDefault).toBe(true);
	});

	it("modelsCreateFn maps denials and ModelError to { ok: false }", async () => {
		await modelsCreateFn({ data: { name: "dup-model", modelId: "m1" } });
		// Duplicate name within the platform scope → ModelError.
		expect(await modelsCreateFn({ data: { name: "dup-model", modelId: "m2" } })).toEqual({
			ok: false,
		});
		// Non-admin principal → Forbidden.
		mocks.ensureSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		expect(await modelsCreateFn({ data: { name: "denied", modelId: "x" } })).toEqual({
			ok: false,
		});
	});

	it("validators reject malformed payloads", async () => {
		await expect(modelsCreateFn({ data: { name: "", modelId: "x" } })).rejects.toThrow();
		await expect(
			modelsCreateFn({ data: { name: "n", modelId: "m", kind: "bogus" } as never }),
		).rejects.toThrow();
		await expect(modelsUpdateFn({ data: { id: "nope" } })).rejects.toThrow();
		await expect(modelsRemoveFn({ data: { id: "x" } })).rejects.toThrow();
	});

	it("update/remove round-trip through the service", async () => {
		const created = (await modelsCreateFn({
			data: { name: "round-model", modelId: "m/round", endpointId: 4 },
		})) as { ok: true; data: ModelCard };
		const id = created.data.id;

		const updated = (await modelsUpdateFn({
			data: {
				id,
				name: "round-model-2",
				modelId: "m/round-2",
				endpointId: 9,
				kind: "tts",
				capabilities: ["tts"],
				contextTokens: 2048,
				costTier: "medium",
				isDefault: true,
				enabled: false,
			},
		})) as { ok: true; data: ModelCard };
		expect(updated.ok).toBe(true);
		expect(updated.data.name).toBe("round-model-2");
		expect(updated.data.kind).toBe("tts");
		expect(updated.data.enabled).toBe(false);
		expect(updated.data.isDefault).toBe(true);

		// Sparse update — every optional field absent.
		const sparse = (await modelsUpdateFn({ data: { id, enabled: true } })) as {
			ok: true;
			data: ModelCard;
		};
		expect(sparse.data.enabled).toBe(true);

		const removed = (await modelsRemoveFn({ data: { id } })) as {
			ok: true;
			data: null;
		};
		expect(removed).toEqual({ ok: true, data: null });
	});

	it("denied and missing-row mutations return { ok: false }", async () => {
		mocks.ensureSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		expect(await modelsUpdateFn({ data: { id: 1, name: "x" } })).toEqual({ ok: false });
		expect(await modelsRemoveFn({ data: { id: 1 } })).toEqual({ ok: false });

		mocks.ensureSessionUser.mockResolvedValue({ id: "u1", email: ADMIN_EMAIL });
		// ModelError not-found on both paths.
		expect(await modelsUpdateFn({ data: { id: 999_999, name: "x" } })).toEqual({ ok: false });
		expect(await modelsRemoveFn({ data: { id: 999_999 } })).toEqual({ ok: false });
	});

	it("tenant-scope denials collapse via TenantForbidden", async () => {
		await db.insert(groups).values({
			id: TENANT_ID,
			name: "Clinic",
			slug: "clinic-7",
			kind: "clinic",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const [row] = await db
			.insert(aiModel)
			.values({
				scope: String(TENANT_ID),
				tenantId: TENANT_ID,
				name: "tenant-model",
				modelId: "tenant/m1",
				createdAt: new Date(),
			})
			.returning();
		mocks.ensureSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		// Bound tenant with member rank → write requires admin → TenantForbidden.
		mocks.runAs.mockImplementationOnce(
			async (
				user: { id: string; email: string },
				effect: Effect.Effect<unknown, unknown, unknown>,
			) =>
				runtime.runPromise(
					effect.pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
						}),
						Effect.provideService(Tenant, {
							id: TENANT_ID,
							kind: "clinic",
							slug: "clinic-7",
							role: "member",
						}),
					) as Effect.Effect<unknown, unknown, never>,
				),
		);
		expect(await modelsUpdateFn({ data: { id: row!.id, name: "x" } })).toEqual({
			ok: false,
		});
	});
});
