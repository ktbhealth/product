// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const runCronJobFn = vi.fn<(_arg?: { data?: { id: string } }) => Promise<{ ok: true }>>(
	async () => ({
		ok: true as const,
	}),
);
vi.mock("../fns.ts", () => ({
	runCronJobFn: (arg?: { data?: { id: string } }) => runCronJobFn(arg),
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
});
