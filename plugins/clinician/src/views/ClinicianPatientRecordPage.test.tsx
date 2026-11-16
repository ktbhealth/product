// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	navigate: vi.fn<(options: { to: string }) => void>(),
	props: { current: undefined as Record<string, unknown> | undefined },
}));

const captured = () => {
	if (mocks.props.current === undefined) throw new Error("view captured no props");
	return mocks.props.current;
};

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => mocks.navigate,
}));
vi.mock("@ktb/patients/views", () => {
	const capture = (testId: string) => (props: Record<string, unknown>) => {
		mocks.props.current = { ...props, testId };
		return createElement("div", { "data-testid": testId });
	};
	return {
		PatientFormPage: capture("patient-form"),
		PatientDetailPage: capture("patient-detail"),
	};
});
vi.mock("@ktb/patients/apis", () => ({
	newPatientApi: { kind: "new" },
	editPatientApi: (id: number) => ({ kind: "edit", id }),
	patientDeleteApi: { kind: "delete" },
}));

import { ClinicianPatientRecordPage } from "./ClinicianPatientRecordPage.tsx";

const ctx = { plugins: [], locale: "en" };
const patient = { id: 7, name: "Bia" };

afterEach(() => {
	cleanup();
	mocks.navigate.mockClear();
	mocks.props.current = undefined;
});

describe("ClinicianPatientRecordPage", () => {
	it("renders nothing for missing or unknown loader data", () => {
		const { container, unmount } = render(
			<ClinicianPatientRecordPage data={undefined} ctx={ctx} />,
		);
		expect(container.innerHTML).toBe("");
		unmount();
		render(<ClinicianPatientRecordPage data={{ view: "missing" }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
	});

	it("mounts the new-patient form and navigates to the record on save", () => {
		render(<ClinicianPatientRecordPage data={{ view: "new" }} ctx={ctx} />);
		expect(mocks.props.current).toMatchObject({
			testId: "patient-form",
			api: { kind: "new" },
			locale: "en",
			portalBase: "/portal/clinician",
		});
		(captured().onSaved as (id: number) => void)(42);
		expect(mocks.navigate).toHaveBeenCalledWith({ to: "/portal/clinician/patients/42" });
	});

	it("mounts the edit form scoped to the patient id", () => {
		render(<ClinicianPatientRecordPage data={{ view: "edit", patient }} ctx={ctx} />);
		expect(mocks.props.current).toMatchObject({
			testId: "patient-form",
			patient,
			api: { kind: "edit", id: 7 },
			portalBase: "/portal/clinician",
		});
		(captured().onSaved as (id: number) => void)(7);
		expect(mocks.navigate).toHaveBeenCalledWith({ to: "/portal/clinician/patients/7" });
	});

	it("mounts the detail view and navigates back to the list on delete", () => {
		const consultations = [{ id: 1 }];
		render(
			<ClinicianPatientRecordPage data={{ view: "detail", patient, consultations }} ctx={ctx} />,
		);
		expect(mocks.props.current).toMatchObject({
			testId: "patient-detail",
			patient,
			consultations,
			locale: "en",
			deleteApi: { kind: "delete" },
			portalBase: "/portal/clinician",
		});
		(captured().onDeleted as () => void)();
		expect(mocks.navigate).toHaveBeenCalledWith({ to: "/portal/clinician/patients" });
	});
});
