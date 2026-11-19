// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fns.ts", () => ({
	createLayoutFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateLayoutFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteLayoutFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	layoutDocFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listLayoutsFn: vi.fn<() => Promise<unknown>>(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { LayoutsAdminConsolePage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const row = (over: Record<string, unknown> = {}) => ({
	id: 1,
	name: "landing",
	description: "Landing body",
	sectionCount: 2,
	updatedAt: new Date().toISOString(),
	...over,
});

afterEach(cleanup);

describe("LayoutsAdminConsolePage", () => {
	it("renders the empty console when loader data is missing", () => {
		render(<LayoutsAdminConsolePage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Layouts")).toBeTruthy();
		expect(screen.getByText("No layouts yet")).toBeTruthy();
	});

	it("narrows loader rows into the admin view", () => {
		render(<LayoutsAdminConsolePage data={[row({})]} ctx={ctx} />);
		expect(screen.getByText("landing")).toBeTruthy();
		expect(screen.getByText("Landing body")).toBeTruthy();
		expect(screen.getByText("2")).toBeTruthy();
	});

	it("drops malformed rows and survives non-array data", () => {
		render(
			<LayoutsAdminConsolePage
				data={[row({}), { nope: true }, "x", null, row({ id: 2, updatedAt: 5 })]}
				ctx={ctx}
			/>,
		);
		expect(screen.getAllByText("landing")).toHaveLength(1);
		cleanup();
		render(<LayoutsAdminConsolePage data="garbage" ctx={ctx} />);
		expect(screen.getByText("No layouts yet")).toBeTruthy();
	});
});
