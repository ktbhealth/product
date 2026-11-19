// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
}));

vi.mock("./fns.ts", () => ({
	createSchemaFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateSchemaFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteSchemaFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	schemaDocFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listSchemasFn: vi.fn<() => Promise<unknown>>(),
	validateSchemaFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { SchemasAdminConsolePage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const row = (over: Record<string, unknown> = {}) => ({
	id: 1,
	name: "page-search",
	description: "Page search params",
	updatedAt: new Date().toISOString(),
	...over,
});

afterEach(cleanup);

describe("SchemasAdminConsolePage", () => {
	it("renders the empty console when loader data is missing", () => {
		render(<SchemasAdminConsolePage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Schemas")).toBeTruthy();
		expect(screen.getByText("No schemas yet")).toBeTruthy();
	});

	it("narrows loader rows into the admin view", () => {
		render(<SchemasAdminConsolePage data={[row({})]} ctx={ctx} />);
		expect(screen.getByText("page-search")).toBeTruthy();
		expect(screen.getByText("Page search params")).toBeTruthy();
	});

	it("drops malformed rows and survives non-array data", () => {
		render(
			<SchemasAdminConsolePage
				data={[row({}), { nope: true }, "x", null, row({ id: 2, updatedAt: 5 })]}
				ctx={ctx}
			/>,
		);
		expect(screen.getAllByText("page-search")).toHaveLength(1);
		cleanup();
		render(<SchemasAdminConsolePage data="garbage" ctx={ctx} />);
		expect(screen.getByText("No schemas yet")).toBeTruthy();
	});
});
