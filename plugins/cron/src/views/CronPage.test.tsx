// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const runCronJobFn = vi.fn<(_arg?: { data?: { id: string } }) => Promise<{ ok: true }>>(
	async () => ({
		ok: true as const,
	}),
);
const scheduleFns = vi.hoisted(() => ({
	createScheduleFn: vi.fn(async (): Promise<unknown> => ({ ok: true as const, job: {} })),
	updateScheduleFn: vi.fn(async (): Promise<unknown> => ({ ok: true as const, job: {} })),
	deleteScheduleFn: vi.fn(async (): Promise<unknown> => ({ ok: true as const })),
	runScheduleFn: vi.fn(async (): Promise<unknown> => ({ ok: true as const })),
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
import type { CronJobInfo, ScheduledJobInfo } from "@ktb/server-fns";

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

const sched = (over: Partial<ScheduledJobInfo> = {}): ScheduledJobInfo => ({
	id: "sched-1",
	kind: "agenda.reminders",
	params: null,
	cronExpr: "*/15 * * * *",
	runAt: null,
	nextRunAt: 1700000000000,
	lastRunAt: null,
	status: "active",
	tenantId: null,
	createdBy: null,
	createdAt: 1700000000000,
	updatedAt: 1700000000000,
	...over,
});

const renderSchedules = (
	schedules: readonly ScheduledJobInfo[] | null,
	kinds: readonly string[] | null = null,
) => {
	render(<CronPage jobs={[]} runs={[]} schedules={schedules} scheduleKinds={kinds} locale="en" />);
	openTab("Dynamic");
};

describe("CronPage dynamic schedules", () => {
	it("renders unavailable and empty states", () => {
		renderSchedules(null);
		expect(screen.getByText("Signal unavailable")).toBeTruthy();
		cleanup();
		renderSchedules([]);
		expect(screen.getByText(/No dynamic schedules/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Create schedule" })).toBeTruthy();
	});

	it("renders schedule rows with per-status actions", () => {
		renderSchedules([
			sched({ id: "active-1", cronExpr: "*/15 * * * *" }),
			sched({
				id: "paused-1",
				status: "paused",
				cronExpr: "0 * * * *",
				runAt: 1700003600000,
			}),
			sched({ id: "done-1", status: "done", cronExpr: "30 * * * *", lastRunAt: 1700000001000 }),
			// One-off rows carry no cronExpr — the runAt timestamp renders instead.
			sched({
				id: "once-1",
				status: "done",
				cronExpr: null,
				runAt: 1700003600000,
				lastRunAt: 1700000001000,
			}),
		]);
		// cronExpr renders as code, runAt as a formatted timestamp.
		expect(screen.getByText("*/15 * * * *")).toBeTruthy();
		expect(screen.getByText("0 * * * *")).toBeTruthy();
		expect(screen.getAllByText("Active")).toHaveLength(1);
		expect(screen.getByText("Paused")).toBeTruthy();
		expect(screen.getAllByText("Done")).toHaveLength(2);
		expect(screen.getAllByText("Never run")).toHaveLength(2);
		// Active row: Run now + Pause + Delete; paused row: Resume + Delete;
		// done rows: Delete only.
		expect(screen.getAllByRole("button", { name: "Run now" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(4);
	});

	it("creates a recurring schedule and reports success", async () => {
		scheduleFns.createScheduleFn.mockResolvedValueOnce({ ok: true as const, job: sched() });
		renderSchedules([], ["agenda.reminders"]);
		fireEvent.change(screen.getByLabelText("Job kind"), { target: { value: "agenda.reminders" } });
		fireEvent.change(screen.getByLabelText(/Cron expression/), {
			target: { value: "*/15 * * * *" },
		});
		fireEvent.change(screen.getByLabelText(/Params/), { target: { value: '{"n":1}' } });
		fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
		expect(scheduleFns.createScheduleFn).toHaveBeenCalledWith({
			data: {
				kind: "agenda.reminders",
				params: { n: 1 },
				cronExpr: "*/15 * * * *",
				runAt: null,
			},
		});
		expect(await screen.findByText("Schedule created.")).toBeTruthy();
		expect(scheduleFns.invalidate).toHaveBeenCalled();
	});

	it("rejects malformed params JSON before calling the server fn", async () => {
		renderSchedules([]);
		fireEvent.change(screen.getByLabelText("Job kind"), { target: { value: "agenda.reminders" } });
		fireEvent.change(screen.getByLabelText(/Params/), { target: { value: "{bad" } });
		fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
		expect(await screen.findByText(/Invalid schedule/)).toBeTruthy();
		expect(scheduleFns.createScheduleFn).not.toHaveBeenCalled();
	});

	it("maps create outcomes: invalid, unavailable and rejection", async () => {
		scheduleFns.createScheduleFn
			.mockResolvedValueOnce({ ok: false as const, reason: "invalid" as const })
			.mockResolvedValueOnce({ ok: false as const, reason: "unavailable" as const })
			.mockRejectedValueOnce(new Error("wire down"));
		renderSchedules([]);
		const kind = screen.getByLabelText("Job kind");
		const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));

		fireEvent.change(kind, { target: { value: "agenda.reminders" } });
		submit();
		expect(await screen.findByText(/Invalid schedule/)).toBeTruthy();

		submit();
		expect(await screen.findByText("Schedule operation failed.")).toBeTruthy();

		submit();
		await waitFor(() => expect(scheduleFns.createScheduleFn).toHaveBeenCalledTimes(3));
		expect(screen.getAllByText("Schedule operation failed.")).toHaveLength(1);
	});

	it("creates a one-off schedule with a runAt timestamp", async () => {
		const user = userEvent.setup();
		scheduleFns.createScheduleFn.mockResolvedValue({ ok: true as const, job: sched() });
		renderSchedules([]);
		// The kind input's datalist also exposes combobox role — pick the
		// mode Select trigger by its data-slot.
		const modeSelect = screen
			.getAllByRole("combobox")
			.find((el) => el.getAttribute("data-slot") === "select-trigger");
		expect(modeSelect).toBeTruthy();
		await user.click(modeSelect!);
		await user.click(await screen.findByRole("option", { name: "One-off (date & time)" }));
		fireEvent.change(screen.getByLabelText("Job kind"), { target: { value: "agenda.reminders" } });
		// Empty runAt submits null.
		fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
		expect(scheduleFns.createScheduleFn).toHaveBeenLastCalledWith({
			data: { kind: "agenda.reminders", cronExpr: null, runAt: null },
		});
		await screen.findByText("Schedule created.");
		// A successful create resets the form (kind included) — refill it.
		fireEvent.change(screen.getByLabelText("Job kind"), { target: { value: "agenda.reminders" } });
		// Filled runAt submits epoch ms.
		fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-01-02T03:04" } });
		fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
		expect(scheduleFns.createScheduleFn).toHaveBeenLastCalledWith({
			data: {
				kind: "agenda.reminders",
				cronExpr: null,
				runAt: new Date("2026-01-02T03:04").getTime(),
			},
		});
		// Switching back to recurring mode covers the other select arm.
		await user.click(modeSelect!);
		await user.click(await screen.findByRole("option", { name: "Recurring (cron)" }));
	});

	it("pause, resume and delete round-trip through the schedule fns", async () => {
		scheduleFns.updateScheduleFn.mockResolvedValue({ ok: true as const, job: sched() });
		scheduleFns.deleteScheduleFn.mockResolvedValue({ ok: true as const });
		renderSchedules([sched({ id: "s-pause" }), sched({ id: "s-resume", status: "paused" })]);

		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		expect(scheduleFns.updateScheduleFn).toHaveBeenCalledWith({
			data: { id: "s-pause", patch: { status: "paused" } },
		});
		expect(await screen.findByText("Schedule updated.")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Resume" }));
		expect(scheduleFns.updateScheduleFn).toHaveBeenCalledWith({
			data: { id: "s-resume", patch: { status: "active" } },
		});
		// rowBusy stays set until the fn resolves — wait for it to clear
		// before the next row action or the button is disabled.
		await waitFor(() =>
			expect(screen.getAllByRole("button", { name: "Delete" })[0]!.hasAttribute("disabled")).toBe(
				false,
			),
		);

		fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
		expect(scheduleFns.deleteScheduleFn).toHaveBeenCalledWith({ data: { id: "s-pause" } });
		expect(await screen.findByText("Schedule deleted.")).toBeTruthy();
		expect(scheduleFns.invalidate).toHaveBeenCalled();
	});

	it("run-now reports the schedule outcome", async () => {
		scheduleFns.runScheduleFn.mockResolvedValueOnce({
			ok: true as const,
			summary: "fired agenda.reminders",
		});
		renderSchedules([sched({ id: "s-run" })]);
		fireEvent.click(screen.getByRole("button", { name: "Run now" }));
		expect(scheduleFns.runScheduleFn).toHaveBeenCalledWith({ data: { id: "s-run" } });
		expect(await screen.findByText(/Run finished — fired agenda\.reminders/)).toBeTruthy();
	});

	it("surfaces schedule action failures honestly", async () => {
		scheduleFns.updateScheduleFn
			.mockResolvedValueOnce({ ok: false as const, reason: "invalid" as const })
			.mockResolvedValueOnce({ ok: false as const, reason: "not-found" as const })
			.mockRejectedValueOnce(new Error("boom"));
		scheduleFns.deleteScheduleFn.mockResolvedValueOnce({
			ok: false as const,
			reason: "not-found" as const,
		});
		scheduleFns.runScheduleFn
			.mockResolvedValueOnce({ ok: false as const, reason: "run-failed" as const, error: "kaput" })
			.mockRejectedValueOnce(new Error("wire down"));
		renderSchedules([
			sched({ id: "s-upd" }),
			sched({ id: "s-del", status: "paused" }),
			sched({ id: "s-run1" }),
			sched({ id: "s-run2" }),
		]);

		fireEvent.click(screen.getAllByRole("button", { name: "Pause" })[0]!);
		expect(await screen.findByText(/Invalid schedule/)).toBeTruthy();
		// A non-invalid failure reason maps to the generic failure copy.
		fireEvent.click(screen.getAllByRole("button", { name: "Pause" })[0]!);
		expect(await screen.findAllByText("Schedule operation failed.")).not.toHaveLength(0);
		fireEvent.click(screen.getAllByRole("button", { name: "Pause" })[0]!);
		expect(await screen.findAllByText("Schedule operation failed.")).not.toHaveLength(0);

		fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]!);
		expect(await screen.findAllByText("Schedule operation failed.")).not.toHaveLength(0);

		const runButtons = screen.getAllByRole("button", { name: "Run now" });
		fireEvent.click(runButtons[0]!);
		expect(await screen.findByText("Run failed. kaput")).toBeTruthy();
		fireEvent.click(runButtons[1]!);
		expect(await screen.findAllByText("Schedule operation failed.")).not.toHaveLength(0);
	});
});
