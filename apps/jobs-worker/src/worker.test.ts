import { getEventListeners } from "node:events";

import { describe, expect, it, vi } from "vitest";

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

	it("does not leak abort listeners across idle polls", async () => {
		const ac = new AbortController();
		const transport: JobWorkerTransport = { receive: async () => [] };
		const p = runJobWorker({ transport, handlers: {}, signal: ac.signal, idleMs: 1 });
		await new Promise((r) => setTimeout(r, 30));
		// Only the in-flight sleep may hold a listener; sleeps that already
		// timed out must have detached theirs.
		expect(getEventListeners(ac.signal, "abort").length).toBeLessThanOrEqual(1);
		ac.abort();
		await p;
	});

	it("falls back to console.log when no logger is provided", async () => {
		const ac = new AbortController();
		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		let calls = 0;
		const transport: JobWorkerTransport = {
			receive: async () => {
				calls++;
				if (calls === 1) throw new Error("redis down");
				ac.abort();
				return [];
			},
		};
		await runJobWorker({
			transport,
			handlers: {},
			signal: ac.signal,
			errorBackoffMs: 1,
		});
		spy.mockRestore();
		expect(logs.some((l) => l.includes("transport error"))).toBe(true);
	});

	it("logs and survives consumer dispatch errors", async () => {
		const ac = new AbortController();
		const logs: string[] = [];
		let calls = 0;
		const transport: JobWorkerTransport = {
			receive: async () => {
				calls++;
				if (calls === 1) {
					// ack() throwing escapes makeJobConsumer's per-message
					// handling — the worker must log and keep looping.
					return [
						{
							body: { id: "1", kind: "jobs.ping", payload: {} },
							ack: () => {
								throw new Error("ack boom");
							},
							retry: () => {},
						},
					];
				}
				ac.abort();
				return [];
			},
		};
		await runJobWorker({
			transport,
			handlers: { "jobs.ping": { handle: async () => {} } },
			signal: ac.signal,
			idleMs: 1,
			log: (m) => void logs.push(m),
		});
		expect(logs.some((l) => l.includes("consumer error"))).toBe(true);
	});
});
