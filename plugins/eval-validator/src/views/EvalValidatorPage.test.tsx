// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Res<T> = Promise<{ ok: true; data: T } | { ok: false }>;
type Arg = { data?: unknown } | undefined;

const fns = vi.hoisted(() => ({
	generateBatchFn: vi.fn<(a?: Arg) => Res<{ batchId: number }>>(async () => ({
		ok: true,
		data: { batchId: 7 },
	})),
	listBatchesFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({ ok: true, data: [] })),
	listPersonasFn: vi.fn<(a?: Arg) => Res<readonly unknown[]>>(async () => ({ ok: true, data: [] })),
	reviewPersonaFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({ ok: true, data: null })),
	startRunFn: vi.fn<(a?: Arg) => Res<{ runId: number }>>(async () => ({
		ok: true,
		data: { runId: 42 },
	})),
	progressFn: vi.fn<(a?: Arg) => Res<unknown>>(async () => ({ ok: true, data: null })),
	deleteRunFn: vi.fn<(a?: Arg) => Res<null>>(async () => ({ ok: true, data: null })),
}));

vi.mock("../fns.ts", () => fns);

import type { BatchSummary, PersonaCard, RunProgress, RunSampleProgress } from "../index.ts";
import { EvalValidatorPage } from "./EvalValidatorPage.tsx";

const batch: BatchSummary = {
	id: 1,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	count: 2,
	pending: 1,
	approved: 1,
	rejected: 0,
	state: "mixed",
};

const persona: PersonaCard = {
	id: 11,
	batchId: 1,
	state: "under_review",
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
	personaId: 11,
	status: "ok",
	result: JSON.stringify({ wer: 0.1, audioUri: "file:///a.wav", asrText: "o paciente losartana" }),
	error: null,
	createdAt: new Date(),
};

