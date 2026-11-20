// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const runCronJobFn = vi.fn<(_arg?: { data?: { id: string } }) => Promise<{ ok: true }>>(
	async () => ({
		ok: true as const,
	}),
);
const scheduleFns = vi.hoisted(() => ({
	createScheduleFn: vi.fn(async () => ({ ok: true as const, job: {} })),
	updateScheduleFn: vi.fn(async () => ({ ok: true as const, job: {} })),
	deleteScheduleFn: vi.fn(async () => ({ ok: true as const })),
	runScheduleFn: vi.fn(async () => ({ ok: true as const })),
	invalidate: vi.fn(),
}));
vi.mock("../fns.ts", () => ({
	runCronJobFn: (arg?: { data?: { id: string } }) => runCronJobFn(arg),
	createScheduleFn: scheduleFns.createScheduleFn,
	updateScheduleFn: scheduleFns.updateScheduleFn,
	deleteScheduleFn: scheduleFns.deleteScheduleFn,
	runScheduleFn: scheduleFns.runScheduleFn,
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: scheduleFns.invalidate }),
}));

import type { JobRecord } from "@ktb/jobs-port";
import type { CronJobInfo } from "@ktb/server-fns";

import { CronPage } from "./CronPage.tsx";

const job = (over: Partial<CronJobInfo> = {}): CronJobInfo => ({
	id: "agenda-reminders",
	schedules: ["*/5 * * * *", "17 3 * * *"],
	description: "Dispatch appointment reminders",
	lastRun: {
		id: "run-1",
		ok: true,
		running: false,
		error: null,
		startedAt: 1700000000000,
		finishedAt: 1700000001000,
	},
	...over,
});

const run = (over: Partial<JobRecord> = {}): JobRecord => ({
	id: "run-1",
	kind: "cron.agenda-reminders",
	status: "done",
	payloadRef: null,
	error: null,
	tenantId: null,
	createdAt: 1700000000000,
	updatedAt: 1700000001000,
	...over,
});

const openTab = (name: string) => {
	fireEvent.click(screen.getByRole("tab", { name }));
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("CronPage", () => {
	it("renders both sections with data", () => {
		render(<CronPage jobs={[job()]} runs={[run()]} locale="en" />);
		expect(screen.getByRole("heading", { name: "Cronjobs" })).toBeTruthy();
		expect(screen.getAllByText("Scheduled jobs").length).toBeGreaterThan(0);
		expect(screen.getByText("agenda-reminders")).toBeTruthy();
		expect(screen.getByText("*/5 * * * *")).toBeTruthy();
		expect(screen.getAllByText("OK").length).toBeGreaterThan(0);
		openTab("Run history");
		expect(screen.getAllByText("agenda-reminders").length).toBeGreaterThan(0);
	});

	it("renders unavailable states for null signals", () => {
		render(<CronPage jobs={null} runs={null} locale="en" />);
		expect(screen.getAllByText("Signal unavailable").length).toBeGreaterThan(0);
		openTab("Run history");
		expect(screen.getAllByText("Signal unavailable").length).toBeGreaterThan(0);
	});

	it("renders honest empty states", () => {
		render(<CronPage jobs={[]} runs={[]} locale="en" />);
		expect(screen.getByText(/No cron jobs registered/)).toBeTruthy();
		openTab("Run history");
		expect(screen.getByText(/No cron runs recorded/)).toBeTruthy();
	});

	it("renders never-run jobs without fabricating a last run", () => {
		render(<CronPage jobs={[job({ lastRun: null })]} runs={[]} locale="en" />);
		expect(screen.getByText("Never run")).toBeTruthy();
	});

	it("fires runNow and shows the outcome", async () => {
		runCronJobFn.mockResolvedValueOnce({ ok: true, summary: "3 reminders" } as never);
		render(<CronPage jobs={[job()]} runs={[]} locale="en" />);
		fireEvent.click(screen.getByRole("button", { name: "Run now" }));
		expect(runCronJobFn).toHaveBeenCalledWith({ data: { id: "agenda-reminders" } });
		expect(await screen.findByText(/3 reminders/)).toBeTruthy();
	});

	it("renders every last-run signal and missing timestamps honestly", () => {
		render(
			<CronPage
				jobs={[
					job({ id: "no-desc", description: undefined }),
					job({
						id: "running-job",
						lastRun: {
							id: "r1",
							ok: false,
							running: true,
							error: null,
							startedAt: 1700000000000,
							finishedAt: 0,
						},
					}),
					job({
						id: "failed-job",
						lastRun: {
							id: "r2",
							ok: false,
							running: false,
							error: "walk exploded",
							startedAt: 1700000000000,
							finishedAt: 0,
						},
					}),
					job({
						id: "untimed-job",
						lastRun: {
							id: "r3",
							ok: true,
							running: false,
							startedAt: null as unknown as number,
							finishedAt: 0,
						},
					}),
				]}
				runs={[
					run({ id: "run-err", kind: "cron.audit", error: "boom" }),
					run({ id: "run-untimed", kind: "other.kind", createdAt: undefined }),
				]}
				locale="en"
			/>,
		);
		expect(screen.getByText("Running")).toBeTruthy();
		expect(screen.getByText("Failed")).toBeTruthy();
		expect(screen.getByText("walk exploded")).toBeTruthy();
		// Missing description and the null startedAt render as dashes.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
		openTab("Run history");
		expect(screen.getByText("boom")).toBeTruthy();
		// A non-cron.* kind keeps its full kind string.
		expect(screen.getByText("other.kind")).toBeTruthy();
		// The undefined createdAt degrades to the dash marker.
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("surfaces every runNow outcome, including dispatch rejections", async () => {
		runCronJobFn
			.mockResolvedValueOnce({ ok: true, summary: "3 reminders" } as never)
			.mockResolvedValueOnce({ ok: true } as never)
			.mockResolvedValueOnce({ ok: false, reason: "unknown-job" } as never)
			.mockResolvedValueOnce({ ok: false, reason: "unavailable" } as never)
			.mockResolvedValueOnce({ ok: false, reason: "forbidden" } as never)
			.mockResolvedValueOnce({
				ok: false,
				reason: "run-failed",
				error: "walk failed",
			} as never)
			.mockResolvedValueOnce({ ok: false, reason: "run-failed" } as never)
			.mockRejectedValueOnce(new Error("wire exploded"));
		const ids = [
			"ok-summary",
			"ok-plain",
			"unknown",
			"unavailable",
			"forbidden",
			"failed-error",
			"failed-plain",
			"rejected",
		];
		render(<CronPage jobs={ids.map((id) => job({ id }))} runs={[]} locale="en" />);
		for (const btn of screen.getAllByRole("button", { name: "Run now" })) {
			fireEvent.click(btn);
		}
		expect(await screen.findByText(/3 reminders/)).toBeTruthy();
		expect(await screen.findByText("Run finished.")).toBeTruthy();
		expect(await screen.findByText("Unknown job id.")).toBeTruthy();
		expect(await screen.findByText("Cron runner unavailable in this environment.")).toBeTruthy();
		expect(await screen.findByText("Not permitted.")).toBeTruthy();
		expect(await screen.findByText("Run failed. walk failed")).toBeTruthy();
		// The error-less run-failed outcome and the rejected dispatch both
		// collapse to the bare failure copy.
		await waitFor(() => expect(screen.getAllByText("Run failed.")).toHaveLength(2));
	});
});
