// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { PanelPageContext, Plugin } from "@ktb/kernel";

import { ComponentsCatalogPage } from "./catalog-page.tsx";
import { BUILDER_BLOCK_KINDS } from "./kinds.tsx";

afterEach(cleanup);

const ctxWith = (plugins: readonly Plugin[]): PanelPageContext => ({
	plugins,
	locale: "en",
});

const elementsPlugin = {
	id: "test.elements",
	elementKinds: BUILDER_BLOCK_KINDS,
} as Plugin;

describe("ComponentsCatalogPage", () => {
	it("lists every registered kind with label, kind id and category", () => {
		render(<ComponentsCatalogPage data={null} ctx={ctxWith([elementsPlugin])} />);
		expect(screen.getByRole("heading", { name: "Components" })).toBeTruthy();
		expect(screen.getByText("Section")).toBeTruthy();
		expect(screen.getByText("Call to action")).toBeTruthy();
		expect(screen.getByText("table")).toBeTruthy();
		expect(screen.getByText("9 components")).toBeTruthy();
	});

	it("renders live previews through each kind's renderer", () => {
		render(<ComponentsCatalogPage data={null} ctx={ctxWith([elementsPlugin])} />);
		// heading preview uses schema defaults → an h2 "Heading"
		expect(screen.getByRole("heading", { name: "Heading", level: 2 })).toBeTruthy();
		// metric preview shows the default value
		expect(screen.getByText("1,234")).toBeTruthy();
	});

	it("documents prop schemas", () => {
		render(<ComponentsCatalogPage data={null} ctx={ctxWith([elementsPlugin])} />);
		expect(screen.getAllByText("Props").length).toBeGreaterThan(0);
		expect(screen.getByText("maxWidth")).toBeTruthy();
		expect(screen.getAllByText(/required/).length).toBeGreaterThan(0);
	});

	it("filters kinds by the search box", () => {
		render(<ComponentsCatalogPage data={null} ctx={ctxWith([elementsPlugin])} />);
		const input = screen.getByPlaceholderText("Filter components…");
		fireEvent.change(input, { target: { value: "table" } });
		expect(screen.getByText("Table")).toBeTruthy();
		expect(screen.queryByText("Section")).toBeNull();
	});

	it("shows the empty state when nothing matches", () => {
		render(<ComponentsCatalogPage data={null} ctx={ctxWith([elementsPlugin])} />);
		fireEvent.change(screen.getByPlaceholderText("Filter components…"), {
			target: { value: "zzz-no-match" },
		});
		expect(screen.getByText("No components found")).toBeTruthy();
	});

	it("ignores non-kind payloads and renders kinds from multiple plugins", () => {
		const other = {
			id: "other.plugin",
			elementKinds: [
				null,
				"not-an-object",
				42,
				{ kind: 7, label: "bad kind" },
				{ kind: "no-label" },
				{ kind: "rich-text", label: "Rich text" },
			],
		} as Plugin;
		render(<ComponentsCatalogPage data={null} ctx={ctxWith([elementsPlugin, other])} />);
		expect(screen.getByText("Rich text")).toBeTruthy();
		expect(screen.getByText("10 components")).toBeTruthy();
		// filtering also exercises the description-less kind path
		fireEvent.change(screen.getByPlaceholderText("Filter components…"), {
			target: { value: "rich" },
		});
		expect(screen.getByText("Rich text")).toBeTruthy();
		expect(screen.getByText("1 component")).toBeTruthy();
	});

	it("groups every category lane and tolerates exotic prop schemas", () => {
		const extra = {
			id: "extra.plugin",
			elementKinds: [
				{
					kind: "hero-image",
					label: "Hero image",
					description: "A media block",
					category: "media",
					fields: {
						type: "object",
						properties: {
							src: { type: "string" },
							anything: {},
							flag: true,
						},
					},
					renderer: ({ value }: { value: unknown }) => <div>{String(value)}</div>,
				},
				{
					kind: "patient-card",
					label: "Patient card",
					description: "A domain block",
					category: "domain",
				},
				{
					kind: "misc",
					label: "Misc",
					category: "custom-lane",
				},
			],
		} as Plugin;
		render(<ComponentsCatalogPage data={null} ctx={ctxWith([extra])} />);
		// group heading + per-card badge share the label → expect multiples
		expect(screen.getAllByText("Media").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Domain").length).toBeGreaterThan(0);
		// unknown category falls back to the "Other" group
		expect(screen.getAllByText("Other").length).toBeGreaterThan(0);
		// prop rows cover type-less and boolean schemas (name column +
		// title column can repeat the same string)
		expect(screen.getAllByText("anything").length).toBeGreaterThan(0);
		expect(screen.getAllByText("flag").length).toBeGreaterThan(0);
	});
});
