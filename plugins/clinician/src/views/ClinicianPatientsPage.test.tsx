// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	invalidate: vi.fn<() => void>(),
	props: { current: undefined as Record<string, unknown> | undefined },
}));

const captured = () => {
	if (mocks.props.current === undefined) throw new Error("view captured no props");
	return mocks.props.current;
};

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: mocks.invalidate }),
}));
vi.mock("@ktb/patients/views", () => ({
	PatientsPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "patients-page" });
	},
}));
vi.mock("@ktb/patients/apis", () => ({ patientDeleteApi: { delete: "sentinel" } }));

import { ClinicianPatientsPage } from "./ClinicianPatientsPage.tsx";

const ctx = { plugins: [], locale: "en" };

afterEach(() => {
	cleanup();
	mocks.invalidate.mockClear();
	mocks.props.current = undefined;
});

describe("ClinicianPatientsPage", () => {
	it("maps loader data and ctx into the patients list view", () => {
		const patients = [{ id: 1, name: "Ana" }];
		render(<ClinicianPatientsPage data={patients} ctx={ctx} />);
		expect(mocks.props.current).toMatchObject({
			patients,
			locale: "en",
			portalBase: "/portal/clinician",
			deleteApi: { delete: "sentinel" },
		});
		expect(typeof mocks.props.current?.onDeleted).toBe("function");
	});

	it("defaults missing loader data to an empty list", () => {
		render(<ClinicianPatientsPage data={undefined} ctx={ctx} />);
		expect(mocks.props.current?.patients).toEqual([]);
	});

	it("refreshes through the router when a patient is deleted", () => {
		render(<ClinicianPatientsPage data={[]} ctx={ctx} />);
		(captured().onDeleted as () => void)();
		expect(mocks.invalidate).toHaveBeenCalledTimes(1);
	});
});
