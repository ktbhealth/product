// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fns.ts", () => ({
	generateBatchFn: vi.fn(),
	listBatchesFn: vi.fn(),
	listPersonasFn: vi.fn(),
	reviewPersonaFn: vi.fn(),
	startRunFn: vi.fn(),
	progressFn: vi.fn(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { EvalValidatorPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

afterEach(cleanup);

describe("EvalValidatorPage platform wrapper", () => {
	it("passes a batch array through and narrows anything else to []", () => {
		render(
			<EvalValidatorPage
				data={[
					{
						id: 3,
						createdAt: new Date("2026-11-01T10:00:00Z"),
						count: 4,
						pending: 4,
						approved: 0,
						rejected: 0,
						state: "review",
					},
				]}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("Eval validator")).toBeTruthy();
		expect(screen.getByText(/Batch #3/)).toBeTruthy();
	});

	it("renders the empty state when data is not an array", () => {
		render(<EvalValidatorPage data={{ nope: true }} ctx={ctx} />);
		expect(screen.getByText(/No persona batches yet/)).toBeTruthy();
	});
});
