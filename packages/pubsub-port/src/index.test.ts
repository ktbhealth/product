import { describe, expect, it, vi } from "vitest";

import { makeInProcessPubSub, mergePubSubSources, type PubSubTopicInfo } from "./index.ts";

describe("makeInProcessPubSub", () => {
	it("fans published payloads out to subscribers", async () => {
		const bus = makeInProcessPubSub();
		const seen: unknown[] = [];
		await bus.subscribe!("t", (p) => {
			seen.push(p);
		});
		await bus.publish("t", { a: 1 });
		await bus.publish("t", { a: 2 });
		expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("isolates handler failures and keeps delivering", async () => {
		const bus = makeInProcessPubSub();
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const seen: unknown[] = [];
		await bus.subscribe!("t", () => {
			throw new Error("bad handler");
		});
		await bus.subscribe!("t", (p) => {
			seen.push(p);
		});
		await bus.publish("t", 1);
		expect(seen).toEqual([1]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("unsubscribe stops delivery", async () => {
		const bus = makeInProcessPubSub();
		const seen: unknown[] = [];
		const off = await bus.subscribe!("t", (p) => {
			seen.push(p);
		});
		off();
		await bus.publish("t", 1);
		expect(seen).toEqual([]);
	});

	it("tracks topics, subscriber counts and a bounded recent ring", async () => {
		const bus = makeInProcessPubSub();
		await bus.publish("alpha", "m1");
		await bus.publish("alpha", "m2");
		await bus.subscribe!("beta", () => {});
		await bus.subscribe!("beta", () => {});
		expect(bus.topics()).toEqual(["alpha", "beta"]);
		expect(bus.subscriberCount("alpha")).toBe(0);
		expect(bus.subscriberCount("beta")).toBe(2);
		expect(bus.recentMessages("alpha")).toHaveLength(2);
		expect(bus.recentMessages("beta")).toEqual([]);

		const topics = bus.listTopics();
		expect(topics).toEqual([
			{
				id: "memory:alpha",
				name: "alpha",
				transport: "in-process",
				subscribers: 0,
				recent: [
					{ at: expect.any(Number), payload: "m1" },
					{ at: expect.any(Number), payload: "m2" },
				],
			},
			{
				id: "memory:beta",
				name: "beta",
				transport: "in-process",
				subscribers: 2,
				recent: [],
			},
		]);

		// Ring cap: publish past RECENT_CAP keeps only the newest 20.
		for (let i = 0; i < 25; i++) await bus.publish("alpha", i);
		const recent = bus.recentMessages("alpha");
		expect(recent).toHaveLength(20);
		expect(recent.at(-1)?.payload).toBe(24);
	});
});

describe("mergePubSubSources", () => {
	const topic = (id: string): PubSubTopicInfo => ({
		id,
		name: id,
		transport: "redis",
		subscribers: null,
	});
	const source = (id: string, topics: PubSubTopicInfo[]) => ({
		id,
		list: async () => topics,
	});

	it("merges sources and keeps the first id on collisions", async () => {
		const merged = mergePubSubSources([
			source("a", [topic("t1"), topic("dup")]),
			source("b", [topic("dup"), topic("t2")]),
		]);
		const listing = await merged.list();
		expect(listing.topics.map((t) => t.id)).toEqual(["t1", "dup", "t2"]);
		expect(listing.degraded).toEqual([]);
	});

	it("reports a failing source as degraded instead of dropping it silently", async () => {
		const merged = mergePubSubSources([
			{
				id: "broken",
				list: async () => {
					throw new Error("down");
				},
			},
			source("ok", [topic("t")]),
		]);
		const listing = await merged.list();
		expect(listing.topics.map((t) => t.id)).toEqual(["t"]);
		expect(listing.degraded).toEqual(["broken"]);
	});
});
