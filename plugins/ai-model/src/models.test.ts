import { beforeAll, describe, expect, it } from "vitest";
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
	AI_MODEL_TEST_DDL,
	aiModelPanelPlugin,
	AiModels,
	AiModelsLive,
	aiModel,
	ModelError,
	type ModelCard,
} from "./index.ts";

const DDL = AI_MODEL_TEST_DDL;
const TENANT_ID = 7;
const ADMIN_EMAIL = "admin@x.com";
const USER_EMAIL = "doc@clinic.com";

const makeRuntime = (db: DbClient) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL))),
	);
	return ManagedRuntime.make(AiModelsLive.pipe(Layer.provide(infra)));
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<AiModels, never>,
	effect: Effect.Effect<A, E, AiModels>,
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

describe("AiModels", () => {
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

	it("creates a platform model; card carries catalog metadata", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) =>
				m.create({
					name: "local-qwen",
					modelId: "qwen2.5:7b-instruct-q4_K_M",
					endpointId: 3,
					kind: "chat",
					capabilities: ["chat", "eval-judge"],
					contextTokens: 32_768,
					costTier: "free",
					isDefault: true,
				}),
			),
			asAdmin,
		);
		expect(card.id).toBeGreaterThan(0);
		expect(card.scope).toBe("platform");
		expect(card.endpointId).toBe(3);
		expect(card.modelId).toBe("qwen2.5:7b-instruct-q4_K_M");
		expect(card.capabilities).toEqual(["chat", "eval-judge"]);
		expect(card.isDefault).toBe(true);
		expect(card.enabled).toBe(true);
	});

	it("denies platform-scope writes to non-admins", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.create({ name: "nope", modelId: "x" })),
				asMember,
			),
		).rejects.toBeInstanceOf(Forbidden);
	});

	it("rejects duplicate names within a scope", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.create({ name: "local-qwen", modelId: "y" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "duplicate" });
	});

	it("rejects empty name/modelId", async () => {
		const rt = makeRuntime(db);
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.create({ name: "  ", modelId: "x" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
	});

	it("tenant members list; tenant admins create; members cannot write", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) =>
				m.create({
					scope: "tenant",
					tenantId: TENANT_ID,
					name: "clinic-asr",
					modelId: "whisper-large-v3",
					kind: "asr",
				}),
			),
			asTenantAdmin,
		);
		expect(card.scope).toBe(String(TENANT_ID));
		const listed = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.list({ scope: "tenant", tenantId: TENANT_ID })),
			asMember,
		);
		expect(listed.map((c) => c.name)).toContain("clinic-asr");
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.update({ id: card.id, name: "renamed" })),
				asMember,
			),
		).rejects.toSatisfy((e) => e !== null);
	});

	it("update/remove roundtrip; remove hides the row from resolve", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "temp-model", modelId: "m1", kind: "tts" })),
			asAdmin,
		);
		const updated = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.update({ id: card.id, enabled: false, costTier: "high" })),
			asAdmin,
		);
		expect(updated.enabled).toBe(false);
		expect(updated.costTier).toBe("high");
		// Disabled rows resolve to null — consumers fall back honestly.
		expect(
			await run(
				rt,
				Effect.flatMap(AiModels, (m) => m.resolve(card.id)),
				asAdmin,
			),
		).toBeNull();
		await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.remove(card.id)),
			asAdmin,
		);
		expect(
			await run(
				rt,
				Effect.flatMap(AiModels, (m) => m.get(card.id)),
				asAdmin,
			),
		).toBeNull();
	});

	it("resolve returns enabled cards ungated; unknown ids → null", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) =>
				m.create({ name: "gemini-flash", modelId: "gemini-2.0-flash" }),
			),
			asAdmin,
		);
		const resolved = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.resolve(card.id)),
			{
				role: null,
				email: "nobody@x.com",
			},
		);
		expect(resolved?.name).toBe("gemini-flash");
		expect(
			await run(
				rt,
				Effect.flatMap(AiModels, (m) => m.resolve(99999)),
				asAdmin,
			),
		).toBeNull();
	});

	it("resolveDefault picks the flagged default within scope", async () => {
		const rt = makeRuntime(db);
		await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "def-a", modelId: "a", isDefault: true })),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "def-b", modelId: "b" })),
			asAdmin,
		);
		const def = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.resolveDefault({ scope: "platform" })),
			asAdmin,
		);
		expect(def?.name).toBe("def-a");
	});

	it("list filters by endpointId", async () => {
		const rt = makeRuntime(db);
		await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "ep5-model", modelId: "x", endpointId: 5 })),
			asAdmin,
		);
		const only = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.list({ scope: "platform", endpointId: 5 })),
			asAdmin,
		);
		expect(only.map((c) => c.name)).toEqual(["ep5-model"]);
	});

	it("get returns the card for an existing row", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "get-me", modelId: "g/1" })),
			asAdmin,
		);
		const fetched = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.get(card.id)),
			asAdmin,
		);
		expect(fetched?.name).toBe("get-me");
		expect(fetched?.capabilities).toEqual([]);
	});

	it("malformed capabilities JSON parses to [] and non-strings are dropped", async () => {
		const rt = makeRuntime(db);
		await db.insert(aiModel).values([
			{
				scope: "platform",
				name: "bad-json",
				modelId: "x",
				capabilities: "{oops",
				createdAt: new Date(),
			},
			{
				scope: "platform",
				name: "not-array",
				modelId: "x",
				capabilities: '{"a":1}',
				createdAt: new Date(),
			},
			{
				scope: "platform",
				name: "mixed-caps",
				modelId: "x",
				capabilities: '["a",1,"b"]',
				createdAt: new Date(),
			},
		]);
		const rows = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.list()),
			asAdmin,
		);
		const byName = new Map(rows.map((c) => [c.name, c.capabilities]));
		expect(byName.get("bad-json")).toEqual([]);
		expect(byName.get("not-array")).toEqual([]);
		expect(byName.get("mixed-caps")).toEqual(["a", "b"]);
	});

	it("tenant scope mismatches fail with tenant-mismatch", async () => {
		const rt = makeRuntime(db);
		// Bound tenant (id 7) asking for a different tenant scope.
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.list({ scope: "tenant", tenantId: 8 })),
				asMember,
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		// No bound tenant at all.
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.list({ scope: "tenant", tenantId: TENANT_ID })),
				{ role: null, email: "nobody@x.com" },
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
	});

	it("scope 'tenant' without a tenantId falls back to platform scope", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) =>
				m.create({ scope: "tenant", name: "no-tenant-id", modelId: "x" }),
			),
			asAdmin,
		);
		expect(card.scope).toBe("platform");
		expect(card.tenantId).toBeNull();
	});

	it("update rejects empty fields and missing rows", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "guarded", modelId: "g/2" })),
			asAdmin,
		);
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.update({ id: card.id, name: "  " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.update({ id: card.id, modelId: " " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.update({ id: 999_999, name: "x" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.remove(999_999)),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
		// Sparse update — enabled and every other optional field absent.
		const renamed = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.update({ id: card.id, name: "guarded-2" })),
			asAdmin,
		);
		expect(renamed.name).toBe("guarded-2");
		expect(renamed.enabled).toBe(true);
	});

	it("update applies every optional field", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "full-edit", modelId: "f/1" })),
			asAdmin,
		);
		const updated = await run(
			rt,
			Effect.flatMap(AiModels, (m) =>
				m.update({
					id: card.id,
					endpointId: 21,
					name: "full-edit-2",
					modelId: "f/2",
					kind: "judge",
					capabilities: ["judge", "chat"],
					contextTokens: 4096,
					costTier: "high",
					isDefault: true,
					enabled: false,
				}),
			),
			asAdmin,
		);
		expect(updated.endpointId).toBe(21);
		expect(updated.name).toBe("full-edit-2");
		expect(updated.modelId).toBe("f/2");
		expect(updated.kind).toBe("judge");
		expect(updated.capabilities).toEqual(["judge", "chat"]);
		expect(updated.contextTokens).toBe(4096);
		expect(updated.costTier).toBe("high");
		expect(updated.isDefault).toBe(true);
		expect(updated.enabled).toBe(false);
	});

	it("list()/resolveDefault() default to platform scope; misses resolve to null", async () => {
		const rt = makeRuntime(db);
		const listed = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.list()),
			asAdmin,
		);
		expect(listed.length).toBeGreaterThan(0);
		// The flagged platform default wins.
		const def = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.resolveDefault()),
			asAdmin,
		);
		expect(def?.isDefault).toBe(true);
		// Endpoint filter that matches nothing → null.
		expect(
			await run(
				rt,
				Effect.flatMap(AiModels, (m) =>
					m.resolveDefault({ scope: "platform", endpointId: 424_242 }),
				),
				asAdmin,
			),
		).toBeNull();
		// Tenant scope with rows but no flagged default → null.
		expect(
			await run(
				rt,
				Effect.flatMap(AiModels, (m) => m.resolveDefault({ scope: "tenant", tenantId: TENANT_ID })),
				asMember,
			),
		).toBeNull();
	});

	it("records audit entries for platform and tenant scopes when Audit is present", async () => {
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
		const withAudit = <A, E>(effect: Effect.Effect<A, E, AiModels>) =>
			effect.pipe(Effect.provideService(Audit, auditStub));
		const rt = makeRuntime(db);
		const platform = await run(
			rt,
			withAudit(
				Effect.flatMap(AiModels, (m) => m.create({ name: "audit-platform", modelId: "a/1" })),
			),
			asAdmin,
		);
		await run(
			rt,
			withAudit(
				Effect.flatMap(AiModels, (m) =>
					m.create({
						scope: "tenant",
						tenantId: TENANT_ID,
						name: "audit-tenant",
						modelId: "a/2",
					}),
				),
			),
			asTenantAdmin,
		);
		await run(rt, withAudit(Effect.flatMap(AiModels, (m) => m.resolve(platform.id))));
		const actions = entries.map((e) => e.action);
		for (const expected of ["ai-model.create", "ai-model.create", "ai-model.resolve"]) {
			expect(actions).toContain(expected);
		}
		// Platform rows record tenantId null; tenant rows record the numeric id.
		const creates = entries.filter((e) => e.action === "ai-model.create");
		expect(creates.map((e) => e.tenantId).sort()).toEqual([null, TENANT_ID].sort());
		await rt.dispose();
	});
});

