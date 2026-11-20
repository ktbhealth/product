// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
}));

vi.mock("./fns.ts", () => ({
	saveTemplateFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateTemplateFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteTemplateFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	templateDocFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listTemplatesFn: vi.fn<() => Promise<unknown>>(),
	instantiateTemplateFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { TemplatesAdminConsolePage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const row = (over: Record<string, unknown> = {}) => ({
	id: 1,
	kind: "layout",
	name: "landing",
	description: "Landing snapshot",
	createdBy: "admin@x.com",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	...over,
});

const data = (over: Record<string, unknown> = {}) => ({
	rows: [row({})],
	kinds: [{ kind: "layout", label: "Layout" }],
	...over,
});

afterEach(cleanup);

describe("TemplatesAdminConsolePage", () => {
	it("renders the empty console when loader data is missing", () => {
		render(<TemplatesAdminConsolePage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Templates")).toBeTruthy();
		expect(screen.getByText("No templates yet")).toBeTruthy();
	});

	it("narrows loader rows and kinds into the admin view", () => {
		render(<TemplatesAdminConsolePage data={data({})} ctx={ctx} />);
		expect(screen.getByText("landing")).toBeTruthy();
		expect(screen.getByText("Landing snapshot")).toBeTruthy();
		// Grouped under the registered kind label.
		expect(screen.getByText(/Layout \(1\)/)).toBeTruthy();
	});

	it("drops malformed rows and survives non-object data", () => {
		render(
			<TemplatesAdminConsolePage
				data={data({ rows: [row({}), { nope: true }, "x", null, row({ id: 2, updatedAt: 5 })] })}
				ctx={ctx}
			/>,
		);
		expect(screen.getAllByText("landing")).toHaveLength(1);
		cleanup();
		render(<TemplatesAdminConsolePage data="garbage" ctx={ctx} />);
		expect(screen.getByText("No templates yet")).toBeTruthy();
	});
});
