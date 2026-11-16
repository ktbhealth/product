// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
}));

const fns = vi.hoisted(() => ({
	auditVerifyFn: vi.fn<() => Promise<null>>(async () => null),
}));
vi.mock("./fns.ts", () => fns);

import type { PanelPageContext } from "@ktb/kernel";

import type { AdminAuditRow } from "./index.ts";
import { AuditPlatformPage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const row = (over: Partial<AdminAuditRow>): AdminAuditRow => ({
	id: 1,
	actorUserId: "u1",
	actorEmail: "admin@x.com",
	action: "users.suspend",
	targetType: "user",
	targetId: "u9",
	detail: '{"suspended":true}',
	tenantId: null,
	prevHash: null,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	...over,
});

afterEach(cleanup);

describe("AuditPlatformPage", () => {
	it("renders the empty console when the loader data is missing", () => {
		render(<AuditPlatformPage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Audit log")).toBeTruthy();
		expect(screen.getByText("No audit entries")).toBeTruthy();
	});

	it("narrows loader data into the audit view", () => {
		render(<AuditPlatformPage data={{ entries: [row({})], total: 1, limit: 200 }} ctx={ctx} />);
		expect(screen.getByText("admin@x.com")).toBeTruthy();
		expect(screen.getByText("users.suspend")).toBeTruthy();
		expect(screen.getByText("1 admin action recorded.")).toBeTruthy();
	});

	it("falls back to an empty page on malformed loader data", () => {
		render(<AuditPlatformPage data={{ entries: "nope", total: "x" }} ctx={ctx} />);
		expect(screen.getByText("No audit entries")).toBeTruthy();
	});

	it("enables the on-demand chain verification on the platform surface", async () => {
		const user = userEvent.setup();
		fns.auditVerifyFn.mockResolvedValueOnce({
			status: "verified",
			entries: 3,
			brokenAt: null,
		} as never);
		render(<AuditPlatformPage data={{ entries: [row({})], total: 1 }} ctx={ctx} />);
		await user.click(screen.getByText("Verify chain"));
		expect(fns.auditVerifyFn).toHaveBeenCalledTimes(1);
		expect(await screen.findByText("Chain verified — 3 entries intact.")).toBeTruthy();
	});
});
