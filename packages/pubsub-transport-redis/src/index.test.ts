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

	it("lists channels with NUMSUB subscriber counts", async () => {
		const transport = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => ["ktb:events", "ktb:signals"],
				pubSubNumSub: async (...channels) => [channels[0], 3],
			}),
		});
		const topics = await transport.listTopics();
		expect(topics).toEqual([
			{ id: "redis:ktb:events", name: "ktb:events", transport: "redis", subscribers: 3 },
			{ id: "redis:ktb:signals", name: "ktb:signals", transport: "redis", subscribers: 3 },
		]);
	});

	it("reports null subscribers and empty list when probes are absent or fail", async () => {
		const noProbes = await createRedisPubSubTransport({ client: fakeClient() });
		expect(await noProbes.listTopics()).toEqual([]);

		const failing = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => {
					throw new Error("redis down");
				},
			}),
		});
		expect(await failing.listTopics()).toEqual([]);

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

	it("subscribe delivers parsed payloads when the client supports it", async () => {
		let listener: ((message: string, channel: string) => void) | undefined;
		const transport = await createRedisPubSubTransport({
			client: fakeClient({
				sSubscribe: async (_channel, l) => {
					listener = l;
				},
				sUnsubscribe: async () => {},
			}),
		});
		const seen: unknown[] = [];
		const off = await transport.subscribe!("chan", (p) => {
			seen.push(p);
		});
		listener?.('{"x":2}', "chan");
		await new Promise((r) => setTimeout(r, 0));
		expect(seen).toEqual([{ x: 2 }]);
		expect(typeof off).toBe("function");
	});
});
