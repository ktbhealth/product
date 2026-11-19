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

	it("unsubscribing one of several listeners keeps the topic live", async () => {
		const bus = makeInProcessPubSub();
		const seen: unknown[] = [];
		const off = await bus.subscribe!("t", () => {});
		await bus.subscribe!("t", (p) => {
			seen.push(p);
		});
		off();
		await bus.publish("t", 1);
		expect(seen).toEqual([1]);
		expect(bus.topics()).toEqual(["t"]);
		expect(bus.subscriberCount("t")).toBe(1);
	});

	it("keeps an unsubscribed topic listed while it has retained history", async () => {
		const bus = makeInProcessPubSub();
		await bus.publish("t", "m");
		const off = await bus.subscribe!("t", () => {});
		off();
		// The listeners map drops the empty set, but retained history
		// keeps the topic in the listing.
		expect(bus.topics()).toEqual(["t"]);
		expect(bus.subscriberCount("t")).toBe(0);
		expect(bus.recentMessages("t")).toHaveLength(1);
	});

	it("drops a subscribe-only topic from the listing once it has no listeners", async () => {
		const bus = makeInProcessPubSub();
		const off = await bus.subscribe!("t", () => {});
		off();
		expect(bus.topics()).toEqual([]);
		expect(bus.listTopics()).toEqual([]);
	});

	it("honors a custom idPrefix in listed topic ids", async () => {
		const bus = makeInProcessPubSub({ idPrefix: "probe" });
		await bus.publish("t", 1);
		expect(bus.listTopics()[0]?.id).toBe("probe:t");
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
