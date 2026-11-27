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
import type { ScheduleEntryInfo, SchedulableKindInfo } from "@ktb/server-fns";

import { CronPage } from "./CronPage.tsx";

const entry = (over: Partial<ScheduleEntryInfo> = {}): ScheduleEntryInfo => ({
	id: "cron:agenda-reminders",
	refId: "agenda-reminders",
	source: "cron",
	name: "agenda-reminders",
	description: "Dispatch appointment reminders",
	kind: null,
	params: null,
	cronExprs: ["*/5 * * * *", "17 3 * * *"],
	runAt: null,
	nextRunAt: 1700000300000,
	lastRunAt: 1700000000000,
	lastRun: {
		ok: true,
		running: false,
		error: null,
		at: 1700000000000,
	},
	status: "active",
	mutable: false,
	tenantId: null,
	createdBy: null,
	createdAt: null,
	updatedAt: null,
	...over,
});

const schedEntry = (over: Partial<ScheduleEntryInfo> = {}): ScheduleEntryInfo => {
	const merged = entry({
		id: "sched-1",
		refId: "sched-1",
		source: "scheduled-job",
		name: "agenda.reminders",
		description: null,
		kind: "agenda.reminders",
		params: null,
		cronExprs: ["*/15 * * * *"],
		nextRunAt: 1700000000000,
		lastRunAt: null,
		lastRun: null,
		mutable: true,
		createdBy: null,
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...over,
	});
	// refId tracks the row id unless explicitly overridden.
	return { ...merged, refId: over.refId ?? over.id ?? merged.refId };
};

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
	it("renders the unified schedules table and run history", () => {
		render(<CronPage entries={[entry()]} runs={[run()]} locale="en" />);
		expect(screen.getByRole("heading", { name: "Cronjobs" })).toBeTruthy();
		expect(screen.getByText("agenda-reminders")).toBeTruthy();
		expect(screen.getByText("*/5 * * * *")).toBeTruthy();
		expect(screen.getByText("Deployed")).toBeTruthy();
		expect(screen.getAllByText("OK").length).toBeGreaterThan(0);
		openTab("Run history");
		expect(screen.getAllByText("agenda-reminders").length).toBeGreaterThan(0);
	});

	it("renders unavailable states for null signals", () => {
		render(<CronPage entries={null} runs={null} locale="en" />);
		expect(screen.getAllByText("Signal unavailable").length).toBeGreaterThan(0);
		openTab("Run history");
		expect(screen.getAllByText("Signal unavailable").length).toBeGreaterThan(0);
	});

	it("renders honest empty states", () => {
		render(<CronPage entries={[]} runs={[]} locale="en" />);
		expect(screen.getByText(/No schedules/)).toBeTruthy();
		openTab("Run history");
		expect(screen.getByText(/No cron runs recorded/)).toBeTruthy();
	});

	it("renders never-run entries without fabricating a last run", () => {
		render(
			<CronPage
				entries={[entry({ lastRunAt: null, lastRun: null }), schedEntry()]}
				runs={[]}
				locale="en"
			/>,
		);
		expect(screen.getAllByText("Never run").length).toBe(2);
	});

	it("fires runNow on a cron entry through the registry path", async () => {
		runCronJobFn.mockResolvedValueOnce({ ok: true, summary: "3 reminders" } as never);
		render(<CronPage entries={[entry()]} runs={[]} locale="en" />);
		fireEvent.click(screen.getByRole("button", { name: "Run now" }));
		expect(runCronJobFn).toHaveBeenCalledWith({ data: { id: "agenda-reminders" } });
		expect(scheduleFns.runScheduleFn).not.toHaveBeenCalled();
		expect(await screen.findByText(/3 reminders/)).toBeTruthy();
	});

	it("fires runNow on a scheduled-job entry through the schedule path", async () => {
		scheduleFns.runScheduleFn.mockResolvedValueOnce({
			ok: true as const,
			summary: "fired agenda.reminders",
		});
		render(<CronPage entries={[schedEntry()]} runs={[]} locale="en" />);
		fireEvent.click(screen.getByRole("button", { name: "Run now" }));
		expect(scheduleFns.runScheduleFn).toHaveBeenCalledWith({ data: { id: "sched-1" } });
		expect(runCronJobFn).not.toHaveBeenCalled();
		expect(await screen.findByText(/Run finished — fired agenda\.reminders/)).toBeTruthy();
	});

	it("renders every last-run signal and missing timestamps honestly", () => {
		render(
			<CronPage
				entries={[
					entry({ id: "cron:no-desc", name: "no-desc", description: null }),
					entry({
						id: "cron:running-job",
						refId: "running-job",
						name: "running-job",
						lastRun: { ok: false, running: true, error: null, at: 1700000000000 },
					}),
					entry({
						id: "cron:failed-job",
						refId: "failed-job",
						name: "failed-job",
						lastRun: { ok: false, running: false, error: "walk exploded", at: 1700000000000 },
					}),
					entry({
						id: "cron:untimed",
						refId: "untimed",
						name: "untimed",
						lastRunAt: null,
						lastRun: null,
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
		// Missing description renders as a dash.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
		openTab("Run history");
		expect(screen.getByText("boom")).toBeTruthy();
		// A non-cron.* kind keeps its full kind string.
		expect(screen.getByText("other.kind")).toBeTruthy();
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
		render(
			<CronPage
				entries={ids.map((id) => entry({ id: `cron:${id}`, refId: id, name: id }))}
				runs={[]}
				locale="en"
			/>,
		);
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

describe("CronPage unified schedules", () => {
	const renderEntries = (
		entries: readonly ScheduleEntryInfo[] | null,
		kinds: readonly string[] | null = null,
		schedulable: readonly SchedulableKindInfo[] | null = null,
	) => {
		render(
			<CronPage
				entries={entries}
				runs={[]}
				scheduleKinds={kinds}
				schedulableKinds={schedulable}
				locale="en"
			/>,
		);
	};

	it("renders unavailable and empty states", () => {
		renderEntries(null);
		expect(screen.getByText("Signal unavailable")).toBeTruthy();
		cleanup();
		renderEntries([]);
		expect(screen.getByText(/No schedules/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Create schedule" })).toBeTruthy();
	});

	it("renders rows from both sources with per-status actions", () => {
		renderEntries([
			entry({ id: "cron:reg-1", refId: "reg-1", name: "reg-1" }),
			schedEntry({ id: "s-active", refId: "s-active", name: "kind.active" }),
			schedEntry({
				id: "s-paused",
				refId: "s-paused",
				name: "kind.paused",
				status: "paused",
				cronExprs: ["0 * * * *"],
				runAt: 1700003600000,
			}),
			schedEntry({
				id: "s-done",
				refId: "s-done",
				name: "kind.done",
				status: "done",
				cronExprs: ["30 * * * *"],
				lastRunAt: 1700000001000,
			}),
			// One-off rows carry no cronExpr — the runAt timestamp renders instead.
			schedEntry({
				id: "s-once",
				refId: "s-once",
				name: "kind.once",
				status: "done",
				cronExprs: [],
				runAt: 1700003600000,
				lastRunAt: 1700000001000,
			}),
		]);
		expect(screen.getByText("reg-1")).toBeTruthy();
		expect(screen.getByText("kind.active")).toBeTruthy();
		expect(screen.getByText("*/5 * * * *")).toBeTruthy();
		expect(screen.getByText("0 * * * *")).toBeTruthy();
		expect(screen.getAllByText("Runtime").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Active")).toHaveLength(2);
		expect(screen.getByText("Paused")).toBeTruthy();
		expect(screen.getAllByText("Done")).toHaveLength(2);
		// The cron entry has a joined lastRun; the two active scheduled
		// rows never ran.
		expect(screen.getAllByText("Never run")).toHaveLength(2);
		// Run now: the cron entry + the active scheduled row; Pause only on
		// mutable active rows; Resume on the paused row; Delete on the four
		// mutable rows (cron is immutable).
		expect(screen.getAllByRole("button", { name: "Run now" })).toHaveLength(2);
		expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(4);
	});

	it("creates a recurring schedule and reports success", async () => {
		scheduleFns.createScheduleFn.mockResolvedValueOnce({ ok: true as const, job: {} });
		renderEntries([], ["agenda.reminders"]);
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
		renderEntries([]);
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
		renderEntries([]);
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
		scheduleFns.createScheduleFn.mockResolvedValue({ ok: true as const, job: {} });
		renderEntries([]);
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
		scheduleFns.updateScheduleFn.mockResolvedValue({ ok: true as const, job: {} });
		scheduleFns.deleteScheduleFn.mockResolvedValue({ ok: true as const });
		renderEntries([
			schedEntry({ id: "s-pause" }),
			schedEntry({ id: "s-resume", status: "paused" }),
		]);

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
		renderEntries([
			schedEntry({ id: "s-upd" }),
			schedEntry({ id: "s-del", status: "paused" }),
			schedEntry({ id: "s-run1" }),
			schedEntry({ id: "s-run2" }),
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

		// Run now renders on active rows only (s-del is paused).
		const runButtons = screen.getAllByRole("button", { name: "Run now" });
		expect(runButtons).toHaveLength(3);
		fireEvent.click(runButtons[0]!);
		expect(await screen.findByText("Run failed. kaput")).toBeTruthy();
		fireEvent.click(runButtons[1]!);
		expect(await screen.findAllByText("Schedule operation failed.")).not.toHaveLength(0);
	});

	it("prefills cron expression and params from jobs.schedulable declarations", () => {
		const decl = (over: Partial<SchedulableKindInfo> & { kind: string }): SchedulableKindInfo => ({
			id: over.kind,
			...over,
		});
		renderEntries(
			[],
			["plain.job"],
			[
				decl({
					id: "d1",
					kind: "full.kind",
					description: "Full preset",
					suggestedCronExpr: "*/5 * * * *",
					suggestedParams: { n: 1 },
				}),
				// Duplicate kind — the first declaration wins the suggestions.
				decl({
					id: "d2",
					kind: "full.kind",
					suggestedCronExpr: "0 0 * * *",
					suggestedParams: { n: 2 },
				}),
				decl({ id: "d3", kind: "cron-only.kind", suggestedCronExpr: "1 * * * *" }),
				decl({ id: "d4", kind: "params-null.kind", suggestedParams: null }),
				decl({ id: "d5", kind: "bare.kind" }),
				decl({ id: "d6", kind: "params.kind", suggestedParams: { n: 9 } }),
			],
		);
		const kind = screen.getByLabelText("Job kind");
		const cron = screen.getByLabelText(/Cron expression/) as HTMLInputElement;
		const params = screen.getByLabelText(/Params/) as HTMLTextAreaElement;

		// A kind without a declaration leaves the form untouched.
		fireEvent.change(kind, { target: { value: "unknown.kind" } });
		expect(cron.value).toBe("");
		expect(params.value).toBe("");

		// First declaration wins: cronExpr and paramsRaw prefill while empty.
		fireEvent.change(kind, { target: { value: "full.kind" } });
		expect(cron.value).toBe("*/5 * * * *");
		expect(params.value).toBe('{"n":1}');

		// Populated fields are never overwritten; missing suggestions are
		// skipped — cron-only, null-params, bare and params-only kinds all
		// leave the current values alone.
		for (const value of ["cron-only.kind", "params-null.kind", "bare.kind", "params.kind"]) {
			fireEvent.change(kind, { target: { value } });
			expect(cron.value).toBe("*/5 * * * *");
			expect(params.value).toBe('{"n":1}');
		}
	});
});
