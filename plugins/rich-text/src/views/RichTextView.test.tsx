// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RichTextView } from "./RichTextView.tsx";

const doc = (nodes: unknown[]) => nodes;

afterEach(cleanup);

describe("RichTextView", () => {
	it("renders paragraphs, headings and marks", () => {
		render(
			<RichTextView
				value={doc([
					{ type: "h2", children: [{ text: "Title" }] },
					{ type: "h3", children: [{ text: "Sub" }] },
					{
						type: "p",
						children: [
							{ text: "plain " },
							{ text: "bold", bold: true },
							{ text: " " },
							{ text: "ital", italic: true },
							{ text: " " },
							{ text: "under", underline: true },
						],
					},
				])}
			/>,
		);
		expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeTruthy();
		expect(screen.getByRole("heading", { level: 3, name: "Sub" })).toBeTruthy();
		expect(screen.getByText("bold").tagName).toBe("STRONG");
		expect(screen.getByText("ital").tagName).toBe("EM");
		expect(screen.getByText("under").tagName).toBe("U");
	});

	it("renders safe links as anchors and unsafe hrefs as text", () => {
		const { container } = render(
			<RichTextView
				value={doc([
					{
						type: "p",
						children: [
							{
								type: "a",
								url: "https://example.com",
								children: [{ text: "good" }],
							},
							{ text: " " },
							{ type: "a", url: "javascript:alert(1)", children: [{ text: "bad" }] },
						],
					},
				])}
			/>,
		);
		const link = screen.getByText("good").closest("a");
		expect(link?.getAttribute("href")).toBe("https://example.com");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(screen.getByText("bad").closest("a")).toBeNull();
		expect(container.querySelectorAll("a")).toHaveLength(1);
	});

	it("unwraps unknown inline elements to their children", () => {
		render(
			<RichTextView
				value={doc([
					{
						type: "p",
						children: [{ type: "mention", children: [{ text: "inner" }] }],
					},
				])}
			/>,
		);
		expect(screen.getByText("inner")).toBeTruthy();
	});

	it("renders flat and nested lists with style splits and start", () => {
		const { container } = render(
			<RichTextView
				value={doc([
					{ type: "p", listStyleType: "disc", children: [{ text: "one" }] },
					{ type: "p", listStyleType: "disc", indent: 2, children: [{ text: "nested" }] },
					{ type: "p", listStyleType: "decimal", listStart: 3, children: [{ text: "three" }] },
					{ type: "p", listStyleType: "decimal", children: [{ text: "four" }] },
				])}
			/>,
		);
		const uls = container.querySelectorAll("ul");
		expect(uls).toHaveLength(2); // outer + nested
		const ols = container.querySelectorAll("ol");
		expect(ols).toHaveLength(1);
		expect(ols[0]!.getAttribute("start")).toBe("3");
		expect(screen.getByText("three")).toBeTruthy();
		expect(screen.getByText("four")).toBeTruthy();
		// The nested item lives in the inner <ul>, not the outer one.
		expect(screen.getByText("nested").closest("ul")).not.toBe(uls[0]);
	});

	it("renders top-level text nodes and unknown blocks", () => {
		render(
			<RichTextView
				value={doc([
					{ text: "loose" },
					{
						type: "section",
						children: [{ type: "p", children: [{ text: "inner block" }] }],
					},
				])}
			/>,
		);
		expect(screen.getByText("loose").closest("p")).toBeTruthy();
		expect(screen.getByText("inner block")).toBeTruthy();
	});

	it("renders nothing meaningful for invalid or empty values", () => {
		const { container, rerender } = render(<RichTextView value={null} />);
		expect(container.querySelector("p")).toBeNull();
		rerender(<RichTextView value="garbage" />);
		expect(container.querySelector("p")).toBeNull();
		rerender(<RichTextView value={[]} />);
		expect(container.querySelector("p")).toBeNull();
		// Canonical empty doc renders an empty paragraph (layout stability).
		rerender(<RichTextView value={[{ type: "p", children: [{ text: "" }] }]} />);
		expect(container.querySelector("p")).toBeTruthy();
	});
});
