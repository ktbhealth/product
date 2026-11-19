import { describe, expect, it, vi } from "vitest";

import { getJobRun, listJobRuns, type JobEnvelope } from "@ktb/jobs-port";

// platform.ts publishes the generic jobs enqueuer (PL-007) on the server
// runtime when AUDIO_QUEUE is bound — same recompose pattern as
// platform-ops-probes.test.ts.

const compose = async (configure: (env: Record<string, unknown>) => void) => {
	vi.resetModules();
	const { env } = await import("#/test/cloudflare-workers.ts");
	configure(env as Record<string, unknown>);
	const platform = await import("./platform.ts");
	const { getServerRuntime } = await import("@ktb/server-fns");
	return { runtime: getServerRuntime(), platform };
};

describe("platform jobs enqueuer", () => {
	it(
		"enqueues envelopes through the bound queue and writes job_runs",
		{ timeout: 30_000 }, // first compose pays the full app import cost
		async () => {
			const sent: JobEnvelope[] = [];
			const { runtime, platform } = await compose((env) => {
				env.AUDIO_QUEUE = {
					send: async (body: unknown) => {
						sent.push(body as JobEnvelope);
					},
				};
			});

			expect(runtime.jobs).toBeDefined();
			const envelope = (await runtime.jobs!.enqueue(
				"test.kind",
				{ v: 1 },
				{
					tenantId: 3,
					payloadRef: "ref-1",
				},
			)) as JobEnvelope;
			expect(envelope).toMatchObject({
				kind: "test.kind",
				payload: { v: 1 },
				tenantId: 3,
			});
			expect(typeof envelope.id).toBe("string");
			expect(sent).toEqual([envelope]);

			// The job_runs projection row was written by the port adapter.
			expect(await getJobRun(platform.db, envelope.id)).toMatchObject({
				kind: "test.kind",
				status: "queued",
				payloadRef: "ref-1",
				tenantId: 3,
			});
		},
	);

	it("leaves jobs undefined when the queue binding is absent", async () => {
		const { runtime } = await compose((env) => {
			env.AUDIO_QUEUE = undefined;
		});
		expect(runtime.jobs).toBeUndefined();
	});
});

describe("platform theme-jobs enqueuer (PL-006 phase 4)", () => {
	it(
		"enqueues theme envelopes through the dedicated queue binding",
		{ timeout: 30_000 },
		async () => {
			const sent: JobEnvelope[] = [];
			const audioSent: unknown[] = [];
			const { runtime } = await compose((env) => {
				env.AUDIO_QUEUE = { send: async (b: unknown) => void audioSent.push(b) };
				env.THEME_ASSETS_QUEUE = {
					send: async (body: unknown) => {
						sent.push(body as JobEnvelope);
					},
				};
			});

			expect(runtime.themeJobs).toBeDefined();
			const envelope = (await runtime.themeJobs!.enqueue(
				"theme.asset",
				{ assetId: 1 },
				{ payloadRef: "theme-asset:1" },
			)) as JobEnvelope;
			expect(envelope).toMatchObject({ kind: "theme.asset", payload: { assetId: 1 } });
			expect(sent).toEqual([envelope]);
			// The dedicated queue is the ONLY transport — audio queue untouched.
			expect(audioSent).toEqual([]);
		},
	);

	it("leaves themeJobs undefined when THEME_ASSETS_QUEUE is absent", async () => {
		const { runtime } = await compose((env) => {
			env.THEME_ASSETS_QUEUE = undefined;
		});
		expect(runtime.themeJobs).toBeUndefined();
	});
});

describe("platform queue registry (/platform/queue)", () => {
	it("lists bound queues with honest depth per transport", { timeout: 30_000 }, async () => {
		const { runtime } = await compose((env) => {
			env.AUDIO_QUEUE = {
				send: async () => ({}),
				stats: async () => ({ pending: 2, processing: 1, done: 40, failed: 3 }),
			};
			env.THEME_ASSETS_QUEUE = { send: async () => ({}) };
			env.REDIS_JOBS_QUEUE = {
				stats: async () => ({ pending: 5, processing: 0, done: 0, failed: 1 }),
			};
			env.JOBS_QUEUE = "ktb:jobs-test";
		});

		const queues = await runtime.queues!();
		const byId = new Map(queues.map((q) => [q.id, q]));
		// stats-bearing dev binding -> sqlite transport with real depth
		expect(byId.get("audio")).toMatchObject({
			transport: "sqlite",
			consumer: "in-app",
			depth: { pending: 2, processing: 1, done: 40, failed: 3 },
		});
		// stats-less binding -> cloudflare-queue with null depth
		expect(byId.get("theme-assets")).toMatchObject({
			transport: "cloudflare-queue",
			depth: null,
		});
		// dev:node Redis probe -> redis/jobs-worker
		expect(byId.get("jobs")).toMatchObject({
			name: "ktb:jobs-test",
			transport: "redis",
			consumer: "jobs-worker",
			depth: { pending: 5 },
		});
	});

	it(
		"collapses a failing depth probe to null instead of rejecting",
		{ timeout: 30_000 },
		async () => {
			const { runtime } = await compose((env) => {
				env.AUDIO_QUEUE = {
					send: async () => ({}),
					stats: async () => {
						throw new Error("db gone");
					},
				};
			});
			const queues = await runtime.queues!();
			expect(queues.find((q) => q.id === "audio")?.depth).toBeNull();
		},
	);
});

describe("platform cron registry (/platform/cron)", () => {
	it(
		"lists registered jobs with schedules and null lastRun before any fire",
		{ timeout: 30_000 },
		async () => {
			const { runtime } = await compose(() => {});
			const jobs = await runtime.crons!.list();
			const byId = new Map(jobs.map((j) => [j.id, j]));
			expect(byId.get("agenda-reminders")?.schedules).toContain("*/5 * * * *");
			expect(byId.get("agenda-reminders")?.schedules).toContain("17 3 * * *");
			expect(byId.get("audit-chain-verify")?.schedules).toEqual(["17 3 * * *"]);
			expect(byId.get("agenda-reminders")?.lastRun).toBeNull();
		},
	);

	it(
		"runNow fires a job through the projected path and records job_runs",
		{ timeout: 30_000 },
		async () => {
			const { runtime, platform } = await compose(() => {});
			expect(await runtime.crons!.runNow("missing-job")).toBeNull();
			const result = await runtime.crons!.runNow("agenda-reminders");
			expect(result?.id).toBe("agenda-reminders");
			expect(result?.ok).toBe(true);

			// The fire was projected into job_runs under kind cron.<id>.
			const runs = await listJobRuns(platform.db, { kind: "cron.agenda-reminders" });
			expect(runs.length).toBeGreaterThan(0);
			expect(runs[0]?.status).toBe("done");

			// And the registry now reports the recorded last run.
			const jobs = await runtime.crons!.list();
			expect(jobs.find((j) => j.id === "agenda-reminders")?.lastRun?.ok).toBe(true);
		},
	);

	it("dispatches unknown cron expressions as a no-op", { timeout: 30_000 }, async () => {
		const { runtime } = await compose(() => {});
		expect(await runtime.crons!.runSchedule("0 0 1 1 *")).toEqual([]);
	});

	it("runSchedule fires every job bound to the expression", { timeout: 30_000 }, async () => {
		const { runtime } = await compose(() => {});
		const results = await runtime.crons!.runSchedule("*/5 * * * *");
		// Only agenda-reminders binds the 5-minute expression.
		expect(results.map((r) => r.id)).toEqual(["agenda-reminders"]);
		expect(results[0]?.ok).toBe(true);
	});
});
