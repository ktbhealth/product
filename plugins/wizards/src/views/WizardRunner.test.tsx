// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		const chain = {
			validator: () => chain,
			handler: (h: unknown) => h,
		};
		return chain;
	},
}));

vi.mock("../fns.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../fns.ts")>();
	return {
		...actual,
		wizardDefsFn: vi.fn<() => Promise<unknown>>(),
		startWizardFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
		advanceWizardFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
		backWizardFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
		abandonWizardFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	};
});

import { definePlugin } from "@ktb/kernel";
import type { PageContext } from "@ktb/kernel";

import type { WizardDefinition } from "../definition.ts";
import { wizardDefContribution } from "../definition.ts";
import {
	abandonWizardFn,
	advanceWizardFn,
	backWizardFn,
	startWizardFn,
	wizardDefsFn,
} from "../fns.ts";
import { WizardRunner } from "./WizardRunner.tsx";
import type { Json } from "effect/Schema";

const DEF: WizardDefinition = {
	id: "intake",
	title: "Intake wizard",
	description: "Tell us about you",
	steps: [
		{ kind: "info", id: "welcome", title: "Welcome", body: "Let's begin" },
		{
			kind: "form",
			id: "details",
			schema: { type: "object", properties: { name: { type: "string" } } },
		},
	],
};

const contributor = definePlugin({
	id: "clinic.intake",
	contributions: [wizardDefContribution(DEF)],
});

const ctxWith = (plugins: PageContext["plugins"] = [contributor]): PageContext => ({
	plugins,
	locale: "en",
});

const runWire = (over: Record<string, unknown> = {}) => ({
	id: 1,
	key: "intake",
	status: "active",
	definition: DEF,
	step: {
		kind: "info",
		id: "welcome",
		title: "Welcome",
		description: "Step one",
		body: "Let's begin",
	},
	stepIndex: 0,
	canGoBack: false,
	isLastStep: false,
	answers: {},
	...over,
});

const mockFns = () => {
	vi.mocked(wizardDefsFn).mockResolvedValue([]);
	vi.mocked(startWizardFn).mockResolvedValue(runWire() as never);
};

