import { describe, expect, it } from "vitest";

import {
	asQueueTransport,
	makeMemoryQueueTransport,
	makeQueueRegistry,
	queueDescriptorFor,
	QueueConsumers,
	QueueTransportKinds,
} from "./index.ts";
import { queueTransportContract } from "./testing.ts";

describe("makeQueueRegistry", () => {
	it("lists descriptors with resolved depth", async () => {
		const registry = makeQueueRegistry([
			{
				id: "audio",
				name: "ktb-transcription",
				transport: "sqlite",
				consumer: "in-app",
				stats: async () => ({ pending: 1, processing: 2, done: 3, failed: 4 }),
			},
			{ id: "jobs", name: "ktb:jobs", transport: "redis", consumer: "jobs-worker" },
		]);
		const queues = await registry.list();
		expect(queues).toEqual([
			{
				id: "audio",
				name: "ktb-transcription",
				transport: "sqlite",
				consumer: "in-app",
				depth: { pending: 1, processing: 2, done: 3, failed: 4 },
			},
			{
				id: "jobs",
				name: "ktb:jobs",
				transport: "redis",
				consumer: "jobs-worker",
				depth: null,
			},
		]);
	});

	it("derives depth from the bound transport's stats()", async () => {
		const queue = makeMemoryQueueTransport({ name: "mem:q" });
		await queue.send({ n: 1 });
		const registry = makeQueueRegistry([
			queueDescriptorFor(queue, { id: "mem", kind: "unknown", consumer: "in-app" }),
		]);
		const [info] = await registry.list();
		expect(info).toMatchObject({
			id: "mem",
			name: "mem:q",
			transport: "unknown",
			consumer: "in-app",
			depth: { pending: 1, processing: 0 },
		});
		queue.close();
	});

	it("prefers an explicit stats override over the bound transport", async () => {
		const queue = makeMemoryQueueTransport();
		const registry = makeQueueRegistry([
			{
				...queueDescriptorFor(queue, { id: "mem" }),
				stats: async () => ({ pending: 9, processing: 0, done: 0, failed: 0 }),
			},
		]);
		const [info] = await registry.list();
		expect(info?.depth?.pending).toBe(9);
		queue.close();
	});

	it("defaults consumer to external and collapses probe failures to null", async () => {
		const registry = makeQueueRegistry([
			{
				id: "a",
				name: "q-a",
				transport: "cloudflare-queue",
				stats: async () => {
					throw new Error("unreachable");
				},
			},
			{
				id: "b",
				name: "q-b",
				transport: "cloudflare-queue",
				stats: async () => null,
			},
		]);
		const queues = await registry.list();
		expect(queues[0]).toMatchObject({ consumer: "external", depth: null });
		expect(queues[1]).toMatchObject({ consumer: "external", depth: null });
	});

	it("resolves an empty registry to an empty list", async () => {
		expect(await makeQueueRegistry([]).list()).toEqual([]);
	});

	it("exposes the transport and consumer vocabularies", () => {
		expect(QueueTransportKinds).toContain("redis");
		expect(QueueConsumers).toContain("jobs-worker");
	});
});

describe("queueDescriptorFor", () => {
	it("falls back name → transport name → id and kind → unknown", () => {
		const named = makeMemoryQueueTransport({ name: "mem:named" });
		expect(queueDescriptorFor(named, { id: "x" })).toMatchObject({
			id: "x",
			name: "mem:named",
			transport: "unknown",
		});
		const bare = makeMemoryQueueTransport();
		expect(queueDescriptorFor(bare, { id: "x", name: "override", kind: "sqlite" })).toMatchObject({
			name: "override",
			transport: "sqlite",
		});
		named.close();
		bare.close();
	});
});

describe("asQueueTransport", () => {
	it("forwards send and picks up a bound stats probe", async () => {
		const sent: unknown[] = [];
		const transport = asQueueTransport({
			send: async (body) => {
				sent.push(body);
				return {};
			},
			stats: async () => ({ pending: 2, processing: 0, done: 0, failed: 0 }),
			name: "bound:q",
		});
		await transport.send({ n: 1 });
		expect(sent).toEqual([{ n: 1 }]);
		expect(transport.name).toBe("bound:q");
		await expect(transport.stats?.()).resolves.toEqual({
			pending: 2,
			processing: 0,
			done: 0,
			failed: 0,
		});
		// Push-delivered: no receive surface.
		expect(transport.receive).toBeUndefined();
	});

	it("meta.name wins over the binding name; bare bindings expose no stats", async () => {
		const transport = asQueueTransport({ send: async () => ({}) }, { name: "meta:name" });
		expect(transport.name).toBe("meta:name");
		expect(transport.stats).toBeUndefined();
	});

	it("omits name entirely when neither meta nor the binding supplies one", async () => {
		const transport = asQueueTransport({ send: async () => ({}) });
		expect(transport.name).toBeUndefined();
		expect(transport.stats).toBeUndefined();
	});
});

describe("makeMemoryQueueTransport", () => {
	it("settles acked entries and redelivers retried ones with attempts", async () => {
		const queue = makeMemoryQueueTransport();
		await queue.send("a");
		await queue.send("b");
		const [first] = await queue.receive!(1);
		expect(first?.body).toBe("a");
		expect(first?.attempts).toBe(1);
		first?.retry();
		const second = await queue.receive!(5);
		// "b" was still queued ahead of the retried "a"? No — retry()
		// requeues in place: entries keep FIFO order, "a" precedes "b".
		expect(second.map((m) => m.body)).toEqual(["a", "b"]);
		second[0]?.ack();
		second[1]?.ack();
		expect(await queue.stats?.()).toEqual({
			pending: 0,
			processing: 0,
			done: 0,
			failed: 0,
		});
		queue.close();
	});

	it("skips in-flight entries on receive and tolerates double-ack", async () => {
		const queue = makeMemoryQueueTransport();
		await queue.send("x");
		await queue.send("y");
		const [held] = await queue.receive!(1);
		expect(held?.body).toBe("x");
		// "x" is in-flight: the next receive skips it and delivers "y".
		const [next] = await queue.receive!(1);
		expect(next?.body).toBe("y");
		// Default count is 1 — nothing left queued once both settle.
		held?.ack();
		next?.ack();
		// A second ack finds no entry — a no-op, not a crash.
		held?.ack();
		expect(await queue.receive!()).toEqual([]);
		queue.close();
	});
});

queueTransportContract({
	name: "memory",
	make: () => makeMemoryQueueTransport(),
});

// A bare push-style binding (send only — the workerd Queue shape):
// no stats probe and no receive, so the stats case self-skips.
queueTransportContract({
	name: "bare-binding",
	pull: false,
	make: () => asQueueTransport({ send: async () => ({}) }),
});

// (No null-stats spec: the contract REQUIRES a non-null probe answer —
// a stats()→null transport fails the stats case by design.)
