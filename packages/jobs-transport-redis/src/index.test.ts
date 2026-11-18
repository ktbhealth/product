import { describe, expect, it, vi } from "vitest";
import { createClient } from "redis";

import type { JobEnvelope } from "@ktb/jobs-port";

import { createRedisJobsTransport, type RedisLike } from "./index.ts";

// The real `redis` client needs a server; the transport only uses the
// lPush/brPop/quit/connect surface, so the module is faked with the
// same in-memory list semantics as `fakeRedis` below.
vi.mock("redis", () => ({
	createClient: vi.fn(() => {
		const list: string[] = [];
		return {
			connect: async () => {},
			lPush: async (_key: string, value: string) => {
				list.unshift(value);
				return list.length;
			},
			brPop: async () => {
				const v = list.pop();
				return v === undefined ? null : (["ktb:jobs", v] as const);
			},
			quit: async () => "OK",
		};
	}),
}));

/** In-memory RedisLike: LPUSH/BRPOP semantics over a string list. */
const fakeRedis = () => {
	const list: string[] = [];
	const client: RedisLike = {
		lPush: async (_key, value) => {
			list.unshift(value);
			return list.length;
		},
		brPop: async () => {
			const v = list.pop();
			return v === undefined ? null : (["ktb:jobs", v] as const);
		},
		quit: async () => "OK",
	};
	return { client, list };
};

const envelope = (id: string): JobEnvelope => ({
	id,
	kind: "jobs.ping",
	payload: { n: 1 },
});

describe("createRedisJobsTransport", () => {
	it("send LPUSHes the serialized envelope; receive pops it as a message", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("j1"));
		const msgs = await t.receive();
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.body).toEqual(envelope("j1"));
		await t.close();
	});

	it("receive returns [] when the list is empty", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		expect(await t.receive()).toEqual([]);
		await t.close();
	});

	it("retry() re-queues the raw body for redelivery", async () => {
		const { client, list } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("j2"));
		const [msg] = await t.receive();
		msg?.retry();
		// retry is fire-and-forget — flush microtasks.
		await new Promise((r) => setTimeout(r, 0));
		expect(list).toHaveLength(1);
		const [again] = await t.receive();
		expect(again?.body).toEqual(envelope("j2"));
		await t.close();
	});

	it("malformed JSON surfaces as a string body (consumer marks poison)", async () => {
		const { client, list } = fakeRedis();
		list.push("not-json{");
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		const [msg] = await t.receive();
		expect(msg?.body).toBe("not-json{");
		await t.close();
	});

	it("receive(count) drains up to count messages", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("a"));
		await t.send(envelope("b"));
		const msgs = await t.receive(5);
		expect(msgs).toHaveLength(2);
		await t.close();
	});

	it("ack() is a no-op once the entry is popped", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("a1"));
		const [msg] = await t.receive();
		expect(msg?.ack()).toBeUndefined();
		await t.close();
	});

	it("retry() swallows lPush failures (fire-and-forget)", async () => {
		const { client, list } = fakeRedis();
		const failing: RedisLike = {
			...client,
			lPush: (key, value) =>
				value === "poison" ? Promise.reject(new Error("redis down")) : client.lPush(key, value),
		};
		list.push("poison");
		const t = await createRedisJobsTransport({ client: failing, blockSeconds: 0 });
		const [msg] = await t.receive();
		msg?.retry();
		await new Promise((r) => setTimeout(r, 0));
		expect(list).toHaveLength(0);
		await t.close();
	});

	it("creates and connects a redis client when none is injected", async () => {
		vi.mocked(createClient).mockClear();
		const t = await createRedisJobsTransport({ url: "redis://127.0.0.1:6390", blockSeconds: 0 });
		expect(createClient).toHaveBeenCalledWith({ url: "redis://127.0.0.1:6390" });
		await t.send(envelope("r1"));
		const [msg] = await t.receive();
		expect(msg?.body).toEqual(envelope("r1"));
		await t.close();
	});

	it("falls back to the default redis url when options are omitted", async () => {
		vi.mocked(createClient).mockClear();
		const t = await createRedisJobsTransport();
		expect(createClient).toHaveBeenCalledWith({ url: "redis://127.0.0.1:6379" });
		expect(await t.receive()).toEqual([]);
		await t.close();
	});
});
