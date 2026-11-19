// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
	useLocation: () => ({ state: { key: "k" } }),
}));

vi.mock("@ktbhealth/ui/components/rich-text-editor", () => ({
	RichTextEditor: () => <div />,
	htmlToRichText: () => [{ type: "p", children: [{ text: "" }] }],
	richTextToHtml: () => "",
}));

vi.mock("./fns.ts", () => ({
	createRichTextFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateRichTextFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteRichTextFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	richTextDocFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listRichTextDocsFn: vi.fn<() => Promise<unknown>>(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { RichTextAdminConsolePage } from "./platform-page.tsx";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

const row = (over: Record<string, unknown> = {}) => ({
	id: 1,
	title: "Doc",
	updatedAt: new Date().toISOString(),
	...over,
});

afterEach(cleanup);

describe("RichTextAdminConsolePage", () => {
	it("renders the empty console when loader data is missing", () => {
		render(<RichTextAdminConsolePage data={undefined} ctx={ctx} />);
		expect(screen.getByText("Rich text")).toBeTruthy();
		expect(screen.getByText("No documents yet")).toBeTruthy();
	});

	it("narrows loader rows into the admin view", () => {
		render(<RichTextAdminConsolePage data={[row({})]} ctx={ctx} />);
		expect(screen.getByText("Doc")).toBeTruthy();
	});

	it("drops malformed rows and survives non-array data", () => {
		render(
			<RichTextAdminConsolePage
				data={[row({}), { nope: true }, "x", null, row({ id: 2, updatedAt: 5 })]}
				ctx={ctx}
			/>,
		);
		expect(screen.getAllByText("Doc")).toHaveLength(1);
		cleanup();
		render(<RichTextAdminConsolePage data="garbage" ctx={ctx} />);
		expect(screen.getByText("No documents yet")).toBeTruthy();
	});
});
