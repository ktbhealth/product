import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { installServerFnRuntime, resetServerFnRuntime, stubAuth } from "@ktb/server-fns/testing";
import type { PubSubPublishResult, PubSubTopicInfo } from "@ktb/server-fns";

import { PubSubAdmin, PubSubAdminLive } from "./admin.ts";

const adminGate = (admin: boolean) =>
	makePlatformAdminGate(parsePlatformAdminEmails(admin ? "admin@x.com" : ""));

const makeRuntime = (admin = true) =>
	ManagedRuntime.make(
		PubSubAdminLive.pipe(Layer.provide(Layer.succeed(PlatformAdmin, adminGate(admin)))),
	);

const asPrincipal = <A>(
	runtime: ManagedRuntime.ManagedRuntime<PubSubAdmin, never>,
	effect: (a: PubSubAdmin["Service"]) => Effect.Effect<A, unknown, never>,
	email: string,
) =>
	runtime.runPromise(
		Effect.flatMap(PubSubAdmin, effect).pipe(
			Effect.provideService(Principal, { userId: "u1", email }),
		),
	);

const TOPIC: PubSubTopicInfo = {
	id: "memory:cron.fires",
	name: "cron.fires",
	transport: "in-process",
	subscribers: 0,
	recent: [],
};

describe("PubSubAdminLive", () => {
	it("returns topics and routes publishes for admins", async () => {
		const runtime = makeRuntime();
		const publishCalls: [string, unknown][] = [];
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{
				pubsub: {
					topics: async () => [TOPIC],
					publish: async (topicId, payload) => {
						publishCalls.push([topicId, payload]);
						return { ok: true };
					},
				},
			},
		);
		const topics = await asPrincipal(runtime, (a) => a.topics(), "admin@x.com");
		expect(topics).toEqual([TOPIC]);
		const result = await asPrincipal(
			runtime,
			(a) => a.publish("memory:cron.fires", { ping: true }),
			"admin@x.com",
		);
		expect(result).toEqual({ ok: true });
		expect(publishCalls).toEqual([["memory:cron.fires", { ping: true }]]);
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("collapses a missing pubsub capability to null and unavailable", async () => {
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{},
		);
		const topics = await asPrincipal(runtime, (a) => a.topics(), "admin@x.com");
		expect(topics).toBeNull();
		const result = await asPrincipal(runtime, (a) => a.publish("memory:x", {}), "admin@x.com");
		expect(result).toEqual({ ok: false, reason: "unavailable" });
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("passes through honest publish failure reasons", async () => {
		const results: PubSubPublishResult[] = [
			{ ok: false, reason: "unknown-topic" },
			{ ok: false, reason: "publish-failed" },
		];
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{
				pubsub: {
					topics: async () => [],
					publish: async () => results.shift() ?? { ok: true },
				},
			},
		);
		const first = await asPrincipal(runtime, (a) => a.publish("bad:id", 1), "admin@x.com");
		expect(first).toEqual({ ok: false, reason: "unknown-topic" });
		const second = await asPrincipal(runtime, (a) => a.publish("memory:x", 1), "admin@x.com");
		expect(second).toEqual({ ok: false, reason: "publish-failed" });
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("collapses throwing probes to null and publish throws to publish-failed", async () => {
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{
				pubsub: {
					topics: async () => {
						throw new Error("sources gone");
					},
					publish: async () => {
						throw new Error("transport exploded");
					},
				},
			},
		);
		const topics = await asPrincipal(runtime, (a) => a.topics(), "admin@x.com");
		expect(topics).toBeNull();
		const result = await asPrincipal(runtime, (a) => a.publish("memory:x", {}), "admin@x.com");
		expect(result).toEqual({ ok: false, reason: "publish-failed" });
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("rejects non-admins with Forbidden on every method", async () => {
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{},
		);
		for (const call of [
			(a: PubSubAdmin["Service"]) => a.topics(),
			(a: PubSubAdmin["Service"]) => a.publish("memory:x", {}),
		] as const) {
			const exit = await runtime.runPromiseExit(
				Effect.flatMap(PubSubAdmin, (a) => call(a) as Effect.Effect<unknown, unknown, never>).pipe(
					Effect.provideService(Principal, { userId: "u1", email: "doc@x.com" }),
				),
			);
			expect(exit._tag).toBe("Failure");
		}
		await runtime.dispose();
		resetServerFnRuntime();
	});
});
