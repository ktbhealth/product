import { describe, expect, it, vi } from "vitest";

import type { JobEnvelope } from "@ktb/jobs-port";
import { queueTransportContract } from "@ktb/queues-port/testing";

import { createRedisJobsTransport, type RedisLike } from "./index.ts";

// The node client path (`createClient` + `connect`) is exercised through
// this seam — no real Redis in tests.
const redisMock = vi.hoisted(() => ({
	createClient: vi.fn(),
}));

vi.mock("redis", () => ({ createClient: redisMock.createClient }));

type ListSide = "LEFT" | "RIGHT";

/** In-memory RedisLike: LPUSH/BLMOVE/LMOVE/LREM/LLEN over named lists.
 * Index 0 is the head (LPUSH side); pop()/shift() model RIGHT/LEFT. */
const fakeRedis = () => {
	const lists = new Map<string, string[]>();
	const listFor = (key: string) => {
		let l = lists.get(key);
		if (l === undefined) {
			l = [];
			lists.set(key, l);
		}
		return l;
	};
	const popSide = (l: string[], side: ListSide) => (side === "RIGHT" ? l.pop() : l.shift());
	const pushSide = (l: string[], side: ListSide, v: string) => {
		if (side === "LEFT") l.unshift(v);
		else l.push(v);
	};
	const move = (source: string, destination: string, ss: ListSide, ds: ListSide) => {
		const v = popSide(listFor(source), ss);
		if (v === undefined) return null;
		pushSide(listFor(destination), ds, v);
		return v;
	};
	const timeouts: number[] = [];
	// Sorted-set stand-in for the delayed queue (`<queue>:delayed`).
	const zsets = new Map<string, Map<string, number>>();
	const zsetFor = (key: string) => {
		let z = zsets.get(key);
		if (z === undefined) {
			z = new Map();
			zsets.set(key, z);
		}
		return z;
	};
	const client: RedisLike = {
		lPush: async (key, value) => {
			listFor(key).unshift(value);
			return 1;
		},
		rPush: async (key, value) => {
			const l = listFor(key);
			l.push(value);
			return l.length;
		},
		blMove: async (source, destination, ss, ds, timeoutSeconds) => {
			timeouts.push(timeoutSeconds);
			return move(source, destination, ss, ds);
		},
		lMove: async (source, destination, ss, ds) => move(source, destination, ss, ds),
		lRem: async (key, _count, value) => {
			const l = listFor(key);
			const i = l.indexOf(value);
			if (i === -1) return 0;
			l.splice(i, 1);
			return 1;
		},
		lLen: async (key) => listFor(key).length,
		quit: async () => "OK",
		zAdd: async (key, member) => {
			zsetFor(key).set(member.value, member.score);
			return 1;
		},
		zCard: async (key) => zsetFor(key).size,
		// Emulates the transport's SWEEP_DUE Lua: move due zset members
		// (score <= now, earliest first, capped) onto the list head.
		eval: async (_script, { keys, arguments: args }) => {
			const [zkey, lkey] = keys as [string, string];
			const now = Number(args[0]);
			const limit = Number(args[1]);
			const z = zsets.get(zkey);
			if (z === undefined) return 0;
			const due = [...z.entries()]
				.filter(([, score]) => score <= now)
				.sort((a, b) => a[1] - b[1])
				.slice(0, limit);
			let moved = 0;
			for (const [member] of due) {
				z.delete(member);
				listFor(lkey).unshift(member);
				moved += 1;
			}
			return moved;
		},
	};
	// `list` stays the queue for existing assertions; `pending` is the
	// in-flight list the transport parks popped entries on.
	return {
		client,
		lists,
		zsets,
		list: listFor("ktb:jobs"),
		pending: listFor("ktb:jobs:pending"),
		delayed: zsetFor("ktb:jobs:delayed"),
		timeouts,
	};
};

