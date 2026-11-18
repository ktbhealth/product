import { describe, expect, it } from "vitest";

import type { JobMessageLike } from "@ktb/jobs-port";

import { runJobWorker, type JobWorkerTransport } from "./worker.ts";

const msg = (body: unknown): JobMessageLike => ({
	body,
	ack: () => {},
	retry: () => {},
});

const transportOf = (batches: readonly (readonly JobMessageLike[])[]): JobWorkerTransport => {
	let i = 0;
	return {
		receive: async () => batches[i++] ?? [],
	};
};

describe("runJobWorker", () => {
	it("dispatches batches through the kind registry until aborted", async () => {
		const handled: unknown[] = [];
		const ac = new AbortController();
		const transport = transportOf([
			[msg({ id: "1", kind: "jobs.ping", payload: {} })],
			[],
			[msg({ id: "2", kind: "jobs.ping", payload: {} })],
		]);
		const p = runJobWorker({
			transport,
			handlers: { "jobs.ping": { handle: async (payload) => void handled.push(payload) } },
			signal: ac.signal,
			idleMs: 1,
		});
		// Let the loop drain the scripted batches, then stop it.
		await new Promise((r) => setTimeout(r, 50));
		ac.abort();
		await p;
		expect(handled).toHaveLength(2);
	});

	it("backs off and survives transport errors", async () => {
		const ac = new AbortController();
		let calls = 0;
		const logs: string[] = [];
		const transport: JobWorkerTransport = {
			receive: async () => {
				calls++;
				if (calls < 3) throw new Error("redis down");
				ac.abort();
				return [];
			},
		};
		await runJobWorker({
			transport,
			handlers: {},
			signal: ac.signal,
			errorBackoffMs: 1,
			log: (m) => void logs.push(m),
		});
		expect(calls).toBe(3);
		expect(logs.some((l) => l.includes("transport error"))).toBe(true);
	});

	it("empty polls loop without dispatching", async () => {
		const ac = new AbortController();
		let calls = 0;
		const transport: JobWorkerTransport = {
			receive: async () => {
				calls++;
				if (calls >= 3) ac.abort();
				return [];
			},
		};
		await runJobWorker({ transport, handlers: {}, signal: ac.signal, idleMs: 1 });
		expect(calls).toBe(3);
	});
});
