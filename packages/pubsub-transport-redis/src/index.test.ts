import { describe, expect, it } from "vitest";

import { createRedisPubSubTransport, type RedisPubSubLike } from "./index.ts";

const fakeClient = (over: Partial<RedisPubSubLike> = {}): RedisPubSubLike => ({
	publish: async () => 0,
	quit: async () => {},
	...over,
});

describe("createRedisPubSubTransport", () => {
	it("publishes JSON-serialized payloads", async () => {
		const sent: [string, string][] = [];
		const transport = await createRedisPubSubTransport({
			client: fakeClient({
				publish: async (channel, message) => {
					sent.push([channel, message]);
					return 1;
				},
			}),
		});
		await transport.publish("ktb:events", { a: 1 });
		expect(sent).toEqual([["ktb:events", '{"a":1}']]);
	});

	it("lists channels with per-channel NUMSUB subscriber counts", async () => {
		const numsubCalls: string[][] = [];
		const transport = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => ["ktb:events", "ktb:signals"],
				// Plain-object reply — the node-redis v6 shape.
				pubSubNumSub: async (...channels) => {
					numsubCalls.push([...channels]);
					return { "ktb:events": 3, "ktb:signals": 0 };
				},
			}),
		});
		const topics = await transport.listTopics();
		// One batched NUMSUB call for all channels.
		expect(numsubCalls).toEqual([["ktb:events", "ktb:signals"]]);
		expect(topics).toEqual([
			{ id: "redis:ktb:events", name: "ktb:events", transport: "redis", subscribers: 3 },
			{ id: "redis:ktb:signals", name: "ktb:signals", transport: "redis", subscribers: 0 },
		]);
	});

	it("parses array and Map NUMSUB replies too", async () => {
		const arrayClient = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => ["c"],
				pubSubNumSub: async () => ["c", 7],
			}),
		});
		expect((await arrayClient.listTopics())[0]?.subscribers).toBe(7);

		const mapClient = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => ["c"],
				pubSubNumSub: async () => new Map([["c", 4]]),
			}),
		});
		expect((await mapClient.listTopics())[0]?.subscribers).toBe(4);
	});

	it("reports null subscribers and rejects channel-list failures honestly", async () => {
		const noProbes = await createRedisPubSubTransport({ client: fakeClient() });
		expect(await noProbes.listTopics()).toEqual([]);

		// PUBSUB CHANNELS failure must REJECT — the merge layer turns it
		// into a degraded source, never a fake empty channel set.
		const failing = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => {
					throw new Error("redis down");
				},
			}),
		});
		await expect(failing.listTopics()).rejects.toThrow("redis down");

		const numsubFails = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => ["c"],
				pubSubNumSub: async () => {
					throw new Error("no numsub");
				},
			}),
		});
		expect((await numsubFails.listTopics())[0]?.subscribers).toBeNull();
	});

	it("subscribe delivers parsed payloads and unsubscribes per listener", async () => {
		const listeners = new Map<string, (message: string, channel: string) => void>();
		const unsubs: [string, unknown][] = [];
		const transport = await createRedisPubSubTransport({
			client: fakeClient({
				subscribe: async (channel, listener) => {
					listeners.set(channel, listener);
				},
				unsubscribe: async (channel, listener) => {
					unsubs.push([channel, listener]);
				},
			}),
		});
		const seen: unknown[] = [];
		const off = await transport.subscribe!("chan", (p) => {
			seen.push(p);
		});
		listeners.get("chan")?.('{"x":2}', "chan");
		await new Promise((r) => setTimeout(r, 0));
		expect(seen).toEqual([{ x: 2 }]);
		off();
		await new Promise((r) => setTimeout(r, 0));
		// Unsubscribe carries the SAME listener — other subscribers on
		// the channel are untouched.
		expect(unsubs).toHaveLength(1);
		expect(unsubs[0]?.[0]).toBe("chan");
	});
});
