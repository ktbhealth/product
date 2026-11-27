import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	resetServerFnRuntime,
	reactStartServerMock,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { Permissions } from "@ktb/rbac";
import { EvalArtifacts, EvalRunner } from "@ktb/eval-consultation";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { evalInstance, evalInstanceItem } from "@ktb/eval-persona";
import { EvalValidatorLive } from "./index.ts";
import { evalRun, evalRunSample } from "./schema.ts";
import { Route } from "./api-routes/eval.$sampleId.audio.ts";

const handlersOf = (r: unknown) =>
	(r as { options: { server: { handlers: Record<string, (a: never) => Promise<Response>> } } })
		.options.server.handlers;

const db = makeDb(makeTestD1());
const state = { email: null as string | null, allow: true, enabled: true };

const artifactBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const env = Layer.mergeAll(
	Layer.succeed(Db, db as unknown as DbClient),
	Layer.succeed(
		Permissions,
		Permissions.of({
			permissionsFor: () => Effect.succeed(new Map()),
			canFor: () => Effect.succeed(state.allow),
			can: () => Effect.succeed(state.allow),
			requirePermissionFor: () =>
				state.allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
			requirePermission: () =>
				state.allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
			invalidate: () => Effect.void,
		} as never),
	),
	Layer.succeed(EvalRunner, EvalRunner.of({ run: () => Effect.void })),
	Layer.succeed(EvalArtifacts, EvalArtifacts.of({ getAudio: () => Effect.succeed(artifactBytes) })),
);

const runtime = ManagedRuntime.make(
	Layer.merge(EvalValidatorLive.pipe(Layer.provide(env)), env) as Layer.Layer<
		unknown,
		never,
		never
	>,
);

const seedItem = async () => {
	const [inst] = await db
		.insert(evalInstance)
		.values({ name: "cohort", mode: "selected", params: "{}", createdAt: new Date() })
		.returning();
	const [item] = await db
		.insert(evalInstanceItem)
		.values({
			instanceId: inst!.id,
			persona: "{}",
			script: "s",
			turns: "[]",
			voices: "{}",
			status: "done",
			state: "approved",
			createdAt: new Date(),
		})
		.returning();
	return { instanceId: inst!.id, itemId: item!.id };
};

beforeAll(async () => {
	installServerFnRuntime(
		runtime,
		stubAuth(() => sessionUser(state.email)),
		{
			pluginEnabled: async () => state.enabled,
		},
	);

	// Seed a finished run sample carrying an audioUri.
	const seeded = await seedItem();
	const [r] = await db
		.insert(evalRun)
		.values({ instanceId: seeded.instanceId, createdAt: new Date() })
		.returning();
	await db.insert(evalRunSample).values({
		runId: r!.id,
		itemId: seeded.itemId,
		status: "ok",
		result: JSON.stringify({ audioUri: "file:///work/a.wav" }),
		createdAt: new Date(),
	});
});

afterAll(() => {
	resetServerFnRuntime();
	return runtime.dispose();
});

const get = (sampleId: string, headers: Record<string, string> = {}) =>
	handlersOf(Route).GET!({
		params: { sampleId },
		request: new Request(`http://x/api/eval/${sampleId}/audio`, { headers }),
	} as never);

describe("GET /api/eval/:sampleId/audio", () => {
	it("404s when the plugin is disabled — before auth even runs", async () => {
		state.enabled = false;
		const res = await get("1");
		expect(res.status).toBe(404);
		state.enabled = true;
	});

	it("401s without a session", async () => {
		state.email = null;
		const res = await get("1");
		expect(res.status).toBe(401);
	});

	it("404s on malformed ids and unknown samples", async () => {
		state.email = "v@x.com";
		expect((await get("abc")).status).toBe(404);
		expect((await get("9999")).status).toBe(404);
	});

	it("404s for authenticated callers without the grant", async () => {
		state.allow = false;
		const res = await get("1");
		expect(res.status).toBe(404);
		state.allow = true;
	});

	it("streams the wav privately, with length + accept-ranges", async () => {
		const res = await get("1");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("audio/wav");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(res.headers.get("accept-ranges")).toBe("bytes");
		expect(res.headers.get("content-length")).toBe(String(artifactBytes.length));
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(artifactBytes);
	});

	it("serves a byte range as 206 with content-range", async () => {
		const res = await get("1", { range: "bytes=2-5" });
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe(`bytes 2-5/${artifactBytes.length}`);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([3, 4, 5, 6]));
	});

	it("416s on an out-of-bounds range", async () => {
		const res = await get("1", { range: "bytes=99-" });
		expect(res.status).toBe(416);
		expect(res.headers.get("content-range")).toBe(`bytes */${artifactBytes.length}`);
	});
});
