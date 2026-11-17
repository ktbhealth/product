// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as never),
	};
});

import { ConsultationsDashboardContext } from "../context.ts";
import type { AdminConsultationRow } from "../queries.ts";
import {
	ConsultationsDashboardSections,
	ConsultationsDashboardStats,
} from "./ConsultationsDashboard.tsx";

const row = (over: Partial<AdminConsultationRow>): AdminConsultationRow =>
	({
		id: 1,
		source: "browser",
		status: "done",
		ownerName: null,
		ownerEmail: null,
		createdAt: new Date("2025-01-01T00:00:00Z"),
		...over,
	}) as AdminConsultationRow;

const rows: AdminConsultationRow[] = [
	row({ id: 1, status: "live", source: "browser", ownerName: "Ana" }),
	row({ id: 2, status: "live", source: "bot", ownerEmail: "doc@x.com" }),
	row({ id: 3, status: "done", source: "browser" }),
	row({ id: 4, status: "done", source: "dictation" }),
];

const renderWith = (ui: React.ReactNode, value: readonly AdminConsultationRow[] = rows) =>
	render(
		<ConsultationsDashboardContext.Provider value={value}>
			{ui}
		</ConsultationsDashboardContext.Provider>,
	);

afterEach(cleanup);

describe("ConsultationsDashboardStats", () => {
	it("renders the total and live counts from the context feed", () => {
		renderWith(<ConsultationsDashboardStats locale="en" />);
		expect(screen.getByText("Consultations")).toBeTruthy();
		expect(screen.getByText("Live now")).toBeTruthy();
		expect(screen.getByText("4")).toBeTruthy();
		expect(screen.getByText("2")).toBeTruthy();
	});

	it("renders zeros for an empty feed", () => {
		renderWith(<ConsultationsDashboardStats locale="en" />, []);
		expect(screen.getAllByText("0")).toHaveLength(2);
	});
});

describe("ConsultationsDashboardSections", () => {
	it("renders status/source breakdowns and the recent table", () => {
		renderWith(<ConsultationsDashboardSections locale="en" />);
		expect(screen.getByText("Consultations by status")).toBeTruthy();
		expect(screen.getByText("By source")).toBeTruthy();
		expect(screen.getByText("Recent consultations")).toBeTruthy();
		expect(screen.getAllByText("browser").length).toBeGreaterThan(0);
		expect(screen.getByText("doc@x.com")).toBeTruthy();
		const link = screen.getByRole("link", { name: /View all/ });
		expect(link.getAttribute("href")).toBe("/platform/consultations");
	});

	it("renders empty states and hides the view-all link when the feed is empty", () => {
		renderWith(<ConsultationsDashboardSections locale="en" />, []);
		expect(screen.getAllByText("No consultations yet.")).toHaveLength(3);
		expect(screen.queryByRole("link", { name: /View all/ })).toBeNull();
	});
});
