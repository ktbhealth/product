// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fns.ts", () => ({
	listCohortsFn: vi.fn(),
	listCohortItemsFn: vi.fn(),
	reviewItemFn: vi.fn(),
	startRunFn: vi.fn(),
	progressFn: vi.fn(),
	deleteRunFn: vi.fn(),
}));
vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		// EvalSteps renders Link — degrade it to a plain anchor outside
		// a router.
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as never),
	};
});

import type { PanelPageContext } from "@ktb/kernel";

import { EvalValidatorPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

afterEach(cleanup);

describe("EvalValidatorPage platform wrapper", () => {
	it("passes a cohort array through and narrows anything else to []", () => {
		render(
			<EvalValidatorPage
				data={[
					{
						id: 3,
						name: "cohort-03",
						status: "ready",
						createdBy: "v@x.com",
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
		expect(screen.getByText(/cohort-03 #3/)).toBeTruthy();
	});

	it("renders the empty state when data is not an array", () => {
		render(<EvalValidatorPage data={{ nope: true }} ctx={ctx} />);
		expect(
			screen.getByText(/No cohorts yet — generate consultations on step 2 first/),
		).toBeTruthy();
	});
});