const runProgress: RunProgress = {
	id: 42,
	batchId: 1,
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
	it("lists batches with counts and an empty-personas state", async () => {
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		expect(screen.getByText("Eval validator")).toBeTruthy();
		expect(screen.getByText(/2 personas/)).toBeTruthy();
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await waitFor(() => expect(fns.listPersonasFn).toHaveBeenCalled());
		expect(await screen.findByText(/Select a batch to review/)).toBeTruthy();
	});

	it("generates a batch and refreshes persona cards", async () => {
		fns.listPersonasFn.mockResolvedValueOnce({ ok: true, data: [persona] });
		render(<EvalValidatorPage batches={[]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Generate personas" }));
		await waitFor(() =>
			expect(fns.generateBatchFn).toHaveBeenCalledWith({ data: { count: 6, minutes: 15 } }),
		);
		expect(await screen.findByText(/Paciente Ana/)).toBeTruthy();
		expect(screen.getByText(/under_review/)).toBeTruthy();
	});

	it("shows an approved badge and survives a failed generate", async () => {
		fns.listPersonasFn.mockResolvedValue({
			ok: true,
			data: [{ ...persona, state: "approved" }],
		});
		fns.generateBatchFn.mockResolvedValueOnce({ ok: false as const });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		expect(await screen.findByText(/approved/)).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Generate personas" }));
		await waitFor(() => expect(fns.generateBatchFn).toHaveBeenCalled());
	});

	it("renders synthetic entity links and the script source badge", async () => {
		const linked: PersonaCard = {
			...persona,
			id: 13,
			patientId: null,
			doctorId: 7,
			scriptMode: "template",
		};
		fns.listPersonasFn.mockResolvedValue({ ok: true, data: [persona, linked] });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await screen.findByText(/doctor #7/);
		// patientId null renders the "—" placeholder; both script
		// source badges show.
		expect(screen.getByText(/patient #—/)).toBeTruthy();
		expect(screen.getByText("llm")).toBeTruthy();
		expect(screen.getByText("template")).toBeTruthy();
	});

	it("approves a persona with feedback", async () => {
		fns.listPersonasFn.mockResolvedValue({ ok: true, data: [persona] });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await screen.findByText(/Paciente Ana/);
		await user.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() =>
			expect(fns.reviewPersonaFn).toHaveBeenCalledWith({
				data: { personaId: 11, decision: "approved", feedback: undefined },
			}),
		);
	});

	it("rejects a persona and renders feedback + all turns", async () => {
		const longTurns = Array.from({ length: 14 }, (_, i) => ({
			speaker: "doctor",
			text: `turn ${i}`,
		}));
		const reviewed: PersonaCard = {
			...persona,
			id: 12,
			state: "rejected",
			feedback: "unrealistic script",
			turns: longTurns,
		};
		fns.listPersonasFn.mockResolvedValue({ ok: true, data: [reviewed] });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await screen.findByText(/Paciente Ana/);
		// The full script renders — no truncation, the reviewer reads
		// every turn before approving.
		expect(screen.getByText(/turn 13/)).toBeTruthy();
		expect(screen.getByText(/unrealistic script/)).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Reject" }));
		await waitFor(() =>
			expect(fns.reviewPersonaFn).toHaveBeenCalledWith({
				data: { personaId: 12, decision: "rejected", feedback: undefined },
			}),
		);
	});

	it("surfaces the error message when a review is denied", async () => {
		fns.listPersonasFn.mockResolvedValue({ ok: true, data: [persona] });
		fns.reviewPersonaFn.mockResolvedValue({ ok: false as const });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await screen.findByText(/Paciente Ana/);
		await user.click(screen.getByRole("button", { name: "Approve" }));
		expect(await screen.findByText(/Action failed/)).toBeTruthy();
	});

	it("clamps the minutes input and sends it to generate", async () => {
		fns.listPersonasFn.mockResolvedValueOnce({ ok: true, data: [persona] });
		render(<EvalValidatorPage batches={[]} locale="en" />);
		const user = userEvent.setup();
		const input = screen.getByLabelText(/Interview length/);
		await user.clear(input);
		// Clearing leaves the field empty → the onChange fallback
		// clamps NaN/0 back to 1.
		await waitFor(() => expect((input as HTMLInputElement).value).toBe("1"));
		await user.type(input, "5");
		await user.click(screen.getByRole("button", { name: "Generate personas" }));
		await waitFor(() =>
			expect(fns.generateBatchFn).toHaveBeenCalledWith({ data: { count: 6, minutes: 15 } }),
		);
	});

	it("renders failed samples and skips malformed result JSON", async () => {
		const failedRun: RunProgress = {
			...runProgress,
			status: "done",
			samples: [
				{ ...runSample, id: 100, status: "failed", error: "asr down", result: null },
				{ ...runSample, id: 101, status: "ok", result: "not json" },
			],
		};
		fns.progressFn.mockResolvedValue({ ok: true, data: failedRun });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		expect(await screen.findByText(/0 edits — WER→—/)).toBeTruthy();
		expect(screen.getByText(/— — 0\/8 sections \(0%\)/)).toBeTruthy();
	});

	it("deletes a run through the confirm flow", async () => {
		fns.progressFn.mockResolvedValue({ ok: true, data: { ...runProgress, status: "done" } });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await user.click(await screen.findByRole("button", { name: "Delete run" }));
		await user.click(screen.getByRole("button", { name: /Confirm/ }));
		expect(fns.deleteRunFn).toHaveBeenCalledWith({ data: { runId: 42 } });
	});

	it("surfaces an error when deleteRunFn is denied", async () => {
		fns.deleteRunFn.mockResolvedValue({ ok: false });
		fns.progressFn.mockResolvedValue({ ok: true, data: { ...runProgress, status: "done" } });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await user.click(await screen.findByRole("button", { name: "Delete run" }));
		await user.click(screen.getByRole("button", { name: /Confirm/ }));
		expect(await screen.findByText(/failed|error|denied/i)).toBeTruthy();
	});

	it("stops polling when the run row is gone", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		fns.progressFn.mockResolvedValue({ ok: true, data: null });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await vi.waitFor(() => expect(fns.progressFn).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(5000);
		expect(fns.progressFn).toHaveBeenCalledTimes(1);
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		expect(await screen.findByText(/0 edits — WER→—/)).toBeTruthy();
		expect(screen.getByText(/— — 0\/8 sections \(0%\)/)).toBeTruthy();
	});

	it("deletes a run through the confirm flow", async () => {
		fns.progressFn.mockResolvedValue({ ok: true, data: { ...runProgress, status: "done" } });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await user.click(await screen.findByRole("button", { name: "Delete run" }));
		await user.click(screen.getByRole("button", { name: /Confirm/ }));
		expect(fns.deleteRunFn).toHaveBeenCalledWith({ data: { runId: 42 } });
	});

	it("surfaces an error when deleteRunFn is denied", async () => {
		fns.deleteRunFn.mockResolvedValue({ ok: false });
		fns.progressFn.mockResolvedValue({ ok: true, data: { ...runProgress, status: "done" } });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await user.click(await screen.findByRole("button", { name: "Delete run" }));
		await user.click(screen.getByRole("button", { name: /Confirm/ }));
		expect(await screen.findByText(/failed|error|denied/i)).toBeTruthy();
	});

	it("does not touch state after unmount", async () => {
		let resolvePoll: ((v: { ok: true; data: RunProgress }) => void) | undefined;
		fns.progressFn.mockImplementation(() => new Promise((r) => (resolvePoll = r)));
		const { unmount } = render(<EvalValidatorPage batches={[batch]} locale="en" />);
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await vi.waitFor(() => expect(fns.progressFn).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(2100);
		await vi.waitFor(() => expect(fns.progressFn).toHaveBeenCalledTimes(2));
		expect(await screen.findByText(/Run #42 — done/)).toBeTruthy();
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
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
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		expect(await screen.findByText(/0 edits — WER→—/)).toBeTruthy();
		expect(screen.getByText(/— — 0\/8 sections \(0%\)/)).toBeTruthy();
	});

	it("deletes a run through the confirm flow", async () => {
		fns.progressFn.mockResolvedValue({ ok: true, data: { ...runProgress, status: "done" } });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await user.click(await screen.findByRole("button", { name: "Delete run" }));
		await user.click(screen.getByRole("button", { name: /Confirm/ }));
		expect(fns.deleteRunFn).toHaveBeenCalledWith({ data: { runId: 42 } });
	});

	it("surfaces an error when deleteRunFn is denied", async () => {
		fns.deleteRunFn.mockResolvedValue({ ok: false });
		fns.progressFn.mockResolvedValue({ ok: true, data: { ...runProgress, status: "done" } });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await user.click(await screen.findByRole("button", { name: "Delete run" }));
		await user.click(screen.getByRole("button", { name: /Confirm/ }));
		expect(await screen.findByText(/failed|error|denied/i)).toBeTruthy();
	});

	it("passes typed feedback to the review fn", async () => {
		fns.listPersonasFn.mockResolvedValue({ ok: true, data: [persona] });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await screen.findByText(/Paciente Ana/);
		await user.type(screen.getByPlaceholderText("feedback (optional)"), "sounds fake");
		await user.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() =>
			expect(fns.reviewPersonaFn).toHaveBeenCalledWith({
				data: { personaId: 11, decision: "approved", feedback: "sounds fake" },
			}),
		);
	});

	it("tolerates failed refresh and startRun responses", async () => {
		fns.listBatchesFn.mockResolvedValue({ ok: false as const });
		fns.listPersonasFn.mockResolvedValue({ ok: false as const });
		fns.startRunFn.mockResolvedValue({ ok: false as const });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "View" }));
		await waitFor(() => expect(fns.listPersonasFn).toHaveBeenCalled());
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await waitFor(() => expect(fns.startRunFn).toHaveBeenCalled());
		expect(fns.progressFn).not.toHaveBeenCalled();
		// clearAllMocks keeps implementations — restore the shared
		// defaults so later tests aren't poisoned.
		fns.listBatchesFn.mockResolvedValue({ ok: true, data: [] });
		fns.listPersonasFn.mockResolvedValue({ ok: true, data: [] });
		fns.startRunFn.mockResolvedValue({ ok: true, data: { runId: 42 } });
	});

	it("starts a run and polls progress until done, showing the audio player", async () => {
		fns.progressFn.mockResolvedValue({ ok: true, data: runProgress });
		render(<EvalValidatorPage batches={[batch]} locale="en" />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Run eval" }));
		await waitFor(() => expect(fns.startRunFn).toHaveBeenCalledWith({ data: { batchId: 1 } }));
		expect(await screen.findByText(/Run #42/)).toBeTruthy();
		const audio = document.querySelector("audio");
		expect(audio?.getAttribute("src")).toBe("/api/eval/99/audio");
	});
});
