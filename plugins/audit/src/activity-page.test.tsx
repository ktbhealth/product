// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
}));

const fns = vi.hoisted(() => ({
	auditActivityListFn: vi.fn(async ({ data }: { data: unknown }): Promise<unknown> => ({
		entries: [],
		total: 0,
		limit: 200,
		offset: 0,
		data,
	})),
	auditActivityFacetsFn: vi.fn(async (): Promise<unknown> => ({
		actionGroups: [],
		actors: [],
		targetTypes: [],
	})),
}));
vi.mock("./fns.ts", () => fns);

import type { PageContext } from "@ktb/kernel";

import type { AdminAuditRow } from "./index.ts";
import { AuditActivityPage } from "./activity-page.tsx";

const ctx: PageContext = { plugins: [], locale: "en" };

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

describe("AuditActivityPage", () => {
	it("renders the staff feed with the Activity title when data is missing", () => {
		render(<AuditActivityPage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Activity")).toBeTruthy();
		expect(screen.getByText("No audit entries")).toBeTruthy();
	});

	it("narrows loader data into the audit view", () => {
		render(
			<AuditActivityPage
				data={{ entries: [row({})], total: 1, limit: 200, offset: 3 }}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("staff@clinic-a.com")).toBeTruthy();
		expect(screen.getByText("patients.update")).toBeTruthy();
		expect(screen.getByText("1 admin action recorded.")).toBeTruthy();
	});

	it("localizes the title through the plugin catalog", () => {
		render(
			<AuditActivityPage
				data={{ entries: [], total: 0, limit: 200 }}
				ctx={{ ...ctx, locale: "pt-BR" }}
			/>,
		);
		expect(screen.getByText("Atividade")).toBeTruthy();
	});

	it("falls back to an empty page on malformed loader data", () => {
		render(<AuditActivityPage data={{ entries: "nope", total: "x", offset: "y" }} ctx={ctx} />);
		expect(screen.getByText("No audit entries")).toBeTruthy();
	});

	it("forwards server pagination to auditActivityListFn", async () => {
		const user = userEvent.setup();
		render(<AuditActivityPage data={{ entries: [row({})], total: 5, limit: 1 }} ctx={ctx} />);
		await user.click(screen.getByText("Next"));
		expect(fns.auditActivityListFn).toHaveBeenCalledWith({
			data: expect.objectContaining({ limit: 1, offset: 1 }),
		});
	});
});
