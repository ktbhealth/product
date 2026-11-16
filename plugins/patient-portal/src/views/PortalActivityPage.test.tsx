// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
}));

import type { AdminAuditRow } from "@ktb/audit";

import { PortalActivityPage } from "./index.ts";

const row = (over: Partial<AdminAuditRow>): AdminAuditRow => ({
	id: 1,
	actorUserId: "u1",
	actorEmail: "staff@clinic-a.com",
	action: "patients.update",
	targetType: "patient",
	targetId: "p9",
	detail: null,
	tenantId: 1,
	prevHash: null,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	...over,
});

afterEach(cleanup);

describe("PortalActivityPage", () => {
	it("renders the patient feed with the Activity title when data is missing", () => {
		render(<PortalActivityPage data={undefined} locale="en" />);
		expect(screen.getByText("Activity")).toBeTruthy();
		expect(screen.getByText("No audit entries")).toBeTruthy();
	});

	it("narrows loader data into the audit view", () => {
		render(<PortalActivityPage data={{ entries: [row({})], total: 1, limit: 100 }} locale="en" />);
		expect(screen.getByText("staff@clinic-a.com")).toBeTruthy();
		expect(screen.getByText("patients.update")).toBeTruthy();
		expect(screen.getByText("1 admin action recorded.")).toBeTruthy();
	});

	it("localizes the title through the portal catalog", () => {
		render(<PortalActivityPage data={{ entries: [], total: 0, limit: 100 }} locale="pt-BR" />);
		expect(screen.getByText("Atividade")).toBeTruthy();
	});

	it("falls back to an empty page on malformed loader data", () => {
		render(<PortalActivityPage data={{ entries: "nope", total: "x" }} locale="en" />);
		expect(screen.getByText("No audit entries")).toBeTruthy();
	});
});