beforeEach(() => {
	mockFns();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("WizardRunner", () => {
	it("renders the localized not-found state for unknown ids", async () => {
		render(<WizardRunner data="/wizards/missing" ctx={ctxWith()} />);
		expect(await screen.findByText("Wizard not found")).toBeTruthy();
		expect(startWizardFn).not.toHaveBeenCalled();
	});

	it("still renders not-found when the defs fetch fails", async () => {
		vi.mocked(wizardDefsFn).mockRejectedValue(new Error("down"));
		render(<WizardRunner data="/wizards/missing" ctx={ctxWith()} />);
		expect(await screen.findByText("Wizard not found")).toBeTruthy();
	});

	it("ignores defs that fail wire validation and unmounted fetches", async () => {
		// malformed DB row is skipped; the code def still resolves
		vi.mocked(wizardDefsFn).mockResolvedValue([
			{
				key: "intake",
				title: "Bad",
				description: "",
				definition: { id: "Bad Id", steps: [] },
				published: true,
				updatedAt: "2024-01-01T00:00:00.000Z",
			},
		]);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		expect(await screen.findByText("Welcome")).toBeTruthy();
		cleanup();

		// unmount before the fetch settles → cancelled guards skip setState
		let resolveDefs: ((rows: unknown) => void) | undefined;
		vi.mocked(wizardDefsFn).mockReturnValue(
			new Promise((r) => {
				resolveDefs = r;
			}) as never,
		);
		const { unmount } = render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		unmount();
		resolveDefs?.([]);
		await new Promise((r) => setTimeout(r, 0));
	});

	it("renders not-found for non-string loader data", async () => {
		render(<WizardRunner data={null} ctx={ctxWith()} />);
		expect(await screen.findByText("Wizard not found")).toBeTruthy();
	});

	it("starts a run and renders the first info step", async () => {
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		expect(await screen.findByText("Welcome")).toBeTruthy();
		expect(screen.getByText("Let's begin")).toBeTruthy();
		expect(screen.getByText("Step 1 of 2")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
		expect(startWizardFn).toHaveBeenCalledWith({
			data: { key: "intake", definition: { ...DEF, owner: "clinic.intake" } },
		});
	});

	it("advances through an info step to the form step", async () => {
		vi.mocked(advanceWizardFn).mockResolvedValue(
			runWire({
				step: {
					kind: "form",
					id: "details",
					schema: { type: "object", properties: { name: { type: "string" } } },
				},
				stepIndex: 1,
				canGoBack: true,
			}) as never,
		);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
		await waitFor(() =>
			expect(advanceWizardFn).toHaveBeenCalledWith({
				data: { runId: 1, stepId: "welcome" },
			}),
		);
		// SchemaForm renders the form step's fields
		expect(await screen.findByLabelText("name")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
	});

	it("goes back through backWizardFn", async () => {
		vi.mocked(startWizardFn).mockResolvedValue(runWire({ stepIndex: 1, canGoBack: true }) as never);
		vi.mocked(backWizardFn).mockResolvedValue(runWire() as never);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		fireEvent.click(await screen.findByRole("button", { name: "Back" }));
		await waitFor(() => expect(backWizardFn).toHaveBeenCalledWith({ data: { runId: 1 } }));
	});

	it("abandons the run and shows the terminal state", async () => {
		vi.mocked(abandonWizardFn).mockResolvedValue(true);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		fireEvent.click(await screen.findByRole("button", { name: "Abandon wizard" }));
		expect(await screen.findByText("Wizard abandoned")).toBeTruthy();
	});

	it("shows the completed state", async () => {
		vi.mocked(startWizardFn).mockResolvedValue(
			runWire({ status: "completed", step: null, stepIndex: -1 }) as never,
		);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		expect(await screen.findByText("Wizard complete")).toBeTruthy();
	});

	it("shows the error state when the run cannot start", async () => {
		vi.mocked(startWizardFn).mockRejectedValue(new Error("boom"));
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		expect(
			await screen.findByText("Something went wrong while running this wizard. Please try again."),
		).toBeTruthy();
	});

	it("shows the error state when the wire is malformed", async () => {
		vi.mocked(startWizardFn).mockResolvedValue(null);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		expect(
			await screen.findByText("Something went wrong while running this wizard. Please try again."),
		).toBeTruthy();
	});

	it("shows the error state when an action returns null", async () => {
		vi.mocked(advanceWizardFn).mockResolvedValue(null);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
		expect(
			await screen.findByText("Something went wrong while running this wizard. Please try again."),
		).toBeTruthy();
	});

	it("shows the error state when an action rejects", async () => {
		vi.mocked(advanceWizardFn).mockRejectedValue(new Error("boom"));
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
		expect(
			await screen.findByText("Something went wrong while running this wizard. Please try again."),
		).toBeTruthy();
	});

	it("submits a form step value through SchemaForm", async () => {
		vi.mocked(advanceWizardFn)
			.mockResolvedValueOnce(
				runWire({
					step: {
						kind: "form",
						id: "details",
						schema: { type: "object", properties: { name: { type: "string" } } },
					},
					stepIndex: 1,
					canGoBack: true,
				}) as never,
			)
			.mockResolvedValueOnce(runWire({ status: "completed", step: null, stepIndex: -1 }) as never);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
		const name = await screen.findByLabelText("name");
		fireEvent.change(name, { target: { value: "Ana" } });
		fireEvent.click(screen.getByRole("button", { name: "Submit" }));
		await waitFor(() =>
			expect(advanceWizardFn).toHaveBeenLastCalledWith({
				data: { runId: 1, stepId: "details", value: { name: "Ana" } },
			}),
		);
		expect(await screen.findByText("Wizard complete")).toBeTruthy();
	});

	it("falls back to the step id when an info step has no title", async () => {
		vi.mocked(startWizardFn).mockResolvedValue(
			runWire({ step: { kind: "info", id: "bare-step" } }) as never,
		);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		expect(await screen.findByText("bare-step")).toBeTruthy();
	});

	it("keeps the parked run when the auto-finish returns null", async () => {
		vi.mocked(startWizardFn).mockResolvedValue(runWire({ step: null, stepIndex: 2 }) as never);
		vi.mocked(advanceWizardFn).mockResolvedValue(null);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		expect(await screen.findByText("Intake wizard")).toBeTruthy();
		await waitFor(() => expect(advanceWizardFn).toHaveBeenCalled());
	});

	it("keeps the parked run when the auto-finish fails", async () => {
		vi.mocked(startWizardFn).mockResolvedValue(runWire({ step: null, stepIndex: 2 }) as never);
		vi.mocked(advanceWizardFn).mockRejectedValue(new Error("still failing"));
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		// header still renders; the finish attempt failed silently
		expect(await screen.findByText("Intake wizard")).toBeTruthy();
		await waitFor(() => expect(advanceWizardFn).toHaveBeenCalled());
	});

	it("auto-finishes a run parked at the done position", async () => {
		vi.mocked(startWizardFn).mockResolvedValue(runWire({ step: null, stepIndex: 2 }) as never);
		vi.mocked(advanceWizardFn).mockResolvedValue(
			runWire({ status: "completed", step: null, stepIndex: -1 }) as never,
		);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		await waitFor(() => expect(advanceWizardFn).toHaveBeenCalledWith({ data: { runId: 1 } }));
		expect(await screen.findByText("Wizard complete")).toBeTruthy();
	});

	it("lets a published DB def shadow a code def", async () => {
		const dbDef: WizardDefinition = { ...DEF, title: "DB Intake" };
		vi.mocked(wizardDefsFn).mockResolvedValue([
			{
				key: "intake",
				title: "DB Intake",
				description: "",
				definition: dbDef as unknown as Json,
				published: true,
				updatedAt: "2024-01-01T00:00:00.000Z",
			},
		]);
		render(<WizardRunner data="/wizards/intake" ctx={ctxWith()} />);
		await waitFor(() =>
			expect(startWizardFn).toHaveBeenCalledWith({
				data: { key: "intake", definition: dbDef },
			}),
		);
		expect(await screen.findByText("Welcome")).toBeTruthy();
	});

	it("uses a DB-only def when no code def matches", async () => {
		const dbDef: WizardDefinition = { id: "db-only", steps: [{ kind: "info", id: "s" }] };
		vi.mocked(wizardDefsFn).mockResolvedValue([
			{
				key: "db-only",
				title: "DB only",
				description: "",
				definition: dbDef as unknown as Json,
				published: true,
				updatedAt: "2024-01-01T00:00:00.000Z",
			},
		]);
		vi.mocked(startWizardFn).mockResolvedValue(
			runWire({
				key: "db-only",
				definition: dbDef as unknown as Json,
				step: { kind: "info", id: "s" },
			}) as never,
		);
		render(<WizardRunner data="/wizards/db-only" ctx={ctxWith([])} />);
		expect(await screen.findByText("db-only")).toBeTruthy();
	});
});
