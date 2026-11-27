import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";

import { mintBridgeToken, sha256Hex } from "./bridge-token.ts";
import { handleBridgeUpgrade } from "./bridge.ts";
import { aiAgentLink, aiEndpoint } from "./schema.ts";

/** One seeded bridge endpoint + runtime whose acpBridge capability
 * records the handoff. Mirrors the DO stub's shape without the
 * binding — the handler only forwards `request` to it. */
const harness = async () => {
	const db = makeDb(makeTestD1());
	const rt = ManagedRuntime.make(Layer.succeed(Db, db as never));
	const [row] = await db
		.insert(aiEndpoint)
		.values({
			name: "Local agent",
			kind: "acp",
			baseUrl: null,
			transport: "ws",
			createdAt: new Date(),
		})
		.returning({ id: aiEndpoint.id });
	const forwards: { endpointId: number; url: string }[] = [];
	const runtime: ServerRuntime = {
		run: <A, E>(e: Effect.Effect<A, E, unknown>) => rt.runPromise(e as Effect.Effect<A, E, never>),
		runAs: <A, E>(_user: { readonly id: string }, e: Effect.Effect<A, E, unknown>) =>
			rt.runPromise(e as Effect.Effect<A, E, never>),
		audioTranscribeModel: "test-model",
		getLocale: () => "en",
		acpBridge: async (endpointId: number, request: Request) => {
			forwards.push({ endpointId, url: request.url });
			return new Response(null, { status: 200 });
		},
	};
	setServerRuntime(runtime);
	return { db, rt, endpointId: row!.id, forwards };
};

const seedLink = async (
	db: Awaited<ReturnType<typeof harness>>["db"],
	endpointId: number,
	over: { usedAt?: Date; expiresAt?: Date; revokedAt?: Date } = {},
) => {
	const token = mintBridgeToken();
	await db.insert(aiAgentLink).values({
		endpointId,
		tokenHash: await sha256Hex(token),
		createdBy: "u1",
		expiresAt: over.expiresAt ?? new Date(Date.now() + 60_000),
		createdAt: new Date(),
		...(over.usedAt !== undefined ? { usedAt: over.usedAt } : {}),
		...(over.revokedAt !== undefined ? { revokedAt: over.revokedAt } : {}),
	});
	return token;
};

const upgrade = (token: string | null) =>
	new Request(`https://app.test/api/ai/bridge${token === null ? "" : `?token=${token}`}`, {
		headers: { upgrade: "websocket" },
	});

afterEach(() => resetServerRuntime());

