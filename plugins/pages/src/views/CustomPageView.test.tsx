// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerState = vi.hoisted(() => ({ search: {} as Record<string, unknown> }));
const fns = vi.hoisted(() => ({
	validatePageSearchFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

// The real RichTextView lives in @ktb/rich-text (a sibling plugin that
// may not be installed in this workspace yet) — stub it and assert the
// view forwards the resolved document value.
vi.mock("@ktb/rich-text/views", () => ({
	RichTextView: ({ value }: { value: unknown }) => (
		<div data-testid="rich-text-view">{JSON.stringify(value)}</div>
	),
}));
vi.mock("@tanstack/react-router", () => ({
	useSearch: () => routerState.search,
}));
vi.mock("../fns.ts", () => fns);

import type { PageContext } from "@ktb/kernel";

import { CustomPageView } from "./CustomPageView.tsx";

const ctx: PageContext = { plugins: [], locale: "en" };

const DOC = [{ type: "p", children: [{ text: "Hello" }] }];

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	routerState.search = {};
});

describe("CustomPageView", () => {
	it("renders the title and the resolved rich-text content", () => {
		render(
			<CustomPageView
				data={{
					path: "/about",
					title: "About us",
					content: DOC,
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("About us")).toBeTruthy();
		expect(screen.getByTestId("rich-text-view").textContent).toBe(JSON.stringify(DOC));
	});

	it("renders the title with a null body when the page has no document", () => {
		render(<CustomPageView data={{ path: "/x", title: "Empty", content: null }} ctx={ctx} />);
		expect(screen.getByText("Empty")).toBeTruthy();
		expect(screen.getByTestId("rich-text-view").textContent).toBe("null");
	});

	it("renders nothing for missing or malformed data", () => {
		const { container, rerender } = render(<CustomPageView data={null} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
		rerender(<CustomPageView data="nope" ctx={ctx} />);
		expect(container.innerHTML).toBe("");
		rerender(<CustomPageView data={{ title: 42 }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
		// content must be an array or null — a stray string is malformed.
		rerender(<CustomPageView data={{ title: "T", content: "# md" }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
	});

	it("skips search validation when the page binds no schema", async () => {
		routerState.search = { q: "x" };
		const { container } = render(
			<CustomPageView data={{ path: "/about", title: "About", content: null }} ctx={ctx} />,
		);
		expect(fns.validatePageSearchFn).not.toHaveBeenCalled();
		expect(container.querySelector("article")?.getAttribute("data-validated-search")).toBeNull();
	});

	it("validates search params through the fn and exposes the cleaned set", async () => {
		routerState.search = { q: "x", bad: "y" };
		fns.validatePageSearchFn.mockResolvedValue({ search: { q: "x" } });
		const { container } = render(
			<CustomPageView
				data={{ path: "/search", title: "Search", content: null, searchSchemaId: 3 }}
				ctx={ctx}
			/>,
		);
		await waitFor(() =>
			expect(fns.validatePageSearchFn).toHaveBeenCalledWith({
				data: { path: "/search", search: { q: "x", bad: "y" } },
			}),
		);
		await waitFor(() =>
			expect(container.querySelector("article")?.getAttribute("data-validated-search")).toBe(
				JSON.stringify({ q: "x" }),
			),
		);
	});

	it("passes the raw search through when validation fails", async () => {
		routerState.search = { q: "x" };
		fns.validatePageSearchFn.mockRejectedValue(new Error("boom"));
		const { container } = render(
			<CustomPageView
				data={{ path: "/search", title: "Search", content: null, searchSchemaId: 3 }}
				ctx={ctx}
			/>,
		);
		await waitFor(() =>
			expect(container.querySelector("article")?.getAttribute("data-validated-search")).toBe(
				JSON.stringify({ q: "x" }),
			),
		);
	});
});
