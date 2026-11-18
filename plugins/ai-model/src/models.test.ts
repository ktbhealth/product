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
import { Tenant, type TenantRole } from "@ktb/tenant";

import { AI_MODEL_TEST_DDL, AiModels, AiModelsLive } from "./index.ts";
import { getModelById, insertModel, listModels } from "./models.ts";

const DDL = AI_MODEL_TEST_DDL;
const TENANT_ID = 7;
const ADMIN_EMAIL = "admin@x.com";
const USER_EMAIL = "doc@clinic.com";

const makeRuntime = (
	db: DbClient,
	extra: Layer.Layer<never, never, never> | Layer.Layer<Audit, never, never> = Layer.empty,
) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL))),
	);
	return ManagedRuntime.make(
		Layer.mergeAll(AiModelsLive.pipe(Layer.provide(infra)), infra, extra) as Layer.Layer<
			unknown,
			never,
			never
		>,
	);
};

const run = <A, E>(
	runtime: ManagedRuntime.ManagedRuntime<unknown, never>,
	effect: Effect.Effect<A, E, unknown>,
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
			Effect.flatMap(AiModels, (m) => m.create({ name: "get-me", modelId: "g1" })),
			asAdmin,
		);
		const got = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.get(card.id)),
			asAdmin,
		);
		expect(got?.name).toBe("get-me");
		await rt.dispose();
	});

	it("update rejects unknown ids and blank fields", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "upd-me", modelId: "u1" })),
			asAdmin,
		);
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.update({ id: 99999, name: "x" })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.update({ id: card.id, name: "   " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.update({ id: card.id, modelId: "  " })),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "invalid" });
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.remove(99999)),
				asAdmin,
			),
		).rejects.toMatchObject({ reason: "not-found" });
		await rt.dispose();
	});

	it("update applies every patch field", async () => {
		const rt = makeRuntime(db);
		const card = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "patch-me", modelId: "p1" })),
			asAdmin,
		);
		const updated = await run(
			rt,
			Effect.flatMap(AiModels, (m) =>
				m.update({
					id: card.id,
					name: "patch-me-2",
					modelId: "p2",
					endpointId: 11,
					kind: "judge",
					capabilities: ["judge"],
					contextTokens: 4096,
					costTier: "medium",
					isDefault: true,
					enabled: true,
				}),
			),
			asAdmin,
		);
		expect(updated).toMatchObject({
			name: "patch-me-2",
			modelId: "p2",
			endpointId: 11,
			kind: "judge",
			capabilities: ["judge"],
			contextTokens: 4096,
			costTier: "medium",
			isDefault: true,
			enabled: true,
		});
		await rt.dispose();
	});

	it("list defaults to platform scope; tenant mismatches fail", async () => {
		const rt = makeRuntime(db);
		const all = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.list()),
			asAdmin,
		);
		expect(all.length).toBeGreaterThan(0);
		// Bound tenant (id 7) asking for scope "8" → tenant-mismatch.
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.list({ scope: "tenant", tenantId: 8 })),
				asMember,
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		// No bound tenant at all → same failure via the null arm.
		await expect(
			run(
				rt,
				Effect.flatMap(AiModels, (m) => m.list({ scope: "tenant", tenantId: TENANT_ID })),
				{ role: null, email: "nobody@x.com" },
			),
		).rejects.toMatchObject({ reason: "tenant-mismatch" });
		await rt.dispose();
	});

	it("resolveDefault with no args picks the platform default; empty scopes → null", async () => {
		const rt = makeRuntime(db);
		const def = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.resolveDefault()),
			asAdmin,
		);
		expect(def?.scope).toBe("platform");
		// An endpointId filter matching nothing yields no flagged default.
		const none = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.resolveDefault({ endpointId: 424242 })),
			asAdmin,
		);
		expect(none).toBeNull();
		await rt.dispose();
	});

	it("parses malformed and non-array capabilities as []", async () => {
		// Repo-level inserts bypass service validation on purpose — the
		// card mapper must degrade gracefully.
		await insertModel(db, {
			scope: "platform",
			tenantId: null,
			endpointId: null,
			name: "bad-json",
			modelId: "x",
			kind: "chat",
			capabilities: "{not json",
			contextTokens: null,
			costTier: null,
			isDefault: false,
		});
		await insertModel(db, {
			scope: "platform",
			tenantId: null,
			endpointId: null,
			name: "non-array",
			modelId: "x",
			kind: "chat",
			capabilities: '{"a":1}',
			contextTokens: null,
			costTier: null,
			isDefault: false,
		});
		const rt = makeRuntime(db);
		const rows = await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.list({ scope: "platform" })),
			asAdmin,
		);
		for (const name of ["bad-json", "non-array"]) {
			expect(rows.find((c) => c.name === name)?.capabilities).toEqual([]);
		}
		await rt.dispose();
	});

	it("records audit entries when the Audit service is bound", async () => {
		const entries: { action: string; tenantId?: unknown }[] = [];
		const audit = Layer.succeed(Audit, {
			record: (entry: { action: string; tenantId?: unknown }) =>
				Effect.sync(() => {
					entries.push(entry);
				}),
		} as never);
		const rt = makeRuntime(db, audit);
		await run(
			rt,
			Effect.flatMap(AiModels, (m) => m.create({ name: "audited", modelId: "a1" })),
			asAdmin,
		);
		await run(
			rt,
			Effect.flatMap(AiModels, (m) =>
				m.create({
					scope: "tenant",
					tenantId: TENANT_ID,
					name: "audited-tenant",
					modelId: "a2",
				}),
			),
			asTenantAdmin,
		);
		const actions = entries.map((e) => e.action);
		expect(actions).toContain("ai-model.create");
		const tenantEntry = entries.find((e) => e.tenantId === TENANT_ID);
		expect(tenantEntry).toBeDefined();
		await rt.dispose();
	});

	it("repo functions round-trip rows directly", async () => {
		const row = await insertModel(db, {
			scope: "platform",
			tenantId: null,
			endpointId: 3,
			name: "repo-row",
			modelId: "r1",
			kind: "tts",
			capabilities: '["tts"]',
			contextTokens: 2048,
			costTier: "high",
			isDefault: true,
		});
		expect(row.id).toBeGreaterThan(0);
		expect((await getModelById(db, row.id))?.name).toBe("repo-row");
		expect(await getModelById(db, 999999)).toBeNull();
		expect((await listModels(db, "platform", 3)).map((r) => r.name)).toContain("repo-row");
		expect((await listModels(db, "platform", 424242)).map((r) => r.name)).not.toContain("repo-row");
	});
});
