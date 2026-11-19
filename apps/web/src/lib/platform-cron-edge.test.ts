import { describe, expect, it, vi } from "vitest";

// Cron-runner edge paths: the fire routines behind APP_CRON_JOBS are
// stubbed so each outcome shape (null, counts, throws, tampered) is
// directly controllable, and the job_runs projection port can be made
// to fail on demand. APP_CRON_JOBS gains a "ghost-job" descriptor with
// no runner to cover the no-runner fallback.

const hoisted = vi.hoisted(() => ({
	agenda: (): Promise<number | null> => Promise.resolve(0),
	audit: (): Promise<unknown> =>
		Promise.resolve({ status: "verified", entries: 3, brokenAt: null }),
	upsertFails: false,
	listFails: false,
}));

vi.mock("./agenda-reminders.ts", () => ({
	runScheduledAgendaReminders: () => hoisted.agenda(),
}));

vi.mock("./audit-chain.ts", () => ({
	runScheduledAuditVerification: () => hoisted.audit(),
}));

vi.mock("./cron-jobs.ts", () => ({
	APP_CRON_JOBS: [
		{
			id: "agenda-reminders",
			schedules: ["*/5 * * * *", "17 3 * * *"],
			description: "agenda reminder sweep",
		},
		{
			id: "audit-chain-verify",
			schedules: ["17 3 * * *"],
			description: "audit chain verification",
		},
		{
			id: "ghost-job",
			schedules: ["0 0 * * *"],
			description: "descriptor without a registered runner",
		},
	],
}));

vi.mock("@ktb/jobs-port", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/jobs-port")>();
	return {
		...actual,
		upsertJobRun: async (...args: Parameters<typeof actual.upsertJobRun>) => {
			if (hoisted.upsertFails) throw new Error("job_runs write down");
			return actual.upsertJobRun(...args);
		},
		listJobRuns: async (...args: Parameters<typeof actual.listJobRuns>) => {
			if (hoisted.listFails) throw new Error("job_runs read down");
			return actual.listJobRuns(...args);
		},
	};
});

const compose = async (configure: (env: Record<string, unknown>) => void = () => {}) => {
	vi.resetModules();
	const { env } = await import("#/test/cloudflare-workers.ts");
	configure(env as Record<string, unknown>);
	const platform = await import("./platform.ts");
	const { getServerRuntime } = await import("@ktb/server-fns");
	return { runtime: getServerRuntime(), platform };
};

describe("platform cron runner outcomes", () => {
	it(
		"audit-chain-verify summarizes verified, tampered and failed passes",
		{ timeout: 30_000 },
		async () => {
			const { runtime } = await compose();
			hoisted.audit = async () => ({ status: "verified", entries: 7, brokenAt: null });
			expect(await runtime.crons!.runNow("audit-chain-verify")).toMatchObject({
				id: "audit-chain-verify",
				ok: true,
				summary: "chain verified (7 entries)",
			});
			hoisted.audit = async () => ({ status: "tampered", entries: 11, brokenAt: 9 });
			expect(await runtime.crons!.runNow("audit-chain-verify")).toMatchObject({
				ok: true,
				summary: "chain tampered at entry 9",
			});
			hoisted.audit = async () => null;
			expect(await runtime.crons!.runNow("audit-chain-verify")).toMatchObject({
				ok: false,
				error: "audit chain verification failed",
			});
		},
	);

	it(
		"agenda-reminders maps null, singular and plural sweep counts",
		{ timeout: 30_000 },
		async () => {
			const { runtime } = await compose();
			hoisted.agenda = async () => null;
			expect(await runtime.crons!.runNow("agenda-reminders")).toMatchObject({
				ok: false,
				error: "reminder sweep failed",
			});
			hoisted.agenda = async () => 1;
			expect(await runtime.crons!.runNow("agenda-reminders")).toMatchObject({
				ok: true,
				summary: "1 reminder dispatched",
			});
			hoisted.agenda = async () => 3;
			expect(await runtime.crons!.runNow("agenda-reminders")).toMatchObject({
				ok: true,
				summary: "3 reminders dispatched",
			});
		},
	);

	it("projects a throwing fire as a failed run, Error or not", { timeout: 30_000 }, async () => {
		const { runtime } = await compose();
		hoisted.agenda = async () => {
			throw new Error("sweep exploded");
		};
		expect(await runtime.crons!.runNow("agenda-reminders")).toMatchObject({
			ok: false,
			error: "sweep exploded",
		});
		// Non-Error rejections stringify for the job_runs error field.
		hoisted.agenda = () => Promise.reject("plain failure");
		expect(await runtime.crons!.runNow("agenda-reminders")).toMatchObject({
			ok: false,
			error: "plain failure",
		});
	});

	it("reports a descriptor without a registered runner honestly", { timeout: 30_000 }, async () => {
		const { runtime, platform } = await compose();
		expect(await runtime.crons!.runNow("ghost-job")).toMatchObject({
			id: "ghost-job",
			ok: false,
			error: "no runner registered",
		});
		// The worker's scheduled() entry point dispatches through the
		// same projected registry path as runNow.
		const results = await platform.runScheduledCron("0 0 * * *");
		expect(results.map((r) => r.id)).toEqual(["ghost-job"]);
		expect(results[0]?.outcome).toMatchObject({
			ok: false,
			error: "no runner registered",
		});
	});
});

describe("platform cron projection degradation", () => {
	it(
		"logs and swallows job_runs write failures without failing the fire",
		{ timeout: 30_000 },
		async () => {
			const { runtime } = await compose();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			hoisted.upsertFails = true;
			try {
				hoisted.agenda = async () => 0;
				const result = await runtime.crons!.runNow("agenda-reminders");
				expect(result?.ok).toBe(true);
				expect(errorSpy).toHaveBeenCalledWith("cron projection write failed", {
					kind: "cron.agenda-reminders",
					status: "processing",
					error: expect.stringContaining("job_runs write down"),
				});
			} finally {
				hoisted.upsertFails = false;
				errorSpy.mockRestore();
			}
		},
	);

	it(
		"degrades crons.list lastRun to null when the projection read fails",
		{ timeout: 30_000 },
		async () => {
			const { runtime } = await compose();
			hoisted.listFails = true;
			try {
				const jobs = await runtime.crons!.list();
				expect(jobs).toHaveLength(3);
				expect(jobs.every((j) => j.lastRun === null)).toBe(true);
			} finally {
				hoisted.listFails = false;
			}
		},
	);
});

describe("platform jobs.ping registration", () => {
	it("registers the console smoke kind as a no-op handler", { timeout: 30_000 }, async () => {
		await compose();
		const { jobHandlers } = await import("@ktb/jobs-port");
		await expect(jobHandlers["jobs.ping"]!.handle({}, {} as never)).resolves.toBeUndefined();
	});
});
