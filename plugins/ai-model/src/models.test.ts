import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, type TenantRole } from "@ktb/tenant";

import { AI_MODEL_TEST_DDL, AiModels, AiModelsLive } from "./index.ts";

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
});