describe("aiModelPanelPlugin page", () => {
	it("guard mirrors PlatformAdmin and loader lists platform models", async () => {
		const page = aiModelPanelPlugin.panel!.pages![0]!;
		expect(page.path).toBe("/platform/ai/models");
		const rt = makeRuntime(makeDb(makeD1(DDL)));
		const gate = makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL));
		const provideCaller = <A, E, R>(effect: Effect.Effect<A, E, R>, email: string) =>
			effect.pipe(
				Effect.provideService(Principal, { userId: "u1", email }),
				Effect.provideService(PlatformAdmin, gate),
				Effect.provideService(Tenant, {
					id: TENANT_ID,
					kind: "clinic",
					slug: "clinic-7",
					role: "member" as TenantRole,
				}),
			);
		const allowed = await rt.runPromise(
			provideCaller(page.guard!() as Effect.Effect<boolean>, ADMIN_EMAIL),
		);
		expect(allowed).toBe(true);
		const loaded = await rt.runPromise(
			provideCaller(page.loader!() as Effect.Effect<readonly ModelCard[]>, ADMIN_EMAIL),
		);
		expect(Array.isArray(loaded)).toBe(true);
		// Non-admin callers: guard denies, loader degrades to [].
		expect(
			await rt.runPromise(provideCaller(page.guard!() as Effect.Effect<boolean>, USER_EMAIL)),
		).toBe(false);
		expect(
			await rt.runPromise(
				provideCaller(page.loader!() as Effect.Effect<readonly ModelCard[]>, USER_EMAIL),
			),
		).toEqual([]);
		await rt.dispose();
	});

	it("loader collapses ModelError, TenantForbidden and Forbidden to []", async () => {
		const page = aiModelPanelPlugin.panel!.pages![0]!;
		const loader = page.loader!() as Effect.Effect<readonly ModelCard[]>;
		const stub = (err: ModelError | TenantForbidden | Forbidden) =>
			({ list: () => Effect.fail(err) }) as unknown as AiModels["Service"];
		for (const err of [
			new ModelError({ reason: "not-found" }),
			new TenantForbidden({ path: "ai-model.member", role: null, required: "admin" }),
			new Forbidden({ path: "platform.admin" }),
		]) {
			const out = await Effect.runPromise(loader.pipe(Effect.provideService(AiModels, stub(err))));
			expect(out).toEqual([]);
		}
	});
});
