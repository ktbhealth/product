// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PatientsDashboardContext } from "../context.ts";
import { PatientsDashboardStats } from "./PatientsDashboard.tsx";

afterEach(cleanup);

describe("PatientsDashboardStats", () => {
	it("renders the patients count from the context feed", () => {
		render(
			<PatientsDashboardContext.Provider value={[{}, {}, {}] as never}>
				<PatientsDashboardStats locale="en" />
			</PatientsDashboardContext.Provider>,
		);
		expect(screen.getByText("Patients")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
	});

	it("renders zero for an empty feed", () => {
		render(
			<PatientsDashboardContext.Provider value={[]}>
				<PatientsDashboardStats locale="en" />
			</PatientsDashboardContext.Provider>,
		);
		expect(screen.getByText("0")).toBeTruthy();
	});
});
