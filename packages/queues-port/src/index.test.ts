import { describe, expect, it } from "vitest";

import { makeQueueRegistry, QueueConsumers, QueueTransports } from "./index.ts";

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
		expect(QueueTransports).toContain("redis");
		expect(QueueConsumers).toContain("jobs-worker");
	});
});
