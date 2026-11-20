// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
	ColumnsBlock,
	ContainerBlock,
	CtaBlock,
	DividerBlock,
	HeadingBlock,
	MetricBlock,
	SectionBlock,
	SpacerBlock,
	TableBlock,
} from "./renderers.tsx";
import { defaultPropsFor } from "./schema-editor.tsx";
import {
	COLUMNS_FIELDS,
	CONTAINER_FIELDS,
	CTA_FIELDS,
	DIVIDER_FIELDS,
	HEADING_FIELDS,
	METRIC_FIELDS,
	SECTION_FIELDS,
	SPACER_FIELDS,
	TABLE_FIELDS,
} from "./fields.ts";

afterEach(cleanup);

describe("builder block renderers", () => {
	it("section renders a band with default padding and no content requirement", () => {
		const { container } = render(<SectionBlock value={{}} />);
		const section = container.querySelector("section");
		expect(section).not.toBeNull();
		expect(section?.className).toContain("py-6");
	});

	it("section applies muted tone", () => {
		const { container } = render(<SectionBlock value={{ tone: "muted", padding: "lg" }} />);
		const section = container.querySelector("section");
		expect(section?.className).toContain("bg-muted");
		expect(section?.className).toContain("py-12");
	});

	it("container renders a max-width column", () => {
		const { container } = render(<ContainerBlock value={{ maxWidth: "sm" }} />);
		expect(container.innerHTML).toContain("max-w-2xl");
	});

	it("columns renders one placeholder cell per column", () => {
		const { container } = render(<ColumnsBlock value={{ columns: 3, gap: "lg" }} />);
		expect(container.querySelectorAll(".border-dashed")).toHaveLength(3);
		expect(container.innerHTML).toContain("grid-cols-3");
	});

	it("columns clamps out-of-range counts", () => {
		const { container } = render(<ColumnsBlock value={{ columns: 9 }} />);
		expect(container.querySelectorAll(".border-dashed")).toHaveLength(4);
	});

	it("divider renders a separator", () => {
		const { container } = render(<DividerBlock value={{ spacing: "sm" }} />);
		expect(container.querySelector("[data-slot='separator']")).not.toBeNull();
	});

	it("spacer renders an aria-hidden sized gap", () => {
		const { container } = render(<SpacerBlock value={{ size: "xl" }} />);
		const spacer = container.firstElementChild as HTMLElement;
		expect(spacer.getAttribute("aria-hidden")).toBe("true");
		expect(spacer.className).toContain("h-24");
	});

	it("heading renders semantic level, text and alignment", () => {
		render(<HeadingBlock value={{ text: "Hello", level: "h1", align: "center" }} />);
		const heading = screen.getByRole("heading", { level: 1 });
		expect(heading.textContent).toBe("Hello");
		expect(heading.className).toContain("text-center");
	});

	it("cta renders a button by default and an anchor with href", () => {
		const { rerender } = render(<CtaBlock value={{ label: "Go" }} />);
		expect(screen.getByRole("button").textContent).toBe("Go");
		rerender(<CtaBlock value={{ label: "Go", href: "/x" }} />);
		const link = screen.getByRole("link", { name: "Go" });
		expect(link.getAttribute("href")).toBe("/x");
	});

	it("metric renders value, label and hint", () => {
		render(<MetricBlock value={{ value: 42, label: "Patients", hint: "+5%" }} />);
		expect(screen.getByText("42")).toBeTruthy();
		expect(screen.getByText("Patients")).toBeTruthy();
		expect(screen.getByText("+5%")).toBeTruthy();
	});

	it("table renders headers and rows", () => {
		render(
			<TableBlock
				value={{
					headers: ["A", "B"],
					rows: [["1", "2"], ["3", 4, null], "not-a-row"],
				}}
			/>,
		);
		expect(screen.getByText("A")).toBeTruthy();
		expect(screen.getByText("4")).toBeTruthy();
	});

	it("renderers tolerate malformed values", () => {
		for (const Block of [
			SectionBlock,
			ContainerBlock,
			ColumnsBlock,
			DividerBlock,
			SpacerBlock,
			HeadingBlock,
			CtaBlock,
			MetricBlock,
			TableBlock,
		]) {
			const { container, unmount } = render(<Block value={"garbage"} />);
			expect(container).toBeTruthy();
			unmount();
		}
	});
});

describe("defaultPropsFor", () => {
	it("collects schema defaults into a preview payload", () => {
		const props = defaultPropsFor(HEADING_FIELDS);
		expect(props).toEqual({ text: "Heading", level: "h2", align: "left" });
	});

	it("returns an empty object without fields", () => {
		expect(defaultPropsFor(undefined)).toEqual({});
	});

	it("keeps array defaults by reference for table preview", () => {
		const props = defaultPropsFor(TABLE_FIELDS);
		expect(props.headers).toEqual(["Name", "Value"]);
		expect(props.rows).toHaveLength(2);
	});

	it("covers every block schema", () => {
		for (const fields of [
			SECTION_FIELDS,
			CONTAINER_FIELDS,
			COLUMNS_FIELDS,
			DIVIDER_FIELDS,
			SPACER_FIELDS,
			HEADING_FIELDS,
			CTA_FIELDS,
			METRIC_FIELDS,
			TABLE_FIELDS,
		]) {
			expect(defaultPropsFor(fields)).toBeTypeOf("object");
		}
	});
});
