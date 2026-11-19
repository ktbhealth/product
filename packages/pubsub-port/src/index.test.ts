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

	it("merges sources and keeps the first id on collisions", async () => {
		const merged = mergePubSubSources([
			{ list: async () => [topic("a"), topic("dup")] },
			{ list: async () => [topic("dup"), topic("b")] },
		]);
		expect((await merged.list()).map((t) => t.id)).toEqual(["a", "dup", "b"]);
	});

	it("collapses a failing source to an empty list", async () => {
		const merged = mergePubSubSources([
			{
				list: async () => {
					throw new Error("down");
				},
			},
			{ list: async () => [topic("ok")] },
		]);
		expect((await merged.list()).map((t) => t.id)).toEqual(["ok"]);
	});
});