describe("handleBridgeUpgrade", () => {
	it("rejects missing tokens and non-upgrade requests", async () => {
		const { db, rt, endpointId } = await harness();
		expect((await handleBridgeUpgrade(new Request("https://app.test/api/ai/bridge"))).status).toBe(
			400,
		);
		expect((await handleBridgeUpgrade(upgrade(null))).status).toBe(400);
		// Token validation runs before the upgrade check — an unknown
		// token reports 401 whatever the request shape.
		expect(
			(await handleBridgeUpgrade(new Request("https://app.test/api/ai/bridge?token=t"))).status,
		).toBe(401);
		// A non-upgrade request on a valid unused link → 400.
		const token = await seedLink(db, endpointId);
		expect(
			(await handleBridgeUpgrade(new Request(`https://app.test/api/ai/bridge?token=${token}`)))
				.status,
		).toBe(400);
		await rt.dispose();
	});

	it("answers 501 when the runtime has no acpBridge capability", async () => {
		const db = makeDb(makeTestD1());
		const rt = ManagedRuntime.make(Layer.succeed(Db, db as never));
		setServerRuntime({
			run: <A, E>(e: Effect.Effect<A, E, unknown>) =>
				rt.runPromise(e as Effect.Effect<A, E, never>),
			runAs: <A, E>(_user: { readonly id: string }, e: Effect.Effect<A, E, unknown>) =>
				rt.runPromise(e as Effect.Effect<A, E, never>),
			audioTranscribeModel: "test-model",
			getLocale: () => "en",
		});
		const [row] = await db
			.insert(aiEndpoint)
			.values({ name: "ep", kind: "acp", baseUrl: null, transport: "ws", createdAt: new Date() })
			.returning({ id: aiEndpoint.id });
		const token = mintBridgeToken();
		await db.insert(aiAgentLink).values({
			endpointId: row!.id,
			tokenHash: await sha256Hex(token),
			createdBy: "u1",
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: new Date(),
		});
		expect((await handleBridgeUpgrade(upgrade(token))).status).toBe(501);
		await rt.dispose();
	});

	it("rejects unknown and expired tokens with distinct statuses", async () => {
		const { db, rt, endpointId } = await harness();
		expect((await handleBridgeUpgrade(upgrade("never-minted"))).status).toBe(401);

		const expired = await seedLink(db, endpointId, { expiresAt: new Date(Date.now() - 1) });
		expect((await handleBridgeUpgrade(upgrade(expired))).status).toBe(410);
		await rt.dispose();
	});

	it("allows upgrades on a used link (bearer session), but 409s a plain request on it", async () => {
		const { db, rt, endpointId, forwards } = await harness();
		const used = await seedLink(db, endpointId, { usedAt: new Date() });
		// Reconnect pre-expiry: the upgrade forwards again — used_at is
		// audit, not a gate.
		expect((await handleBridgeUpgrade(upgrade(used))).status).toBe(200);
		expect(forwards).toHaveLength(1);
		// A non-upgrade HTTP replay reports the consumed link instead.
		expect(
			(await handleBridgeUpgrade(new Request(`https://app.test/api/ai/bridge?token=${used}`)))
				.status,
		).toBe(409);
		await rt.dispose();
	});

	it("refuses revoked tokens before the used/expired checks", async () => {
		const { db, rt, endpointId, forwards } = await harness();
		const token = await seedLink(db, endpointId, { revokedAt: new Date() });
		const res = await handleBridgeUpgrade(upgrade(token));
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "token revoked" });
		expect(forwards).toHaveLength(0);
		// Revocation wins over the used flag too — a pulled link is dead.
		const usedRevoked = await seedLink(db, endpointId, {
			usedAt: new Date(),
			revokedAt: new Date(),
		});
		expect((await handleBridgeUpgrade(upgrade(usedRevoked))).status).toBe(403);
		await rt.dispose();
	});

	it("rejects links for missing or disabled endpoints", async () => {
		const { db, rt, endpointId } = await harness();
		const token = await seedLink(db, endpointId);
		await db.update(aiEndpoint).set({ enabled: false }).where(eq(aiEndpoint.id, endpointId));
		expect((await handleBridgeUpgrade(upgrade(token))).status).toBe(403);
		await rt.dispose();
	});

	it("stamps used_at on first upgrade and forwards the upgrade to the endpoint's DO", async () => {
		const { db, rt, endpointId, forwards } = await harness();
		const token = await seedLink(db, endpointId);
		const res = await handleBridgeUpgrade(upgrade(token));
		expect(res.status).toBe(200);
		expect(forwards).toEqual([
			{ endpointId, url: `https://app.test/api/ai/bridge?token=${token}` },
		]);
		const link = (await db.select().from(aiAgentLink))[0]!;
		expect(link.usedAt).not.toBeNull();
		// Reconnect (socket drop, CLI retry): the bearer token upgrades
		// again pre-expiry — and the first-use stamp is not rewritten.
		const res2 = await handleBridgeUpgrade(upgrade(token));
		expect(res2.status).toBe(200);
		expect(forwards).toHaveLength(2);
		const after = (await db.select().from(aiAgentLink))[0]!;
		expect(after.usedAt?.getTime()).toBe(link.usedAt!.getTime());
		await rt.dispose();
	});
});

describe("bridge-token", () => {
	it("mints url-safe tokens and hashes them deterministically", async () => {
		const a = mintBridgeToken();
		const b = mintBridgeToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(a).not.toBe(b);
		expect(await sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
		expect(await sha256Hex(a)).toBe(await sha256Hex(a));
	});
});
