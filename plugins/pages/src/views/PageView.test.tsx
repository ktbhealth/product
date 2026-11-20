// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The real RichTextView lives in @ktb/rich-text (a sibling plugin that
// may not be installed in this workspace yet) — stub it and assert the
// view forwards the resolved document value.
vi.mock("@ktb/rich-text/views", () => ({
	RichTextView: ({ value }: { value: unknown }) => (
		<div data-testid="rich-text-view">{JSON.stringify(value)}</div>
	),
}));

import type { PageContext } from "@ktb/kernel";

import { PageView } from "./PageView.tsx";

const ctx: PageContext = { plugins: [], locale: "en" };

const DOC = [{ type: "p", children: [{ text: "Hello" }] }];

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PageView", () => {
	it("renders the title and the resolved rich-text content", () => {
		render(
			<PageView
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
		render(<PageView data={{ path: "/x", title: "Empty", content: null }} ctx={ctx} />);
		expect(screen.getByText("Empty")).toBeTruthy();
		expect(screen.getByTestId("rich-text-view").textContent).toBe("null");
	});

	it("renders nothing for missing or malformed data", () => {
		const { container, rerender } = render(<PageView data={null} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
		rerender(<PageView data="nope" ctx={ctx} />);
		expect(container.innerHTML).toBe("");
		rerender(<PageView data={{ title: 42 }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
		// content must be an array or null — a stray string is malformed.
		rerender(<PageView data={{ title: "T", content: "# md" }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
	});

	it("omits data-validated-search when the loader supplies no search", () => {
		const { container } = render(
			<PageView data={{ path: "/about", title: "About", content: null }} ctx={ctx} />,
		);
		expect(container.querySelector("article")?.getAttribute("data-validated-search")).toBeNull();
	});

	it("exposes the loader-cleaned search synchronously", () => {
		const { container } = render(
			<PageView
				data={{
					path: "/search",
					title: "Search",
					content: null,
					searchSchemaId: 3,
					search: { q: "x" },
				}}
				ctx={ctx}
			/>,
		);
		// No effect/round-trip: the attribute is present on first render.
		expect(container.querySelector("article")?.getAttribute("data-validated-search")).toBe(
			JSON.stringify({ q: "x" }),
		);
	});

	it("treats a non-record search field as absent", () => {
		const { container } = render(
			<PageView
				data={{ path: "/search", title: "Search", content: null, search: "bad" }}
				ctx={ctx}
			/>,
		);
		expect(container.querySelector("article")?.getAttribute("data-validated-search")).toBeNull();
	});

	it("renders layout sections instead of the single document when present", () => {
		const { container } = render(
			<PageView
				data={{
					path: "/layout",
					title: "Layout page",
					content: DOC,
					layoutSections: [
						{ id: "s1", title: "Hero", content: DOC },
						{ id: "s2", title: "Body", content: [{ type: "p", children: [{ text: "Second" }] }] },
					],
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("Hero")).toBeTruthy();
		expect(screen.getByText("Body")).toBeTruthy();
		// Both section bodies render through RichTextView; the single
		// `content` document is NOT rendered in layout mode.
		const views = screen.getAllByTestId("rich-text-view");
		expect(views).toHaveLength(2);
		expect(views[0]!.textContent).toBe(JSON.stringify(DOC));
		expect(container.querySelectorAll("section")).toHaveLength(2);
	});

	it("renders an empty body for a layout with no resolved sections", () => {
		render(
			<PageView
				data={{ path: "/layout", title: "Empty layout", content: DOC, layoutSections: [] }}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("Empty layout")).toBeTruthy();
		// Empty array still wins over `content` — no fallback doc.
		expect(screen.queryByTestId("rich-text-view")).toBeNull();
	});

	it("falls back to the single document when layoutSections is null or malformed", () => {
		render(
			<PageView data={{ path: "/x", title: "T", content: DOC, layoutSections: null }} ctx={ctx} />,
		);
		expect(screen.getByTestId("rich-text-view").textContent).toBe(JSON.stringify(DOC));
		cleanup();
		render(
			<PageView data={{ path: "/x", title: "T", content: DOC, layoutSections: "bad" }} ctx={ctx} />,
		);
		expect(screen.getByTestId("rich-text-view").textContent).toBe(JSON.stringify(DOC));
		cleanup();
		// Sections missing a string title are dropped.
		render(
			<PageView
				data={{
					path: "/x",
					title: "T",
					content: DOC,
					layoutSections: [
						{ title: 42, content: DOC },
						{ title: "Ok", content: DOC },
					],
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("Ok")).toBeTruthy();
		expect(screen.getAllByTestId("rich-text-view")).toHaveLength(1);
	});

	it("maps a section missing content to a null body", () => {
		render(
			<PageView
				data={{
					path: "/x",
					title: "T",
					content: DOC,
					layoutSections: [{ title: "Slot" }],
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("Slot")).toBeTruthy();
		// `content ?? null` — the slot renders through RichTextView with
		// a null body rather than `undefined`.
		expect(screen.getByTestId("rich-text-view").textContent).toBe("null");
	});
});
