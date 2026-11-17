// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Res<T> = Promise<{ ok: true; data: T } | { ok: false }>;
type Arg = { data?: unknown } | undefined;

const fns = vi.hoisted(() => ({
	listCohortsFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({ ok: true, data: [] })),
	listCohortItemsFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({
		ok: true,
		data: [],
	})),
	reviewItemFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({ ok: true, data: null })),
	startRunFn: vi.fn<(a?: Arg) => Res<{ runId: number }>>(async () => ({
		ok: true,
		data: { runId: 42 },
	})),
	progressFn: vi.fn<(a?: Arg) => Res<unknown>>(async () => ({ ok: true, data: null })),
	deleteRunFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({ ok: true, data: null })),
}));

vi.mock("../fns.ts", () => fns);
vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children: unknown }) => (
		<a href={to}>{children as never}</a>
	),
}));

import type { CohortItemCard, CohortSummary, RunProgress, RunSampleProgress } from "../index.ts";
import { EvalValidatorPage } from "./EvalValidatorPage.tsx";

const cohort: CohortSummary = {
	id: 1,
	name: "cohort-01",
	status: "ready",
	createdBy: "v@x.com",
	createdAt: new Date("2026-11-01T10:00:00Z"),
	count: 2,
	pending: 1,
	approved: 1,
	rejected: 0,
	state: "mixed",
};

const item: CohortItemCard = {
	id: 11,
	instanceId: 1,
	personaDefId: 3,
	state: "under_review",
	status: "done",
	error: null,
	feedback: null,
	patientId: 5,
	doctorId: null,
	scriptMode: "llm",
	persona: {
		name: "Paciente Ana",
		gender: "female",
		socialClass: "c",
		education: "secondary",
		region: "northeast",
		ageBand: "adult",
		register: "colloquial",
		specialty: "general_practice",
		doctor: { gender: "male", register: "formal" },
	},
	script: "roteiro",
	turns: [{ speaker: "doctor", text: "bom dia" }],
	voices: { doctor: "br_male_1", patient: "br_female_1" },
};

const runSample: RunSampleProgress = {
	script: "o paciente toma losartana",
	id: 99,
	runId: 42,
	itemId: 11,
	status: "ok",
	result: JSON.stringify({ wer: 0.1, audioUri: "file:///a.wav", asrText: "o paciente losartana" }),
	error: null,
	createdAt: new Date(),
};

