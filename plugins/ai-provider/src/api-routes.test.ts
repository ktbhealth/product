import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";

import { Route } from "./api-routes/ai.bridge.ts";
import { mintBridgeToken, sha256Hex } from "./bridge-token.ts";
import { aiAgentLink, aiEndpoint } from "./schema.ts";

// Thin wiring check: GET delegates to handleBridgeUpgrade — the full
// auth/token/forwarding matrix lives in bridge.test.ts; here we only
// prove the route mounts it under the plugin gate.
const handlersOf = (r: unknown) =>
	(r as { options: { server: { handlers: Record<string, (a: never) => Promise<Response>> } } })
		.options.server.handlers;

afterEach(() => resetServerRuntime());

describe("GET /api/ai/bridge route", () => {
	it("delegates the upgrade to handleBridgeUpgrade", async () => {
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
		const token = mintBridgeToken();
		await db.insert(aiAgentLink).values({
			endpointId: row!.id,
			tokenHash: await sha256Hex(token),
			createdBy: "u1",
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: new Date(),
		});
		const forwards: number[] = [];
		setServerRuntime({
			run: <A, E>(e: Effect.Effect<A, E, unknown>) =>
				rt.runPromise(e as Effect.Effect<A, E, never>),
			runAs: <A, E>(_user: { readonly id: string }, e: Effect.Effect<A, E, unknown>) =>
				rt.runPromise(e as Effect.Effect<A, E, never>),
			audioTranscribeModel: "test-model",
			getLocale: () => "en",
			acpBridge: async (endpointId: number) => {
				forwards.push(endpointId);
				return new Response(null, { status: 200 });
			},
		} as ServerRuntime);

		const res = await handlersOf(Route).GET({
			request: new Request(`https://app.test/api/ai/bridge?token=${token}`, {
				headers: { upgrade: "websocket" },
			}),
		} as never);
		expect(res.status).toBe(200);
		expect(forwards).toEqual([row!.id]);
		return rt.dispose();
	});
});
