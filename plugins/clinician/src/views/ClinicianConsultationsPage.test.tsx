// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	props: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("@ktb/consultations/views", () => ({
	ConsultationsPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "consultations-page" });
	},
}));

import { ClinicianConsultationsPage } from "./ClinicianConsultationsPage.tsx";

const ctx = { plugins: [], locale: "en" };

afterEach(() => {
	cleanup();
	mocks.props.current = undefined;
});

describe("ClinicianConsultationsPage", () => {
	it("maps loader data and ctx into the consultations list view", () => {
		const consultations = [{ id: 2 }];
		render(<ClinicianConsultationsPage data={consultations} ctx={ctx} />);
		expect(mocks.props.current).toMatchObject({
			consultations,
			locale: "en",
			portalBase: "/portal/clinician",
		});
	});

	it("defaults missing loader data to an empty list", () => {
		render(<ClinicianConsultationsPage data={null} ctx={ctx} />);
		expect(mocks.props.current?.consultations).toEqual([]);
	});
});