const runProgress: RunProgress = {
	id: 42,
	instanceId: 1,
	params: { instanceId: 1, itemIds: [11] },
	status: "done",
	done: 1,
	total: 1,
	pct: 100,
	summary: null,
	aggregates: [
		{
			axis: "register",
			slices: [
				{ key: "formal", samples: 1, ok: 1, meanWer: 0.1 },
				{ key: "colloquial", samples: 2, ok: 0, meanWer: null },
				{ key: "mixed", samples: 1, ok: 1, meanWer: 0.3 },
			],
		},
	],
	samples: [runSample],
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("EvalValidatorPage", () => {
	it("lists cohorts with counts and an empty-items state", async () => {
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		// "Run eval" appears as the page title, the step-3 label and
		// the cohort's run button — assert presence, not uniqueness.
		expect(screen.getAllByText("Run eval").length).toBeGreaterThan(0);
		expect(screen.getByText(/2 consultations/)).toBeTruthy();
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await waitFor(() =>
			expect(fns.listCohortItemsFn).toHaveBeenCalledWith({ data: { cohortId: 1 } }),
		);
		expect(await screen.findByText(/Select a cohort to review/)).toBeTruthy();
	});

	it("shows the empty-cohorts copy when there is nothing to review", () => {
		render(<EvalValidatorPage cohorts={[]} locale="en" />);
		expect(screen.getByText(/No cohorts yet/)).toBeTruthy();
	});

	it("marks a cohort that is still generating", async () => {
		render(<EvalValidatorPage cohorts={[{ ...cohort, status: "generating" }]} locale="en" />);
		expect(screen.getByText("generating")).toBeTruthy();
	});

	it("renders item cards with badges, entities, feedback and turns", async () => {
		const reviewed: CohortItemCard = {
			...item,
			id: 12,
			state: "rejected",
			feedback: "unrealistic script",
			doctorId: 7,
			scriptMode: "template",
		};
		fns.listCohortItemsFn.mockResolvedValue({ ok: true, data: [item, reviewed] });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await screen.findAllByText(/Paciente Ana/);
		expect(screen.getByText(/doctor #7/)).toBeTruthy();
		expect(screen.getByText("llm")).toBeTruthy();
		expect(screen.getByText("template")).toBeTruthy();
		expect(screen.getByText(/unrealistic script/)).toBeTruthy();
		// Both items share the turn list — the text lands once per card.
		expect(screen.getAllByText(/bom dia/).length).toBe(2);
	});

	it("falls back to the item id when the persona snapshot is missing", async () => {
		fns.listCohortItemsFn.mockResolvedValue({
			ok: true,
			data: [{ ...item, persona: null }],
		});
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		expect(await screen.findByText(/#11/)).toBeTruthy();
	});

	it("shows generation status on unfinished items and hides the review gate", async () => {
		fns.listCohortItemsFn.mockResolvedValue({
			ok: true,
			data: [{ ...item, status: "error", error: "llm down", turns: [] }],
		});
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		expect(await screen.findByText("error")).toBeTruthy();
		expect(screen.getByText(/llm down/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
	});

	it("approves an item with feedback", async () => {
		fns.listCohortItemsFn.mockResolvedValue({ ok: true, data: [item] });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await screen.findByText(/Paciente Ana/);
		await user.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() =>
			expect(fns.reviewItemFn).toHaveBeenCalledWith({
				data: { itemId: 11, decision: "approved", feedback: undefined },
			}),
		);
	});

	it("rejects an item", async () => {
		fns.listCohortItemsFn.mockResolvedValue({ ok: true, data: [item] });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await screen.findByText(/Paciente Ana/);
		await user.click(screen.getByRole("button", { name: "Reject" }));
		await waitFor(() =>
			expect(fns.reviewItemFn).toHaveBeenCalledWith({
				data: { itemId: 11, decision: "rejected", feedback: undefined },
			}),
		);
	});

	it("surfaces the error message when a review is denied", async () => {
		fns.listCohortItemsFn.mockResolvedValue({ ok: true, data: [item] });
		fns.reviewItemFn.mockResolvedValue({ ok: false as const });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await screen.findByText(/Paciente Ana/);
		await user.click(screen.getByRole("button", { name: "Approve" }));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("starts a run over the cohort and renders failed samples", async () => {
		const failedRun: RunProgress = {
			...runProgress,
			status: "done",
			samples: [
				{ ...runSample, id: 100, status: "failed", error: "asr down", result: null },
				{ ...runSample, id: 101, status: "ok", result: "not json" },
				{ ...runSample, id: 102, status: "ok", script: null },
			],
		};
		fns.progressFn.mockResolvedValue({ ok: true, data: failedRun });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await waitFor(() => expect(fns.startRunFn).toHaveBeenCalledWith({ data: { instanceId: 1 } }));
		expect(await screen.findByText(/asr down/)).toBeTruthy();
	});

	it("renders full metrics (wer/cer/transcript) and survives failed polls", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const rich: RunProgress = {
			...runProgress,
			samples: [
				{
					...runSample,
					result: JSON.stringify({
						wer: 0.123,
						cer: 0.045,
						asrText: "o paciente toma enalapril extra",
					}),
				},
			],
		};
		fns.progressFn
			.mockResolvedValueOnce({ ok: false as const })
			.mockResolvedValue({ ok: true, data: rich });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		// First poll {ok:false} → reschedule instead of dying.
		await vi.waitFor(() => expect(fns.progressFn).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(2100);
		expect(await screen.findByText(/WER 0.123/)).toBeTruthy();
		expect(screen.getByText(/CER 0.045/)).toBeTruthy();
		expect(screen.getByText(/enalapril/)).toBeTruthy();
		expect(screen.getByText(/sub ·/)).toBeTruthy();
		expect(screen.getByText("formal")).toBeTruthy();
		expect(screen.getByText(/0.10 \(/)).toBeTruthy();
		expect(screen.getByText("colloquial")).toBeTruthy();
		expect(screen.getByText(/— \(/)).toBeTruthy();
		vi.useRealTimers();
	});

	it("renders stage metrics, corrected diff and completeness", async () => {
		const staged: RunProgress = {
			...runProgress,
			samples: [
				{
					...runSample,
					result: JSON.stringify({
						wer: 0.2,
						cer: 0.1,
						asrText: "enalapril xtra",
						stages: ["asr", "cleanup", "anamnesis"],
						cleanup: { edits: 2, corrected: "enalapril", werAfter: 0.0, cerAfter: 0.0 },
						anamnesis: { engine: "acp", sections: 8, filled: 6, completeness: 0.75 },
					}),
				},
			],
			summary: { meanWer: 0.2, meanWerAfter: 0.0, meanCompleteness: 0.75 },
		};
		fns.progressFn.mockResolvedValue({ ok: true, data: staged });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		expect((await screen.findAllByText(/cleanup/)).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/anamnesis/i).length).toBeGreaterThan(0);
		expect(screen.getByText(/WER→0.000/)).toBeTruthy();
		expect(screen.getByText(/acp — 6\/8 sections \(75%\)/)).toBeTruthy();
		expect(screen.getByText(/2 edits — WER→/)).toBeTruthy();
	});

	it("renders stage errors and missing stage fields", async () => {
		const errored: RunProgress = {
			...runProgress,
			samples: [
				{
					...runSample,
					result: JSON.stringify({
						wer: 0.5,
						asrText: "x",
						cleanup: { error: "llm timeout" },
						anamnesis: { error: "extract failed" },
					}),
				},
			],
		};
		fns.progressFn.mockResolvedValue({ ok: true, data: errored });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		expect(await screen.findByText(/llm timeout/)).toBeTruthy();
		expect(screen.getByText(/extract failed/)).toBeTruthy();
	});

	it("renders anamnesis defaults when fields are absent", async () => {
		const bare: RunProgress = {
			...runProgress,
			samples: [
				{
					...runSample,
					result: JSON.stringify({
						wer: 0.5,
						asrText: "x",
						cleanup: {},
						anamnesis: {},
					}),
				},
			],
		};
		fns.progressFn.mockResolvedValue({ ok: true, data: bare });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		expect(await screen.findByText(/0 edits — WER→—/)).toBeTruthy();
		expect(screen.getByText(/— — 0\/8 sections \(0%\)/)).toBeTruthy();
	});

	it("deletes a run through the confirm flow", async () => {
		fns.progressFn.mockResolvedValue({ ok: true, data: { ...runProgress, status: "done" } });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await user.click(await screen.findByRole("button", { name: "Delete run" }));
		await user.click(screen.getByRole("button", { name: /Confirm/ }));
		expect(fns.deleteRunFn).toHaveBeenCalledWith({ data: { runId: 42 } });
	});

	it("surfaces an error when deleteRunFn is denied", async () => {
		fns.deleteRunFn.mockResolvedValue({ ok: false });
		fns.progressFn.mockResolvedValue({ ok: true, data: { ...runProgress, status: "done" } });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await user.click(await screen.findByRole("button", { name: "Delete run" }));
		await user.click(screen.getByRole("button", { name: /Confirm/ }));
		expect(await screen.findByText(/failed|error|denied/i)).toBeTruthy();
	});

	it("stops polling when the run row is gone", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		fns.progressFn.mockResolvedValue({ ok: true, data: null });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await vi.waitFor(() => expect(fns.progressFn).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(5000);
		expect(fns.progressFn).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it("does not touch state after unmount", async () => {
		let resolvePoll: ((v: { ok: true; data: RunProgress }) => void) | undefined;
		fns.progressFn.mockImplementation(() => new Promise((r) => (resolvePoll = r)));
		const { unmount } = render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		unmount();
		resolvePoll?.({ ok: true, data: runProgress });
	});

	it("keeps polling while the run is in progress", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const running: RunProgress = { ...runProgress, status: "running", pct: 50, done: 0 };
		fns.progressFn
			.mockResolvedValueOnce({ ok: true, data: running })
			.mockResolvedValue({ ok: true, data: runProgress });
		render(<EvalValidatorPage cohorts={[cohort]} locale="en" />);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await vi.waitFor(() => expect(fns.progressFn).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(2100);
		await vi.waitFor(() => expect(fns.progressFn).toHaveBeenCalledTimes(2));
		expect(await screen.findByText(/Run #42 — done/)).toBeTruthy();
		vi.useRealTimers();
	});
});
