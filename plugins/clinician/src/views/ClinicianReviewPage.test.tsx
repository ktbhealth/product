// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pathname: { current: "/portal/doctor/review/9" },
	reviewProps: [] as Record<string, unknown>[],
}));

vi.mock("@tanstack/react-router", () => ({
	useLocation: (opts: { select: (l: { pathname: string }) => unknown }) =>
		opts.select({ pathname: mocks.pathname.current }),
}));

vi.mock("@ktb/consultations/views", () => ({
	ReviewModePage: (props: Record<string, unknown>) => {
		mocks.reviewProps.push(props);
		return createElement("div", { "data-testid": "review-mode" });
	},
}));

vi.mock("@ktb/consultations/apis", () => ({
	consultationDetailApi: { marker: "detail-api" },
}));

import { ClinicianReviewPage, type ClinicianReviewData } from "./ClinicianReviewPage.tsx";

const ctx = { plugins: [], locale: "en", i18n: { t: (k: string) => k } };

const queueItem = (id: number) => ({
	id,
	engine: null,
	createdAt: new Date(0),
	transcript: "",
	source: null,
	status: "done",
	consentAt: null,
	patientId: null,
	patientName: null,
	chiefComplaint: null,
	hasAnamnesis: false,
});

const renderPage = (data: unknown) =>
	render(createElement(ClinicianReviewPage, { data, ctx: ctx as never }));

afterEach(() => {
	cleanup();
	mocks.reviewProps.length = 0;
	mocks.pathname.current = "/portal/doctor/review/9";
});

describe("ClinicianReviewPage", () => {
	it("renders nothing for the missing view", () => {
		const { container } = renderPage({ view: "missing" });
		expect(container.innerHTML).toBe("");
	});

	it("mounts ReviewModePage with the queue and no record on the overview", () => {
		const data: ClinicianReviewData = {
			view: "queue",
			queue: [queueItem(9)],
			author: "u1",
		};
		renderPage(data);
		expect(screen.getByTestId("review-mode")).toBeTruthy();
		expect(mocks.reviewProps.at(-1)).toMatchObject({
			queue: [{ id: 9 }],
			c: null,
			author: "u1",
			portalBase: "/portal/doctor",
			locale: "en",
		});
	});

	it("passes the selected record through on the item view", () => {
		const c = { id: 9 };
		const data: ClinicianReviewData = {
			view: "item",
			queue: [queueItem(9)],
			c: c as never,
			author: "u1",
		};
		renderPage(data);
		expect(mocks.reviewProps.at(-1)).toMatchObject({ c, portalBase: "/portal/doctor" });
	});

	it("defaults malformed data to the missing view", () => {
		const { container } = renderPage(undefined);
		expect(container.innerHTML).toBe("");
	});
});
