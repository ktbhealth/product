// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	search: { current: undefined as unknown },
	props: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("@tanstack/react-router", () => ({
	useSearch: () => mocks.search.current,
}));
vi.mock("@ktb/consultations/views", () => {
	const capture = (testId: string) => (props: Record<string, unknown>) => {
		mocks.props.current = { ...props, testId };
		return createElement("div", { "data-testid": testId });
	};
	return {
		NewConsultationPage: capture("new-consultation"),
		ConsultationDetailPage: capture("consultation-detail"),
	};
});
vi.mock("@ktb/consultations/apis", () => ({
	newConsultationApi: { kind: "new" },
	consultationDetailApi: { kind: "detail" },
}));
vi.mock("@ktb/consultations/backend", () => ({ transcriptionBackend: { kind: "backend" } }));

import { ClinicianConsultationRecordPage } from "./ClinicianConsultationRecordPage.tsx";

const ctx = { plugins: [], locale: "en" };
const consultation = { id: 5, patientId: 7 };
const patients = [{ id: 7, name: "Bia" }];

afterEach(() => {
	cleanup();
	mocks.search.current = undefined;
	mocks.props.current = undefined;
});

describe("ClinicianConsultationRecordPage", () => {
	it("renders nothing for missing or unknown loader data", () => {
		const { container, unmount } = render(
			<ClinicianConsultationRecordPage data={undefined} ctx={ctx} />,
		);
		expect(container.innerHTML).toBe("");
		unmount();
		render(<ClinicianConsultationRecordPage data={{ view: "missing" }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
	});

	it("mounts the new-consultation form with a valid ?patientId", () => {
		mocks.search.current = { patientId: "7" };
		render(<ClinicianConsultationRecordPage data={{ view: "new", patients }} ctx={ctx} />);
		expect(mocks.props.current).toMatchObject({
			testId: "new-consultation",
			initialPatients: patients,
			initialPatientId: 7,
			api: { kind: "new" },
			backend: { kind: "backend" },
			locale: "en",
			portalBase: "/portal/clinician",
		});
	});

	it("ignores a missing or invalid ?patientId", () => {
		for (const search of [undefined, {}, { patientId: "abc" }, { patientId: "0" }]) {
			mocks.search.current = search;
			const { unmount } = render(
				<ClinicianConsultationRecordPage data={{ view: "new", patients }} ctx={ctx} />,
			);
			expect(mocks.props.current?.initialPatientId).toBeUndefined();
			unmount();
			mocks.props.current = undefined;
		}
	});

	it("mounts the consultation detail view", () => {
		const history = { entries: [] };
		render(
			<ClinicianConsultationRecordPage
				data={{ view: "detail", c: consultation, history }}
				ctx={ctx}
			/>,
		);
		expect(mocks.props.current).toMatchObject({
			testId: "consultation-detail",
			c: consultation,
			history,
			api: { kind: "detail" },
			locale: "en",
			portalBase: "/portal/clinician",
		});
	});
});
