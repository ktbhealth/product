import { afterEach, describe, expect, it, vi } from "vitest";

import { createRedisPubSubTransport, type RedisPubSubLike } from "./index.ts";

// The real client path (no injected `client`) is exercised through a
// `redis` module mock — createClient returns whatever the test set as
// `socket.client`, so `connect()`/url resolution run for real.
const socket = vi.hoisted(() => ({
	createdUrls: [] as (string | undefined)[],
	client: null as (RedisPubSubLike & { connect(): Promise<unknown> }) | null,
}));

vi.mock("redis", () => ({
	createClient: (opts: { url?: string }) => {
		socket.createdUrls.push(opts.url);
		return socket.client;
	},
}));

afterEach(() => {
	socket.client = null;
	socket.createdUrls = [];
});

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

	it("connects a real client from the url option, defaulting to localhost", async () => {
		const quit = vi.fn<() => Promise<void>>(async () => {});
		const connect = vi.fn<() => Promise<void>>(async () => {});
		socket.client = { publish: async () => 0, quit, connect } as never;

		const fallback = await createRedisPubSubTransport();
		await createRedisPubSubTransport({ url: "redis://10.0.0.9:6380" });
		expect(socket.createdUrls).toEqual(["redis://127.0.0.1:6379", "redis://10.0.0.9:6380"]);
		expect(connect).toHaveBeenCalledTimes(2);

		await fallback.close();
		expect(quit).toHaveBeenCalledOnce();
	});

	it("serializes an undefined payload as null", async () => {
		const sent: [string, string][] = [];
		const transport = await createRedisPubSubTransport({
			client: fakeClient({
				publish: async (channel, message) => {
					sent.push([channel, message]);
					return 0;
				},
			}),
		});
		await transport.publish("chan", undefined);
		expect(sent).toEqual([["chan", "null"]]);
	});

	it("delivers the raw message when the payload is not JSON", async () => {
		const listeners = new Map<string, (message: string, channel: string) => void>();
		const transport = await createRedisPubSubTransport({
			client: fakeClient({
				subscribe: async (channel, listener) => {
					listeners.set(channel, listener);
				},
			}),
		});
		const seen: unknown[] = [];
		await transport.subscribe!("chan", (p) => {
			seen.push(p);
		});
		listeners.get("chan")?.("not json", "chan");
		await new Promise((r) => setTimeout(r, 0));
		expect(seen).toEqual(["not json"]);
	});

	it("logs handler rejections and swallows raw-fallback rejections", async () => {
		const listeners = new Map<string, (message: string, channel: string) => void>();
		const transport = await createRedisPubSubTransport({
			client: fakeClient({
				subscribe: async (channel, listener) => {
					listeners.set(channel, listener);
				},
			}),
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await transport.subscribe!("chan", async () => {
				throw new Error("handler exploded");
			});
			// Valid JSON → parsed payload reaches the handler; its
			// rejection is logged.
			listeners.get("chan")?.('{"x":1}', "chan");
			// Non-JSON → the handler is retried with the raw string; that
			// rejection is swallowed (already logged once per message).
			listeners.get("chan")?.("raw", "chan");
			await new Promise((r) => setTimeout(r, 0));
			expect(errorSpy).toHaveBeenCalledWith("redis pubsub handler failed", {
				topic: "chan",
				error: expect.stringContaining("handler exploded"),
			});
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("swallows unsubscribe failures and tolerates clients without unsubscribe", async () => {
		const unsubCalls: string[] = [];
		const rejecting = await createRedisPubSubTransport({
			client: fakeClient({
				subscribe: async () => {},
				unsubscribe: async (channel) => {
					unsubCalls.push(channel);
					throw new Error("unsub down");
				},
			}),
		});
		const off1 = await rejecting.subscribe!("chan", () => {});
		off1();
		await new Promise((r) => setTimeout(r, 0));
		expect(unsubCalls).toEqual(["chan"]);

		const noUnsub = await createRedisPubSubTransport({
			client: fakeClient({ subscribe: async () => {} }),
		});
		const off2 = await noUnsub.subscribe!("chan", () => {});
		expect(() => off2()).not.toThrow();
	});

	it("listTopics tolerates empty channel sets, absent NUMSUB and junk entries", async () => {
		// Empty channel list → the NUMSUB probe is skipped entirely.
		const noChannels = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => [],
				pubSubNumSub: async () => {
					throw new Error("must not be called");
				},
			}),
		});
		expect(await noChannels.listTopics()).toEqual([]);

		// CHANNELS without a NUMSUB capability → subscribers honestly null.
		const noNumSub = await createRedisPubSubTransport({
			client: fakeClient({ pubSubChannels: async () => ["c"] }),
		});
		expect((await noNumSub.listTopics())[0]?.subscribers).toBeNull();

		// Junk NUMSUB entries — non-string/unknown channels and
		// non-finite counts are ignored, leaving subscribers null.
		const junk = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => ["c"],
				pubSubNumSub: async () => [42, "x", "other", 9, "c", "not-a-count"] as unknown as string[],
			}),
		});
		expect((await junk.listTopics())[0]?.subscribers).toBeNull();

		// A degenerate NUMSUB reply (null/scalar, not array/Map/object)
		// parses to an empty count map → subscribers null.
		const degenerate = await createRedisPubSubTransport({
			client: fakeClient({
				pubSubChannels: async () => ["c"],
				pubSubNumSub: async () => null as unknown as string[],
			}),
		});
		expect((await degenerate.listTopics())[0]?.subscribers).toBeNull();
	});
});
