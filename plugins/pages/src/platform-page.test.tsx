// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
	Link: ({ to, children, ...props }: Record<string, unknown>) => (
		<a href={String(to)} {...props}>
			{children as React.ReactNode}
		</a>
	),
}));

vi.mock("./fns.ts", () => ({
	createPageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updatePageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deletePageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	navPagesFn: vi.fn<() => Promise<unknown>>(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { PagesAdminConsolePage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const row = (over: Record<string, unknown> = {}) => ({
	id: 1,
	path: "/about",
	title: "About",
	richTextId: 7,
	published: true,
	showInNav: false,
	sortOrder: 0,
	createdAt: new Date(),
	updatedAt: new Date(),
	...over,
});

afterEach(cleanup);

describe("PagesAdminConsolePage", () => {
	it("renders the empty console when loader data is missing", () => {
		render(<PagesAdminConsolePage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Pages")).toBeTruthy();
		expect(screen.getByText("No custom pages yet")).toBeTruthy();
	});

	it("narrows loader rows into the admin view", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminConsolePage
				data={{
					pages: [row({})],
					docs: [{ id: 7, title: "Doc" }],
					richTextEnabled: true,
					layouts: [{ id: 5, name: "Landing", description: null }, { nope: true }, "x"],
					layoutEnabled: true,
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("/about")).toBeTruthy();
		expect(screen.getByText("About")).toBeTruthy();
		expect(screen.getByText("Published")).toBeTruthy();
		// The flags reach the view: the content-document and layout
		// fields render (malformed layout entries are dropped).
		await user.click(screen.getByText("New page"));
		expect(screen.getByRole("combobox", { name: "Content document" })).toBeTruthy();
		expect(screen.getByRole("combobox", { name: "Layout" })).toBeTruthy();
	});

	it("drops malformed rows and docs, and survives non-object data", () => {
		render(
			<PagesAdminConsolePage
				data={{
					pages: [row({}), { nope: true }, "x", null],
					docs: [{ id: 7, title: "Doc" }, { nope: true }, "x"],
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getAllByText("/about")).toHaveLength(1);
		cleanup();
		render(<PagesAdminConsolePage data="garbage" ctx={ctx} />);
		expect(screen.getByText("No custom pages yet")).toBeTruthy();
		cleanup();
		// A bare array (the pre-docs loader shape) narrows to empty.
		render(<PagesAdminConsolePage data={[row({})]} ctx={ctx} />);
		expect(screen.getByText("No custom pages yet")).toBeTruthy();
	});

	it("narrows the schema picker options and drops malformed entries", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminConsolePage
				data={{
					pages: [],
					schemas: [
						{ id: 3, name: "Filters", description: "Query params" },
						{ id: 4, name: "Sort", description: null },
						{ id: 5, name: "Bad", description: 42 },
						{ id: "x", name: "BadId" },
						{ id: 6 },
						"nope",
						null,
					],
					searchSchemaEnabled: true,
				}}
				ctx={ctx}
			/>,
		);
		await user.click(screen.getByText("New page"));
		await user.click(screen.getByRole("combobox", { name: "Search schema" }));
		// Only well-formed schema rows survive the narrowing filter.
		expect(await screen.findByRole("option", { name: "Filters" })).toBeTruthy();
		expect(screen.getByRole("option", { name: "Sort" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: "Bad" })).toBeNull();
		expect(screen.queryByRole("option", { name: "BadId" })).toBeNull();
	});
});