const envelope = (id: string): JobEnvelope => ({
	id,
	kind: "jobs.ping",
	payload: { n: 1 },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

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

	it("send accepts non-record bodies — the runAt probe is defensive", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send("raw-string");
		const [msg] = await t.receive();
		expect(msg?.body).toBe("raw-string");
		await t.close();
	});

	it("receive returns [] when the list is empty", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		expect(await t.receive()).toEqual([]);
		await t.close();
	});

	it("receive uses the short fill timeout once a message is in hand", async () => {
		const { client, timeouts } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 5 });
		await t.send(envelope("one"));
		const msgs = await t.receive(5);
		expect(msgs).toHaveLength(1);
		// First pop may block for the full idle window; the batch-fill
		// pops that drain the queue must not stall it again.
		expect(timeouts).toEqual([5, 0.1]);
		await t.close();
	});

	it("receive on an empty queue blocks with blockSeconds", async () => {
		const { client, timeouts } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 3 });
		expect(await t.receive(5)).toEqual([]);
		expect(timeouts).toEqual([3]);
		await t.close();
	});

	it("receive parks the raw envelope on the pending list until ack", async () => {
		const { client, list, pending } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("parked"));
		const [msg] = await t.receive();
		expect(list).toHaveLength(0);
		expect(pending).toHaveLength(1);
		msg?.ack();
		await flush();
		expect(pending).toHaveLength(0);
		await t.close();
	});

	it("a crash mid-handle leaves the entry pending; requeuePending redelivers it", async () => {
		const { client, list, pending } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("orphan"));
		// receive() then "crash": no ack, no retry — the entry must
		// survive on the pending list, not vanish with the pop.
		const [msg] = await t.receive();
		expect(msg?.body).toEqual(envelope("orphan"));
		expect(pending).toHaveLength(1);
		expect(await t.requeuePending()).toBe(1);
		expect(pending).toHaveLength(0);
		expect(list).toHaveLength(1);
		const [again] = await t.receive();
		expect(again?.body).toEqual(envelope("orphan"));
		await t.close();
	});

	it("requeuePending returns 0 when nothing is in flight", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		expect(await t.requeuePending()).toBe(0);
		await t.close();
	});

	it("retry() re-queues the raw body and clears the pending copy", async () => {
		const { client, list, pending } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("j2"));
		const [msg] = await t.receive();
		msg?.retry();
		// retry is fire-and-forget — flush microtasks.
		await flush();
		expect(pending).toHaveLength(0);
		expect(list).toHaveLength(1);
		const [again] = await t.receive();
		expect(again?.body).toMatchObject(envelope("j2"));
		await t.close();
	});

	it("retry() increments attempts on the requeued envelope and reports it", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("j3"));
		const [first] = await t.receive();
		expect(first?.attempts).toBe(1);
		first?.retry();
		await new Promise((r) => setTimeout(r, 0));
		const [second] = await t.receive();
		expect(second?.attempts).toBe(2);
		second?.retry();
		await new Promise((r) => setTimeout(r, 0));
		const [third] = await t.receive();
		expect(third?.attempts).toBe(3);
		await t.close();
	});

	it("retry() requeues via RPUSH so the retried message is popped next", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("old"));
		await t.send(envelope("retried"));
		// list is [retried(left/newest), old(right/oldest)]; BRPOP pops old first.
		const [first] = await t.receive();
		expect(first?.body).toMatchObject({ id: "old" });
		first?.retry();
		await new Promise((r) => setTimeout(r, 0));
		// RPUSH put "old" at the tail — it must be popped before "retried".
		const [next] = await t.receive();
		expect(next?.body).toMatchObject({ id: "old" });
		expect(next?.attempts).toBe(2);
		await t.close();
	});

	it("retry() re-queues ahead of the backlog — delivered on the next poll", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("first"));
		await t.send(envelope("second"));
		await t.send(envelope("third"));
		const [msg] = await t.receive();
		expect(msg?.body).toEqual(envelope("first"));
		msg?.retry();
		await new Promise((r) => setTimeout(r, 0));
		const [again] = await t.receive();
		expect(again?.body).toMatchObject(envelope("first"));
		expect(again?.attempts).toBe(2);
		const [next] = await t.receive();
		expect(next?.body).toEqual(envelope("second"));
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

	it("retry() on a non-record body re-pushes the raw string unchanged", async () => {
		const { client, list } = fakeRedis();
		list.push("not-json{");
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		const [msg] = await t.receive();
		msg?.retry();
		await new Promise((r) => setTimeout(r, 0));
		expect(list).toEqual(["not-json{"]);
		const [again] = await t.receive();
		expect(again?.body).toBe("not-json{");
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

	it("ack() clears the pending copy once the entry is popped", async () => {
		const { client, pending } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("ack-me"));
		const [msg] = await t.receive();
		msg?.ack();
		await flush();
		expect(pending).toHaveLength(0);
		await t.close();
	});

	it("stats() reports pending backlog and in-flight depth", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("s1"));
		await t.send(envelope("s2"));
		expect(await t.stats()).toEqual({
			pending: 2,
			processing: 0,
			done: 0,
			failed: 0,
		});
		await t.receive();
		expect(await t.stats()).toEqual({
			pending: 1,
			processing: 1,
			done: 0,
			failed: 0,
		});
		await t.close();
	});

	it("ack() swallows pending-clear failures", async () => {
		const entries: string[] = [JSON.stringify(envelope("poison"))];
		const client: RedisLike = {
			lPush: async () => 1,
			rPush: async () => 0,
			blMove: async () => entries.pop() ?? null,
			lMove: async () => null,
			lRem: async () => {
				throw new Error("redis down");
			},
			lLen: async () => entries.length,
			quit: async () => "OK",
		};
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		const [msg] = await t.receive();
		msg?.ack();
		await flush();
		await t.close();
	});

	it("retry() swallows requeue failures", async () => {
		const entries: string[] = [JSON.stringify(envelope("poison"))];
		const client: RedisLike = {
			lPush: async () => {
				throw new Error("redis down");
			},
			rPush: async () => {
				throw new Error("redis down");
			},
			blMove: async () => (entries.length === 0 ? null : entries.pop()!),
			lMove: async () => null,
			lRem: async () => 1,
			lLen: async () => entries.length,
			quit: async () => "OK",
		};
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		const [msg] = await t.receive();
		msg?.retry();
		// Let the fire-and-forget requeue rejection settle through .catch.
		await flush();
		await t.close();
	});

	it("builds a node client from url when none is injected", async () => {
		const { client } = fakeRedis();
		const connected = { ...client, connect: async () => "OK" };
		redisMock.createClient.mockReturnValue(connected);
		const t = await createRedisJobsTransport({
			url: "redis://example:6390",
			queue: "custom:queue",
			blockSeconds: 1,
		});
		expect(redisMock.createClient).toHaveBeenCalledWith({ url: "redis://example:6390" });
		await t.send(envelope("via-client"));
		const [msg] = await t.receive();
		expect(msg?.body).toEqual(envelope("via-client"));
		await t.close();
	});

	it("close() is bounded and destroys the client when quit() never resolves", async () => {
		const destroy = vi.fn();
		const client: RedisLike = {
			lPush: async () => 0,
			rPush: async () => 0,
			blMove: async () => null,
			lMove: async () => null,
			lRem: async () => 0,
			lLen: async () => 0,
			// Simulates node-redis during reconnect: QUIT sits in the
			// offline queue and the promise never settles.
			quit: () => new Promise(() => {}),
			destroy,
		};
		const t = await createRedisJobsTransport({ client });
		await expect(t.close()).resolves.toBeUndefined();
		expect(destroy).toHaveBeenCalledOnce();
	});

	it("close() destroys the client even when quit() succeeds", async () => {
		const { client } = fakeRedis();
		const destroy = vi.fn();
		const t = await createRedisJobsTransport({ client: { ...client, destroy } });
		await t.close();
		expect(destroy).toHaveBeenCalledOnce();
	});

	it("close() resolves and destroys when quit() rejects", async () => {
		const { client } = fakeRedis();
		const destroy = vi.fn();
		const t = await createRedisJobsTransport({
			client: { ...client, quit: async () => Promise.reject(new Error("gone")), destroy },
		});
		await expect(t.close()).resolves.toBeUndefined();
		expect(destroy).toHaveBeenCalledOnce();
	});

	it("parks a future runAt on the delayed zset; the sweep delivers it when due", async () => {
		const { client, list, delayed } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0, sweepMs: 5 });
		const runAt = Date.now() + 40;
		await t.send({ ...envelope("late"), runAt });
		// Nothing on the deliverable list — the envelope sits in the zset.
		expect(list).toHaveLength(0);
		expect(delayed.size).toBe(1);
		// Not due yet: an immediate receive finds nothing.
		expect(await t.receive()).toEqual([]);
		await vi.waitFor(() => expect(list).toHaveLength(1), { timeout: 2000 });
		const [msg] = await t.receive();
		expect(msg?.body).toMatchObject({ id: "late", kind: "jobs.ping" });
		expect(delayed.size).toBe(0);
		await t.close();
	});

	it("delivers a runAt envelope immediately when the client lacks zset support", async () => {
		const entries: string[] = [];
		const client: RedisLike = {
			lPush: async (_key, value) => {
				entries.unshift(value);
				return 1;
			},
			rPush: async () => 0,
			blMove: async () => entries.pop() ?? null,
			lMove: async () => null,
			lRem: async () => 0,
			lLen: async () => entries.length,
			quit: async () => "OK",
		};
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send({ ...envelope("early"), runAt: Date.now() + 60_000 });
		const [msg] = await t.receive();
		expect(msg?.body).toMatchObject({ id: "early" });
		await t.close();
	});

	it("no-ops the delayed sweep when the client lacks eval", async () => {
		const { client, delayed } = fakeRedis();
		const noEval: RedisLike = { ...client };
		delete noEval.eval;
		const t = await createRedisJobsTransport({ client: noEval, blockSeconds: 0, sweepMs: 5 });
		await t.send({ ...envelope("stuck"), runAt: Date.now() + 60_000 });
		await t.send(envelope("plain"));
		// Several sweep ticks fire against a client without eval — the
		// sweep must no-op, not throw, and normal delivery is unaffected.
		await new Promise((r) => setTimeout(r, 25));
		const [msg] = await t.receive();
		expect(msg?.body).toEqual(envelope("plain"));
		// The future-runAt envelope stays parked — nothing sweeps it.
		expect(delayed.size).toBe(1);
		await t.close();
	});

	it("swallows delayed-sweep eval failures", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({
			client: {
				...client,
				eval: async () => {
					throw new Error("redis down");
				},
			},
			blockSeconds: 0,
			sweepMs: 5,
		});
		// Let a sweep tick hit the rejecting eval — the warn is the
		// contract; the transport stays usable.
		await new Promise((r) => setTimeout(r, 25));
		await t.send(envelope("still-alive"));
		const [msg] = await t.receive();
		expect(msg?.body).toEqual(envelope("still-alive"));
		await t.close();
	});

	it("stats() works when the client lacks zset support", async () => {
		const entries: string[] = [];
		const client: RedisLike = {
			lPush: async (_key, value) => {
				entries.unshift(value);
				return 1;
			},
			rPush: async () => 0,
			blMove: async () => entries.pop() ?? null,
			lMove: async () => null,
			lRem: async () => 0,
			lLen: async (key) => (key.endsWith(":pending") ? 0 : entries.length),
			quit: async () => "OK",
		};
		const t = await createRedisJobsTransport({ client, blockSeconds: 0 });
		await t.send(envelope("s"));
		expect(await t.stats()).toEqual({
			pending: 1,
			processing: 0,
			done: 0,
			failed: 0,
		});
		await t.close();
	});

	it("stats() counts delayed entries as pending backlog", async () => {
		const { client } = fakeRedis();
		const t = await createRedisJobsTransport({ client, blockSeconds: 0, sweepMs: 60_000 });
		await t.send(envelope("now"));
		await t.send({ ...envelope("later"), runAt: Date.now() + 60_000 });
		expect(await t.stats()).toEqual({
			pending: 2,
			processing: 0,
			done: 0,
			failed: 0,
		});
		await t.close();
	});

	it("falls back to default url, queue and block seconds", async () => {
		const { client } = fakeRedis();
		const connected = { ...client, connect: async () => "OK" };
		redisMock.createClient.mockReturnValue(connected);
		const t = await createRedisJobsTransport();
		expect(redisMock.createClient).toHaveBeenCalledWith({
			url: "redis://127.0.0.1:6379",
		});
		await t.close();
	});
});

// Shared QueueTransport port contract (@ktb/queues-port/testing) — the
// same cases the memory and sqlite adapters run.
queueTransportContract({
	name: "redis-jobs",
	make: async () => {
		const { client } = fakeRedis();
		return createRedisJobsTransport({ client, blockSeconds: 0 });
	},
});
