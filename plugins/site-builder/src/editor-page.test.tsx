// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Puck's dnd-kit deps touch ResizeObserver/matchMedia at import time —
// hoisted so the stubs exist before editor-page.tsx evaluates.
vi.hoisted(() => {
	(globalThis as Record<string, unknown>).ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	window.matchMedia ??= ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	})) as typeof window.matchMedia;
});

import type { PanelPageContext } from "@ktb/kernel";
import { builderDocFromData, serializeBuilderDoc } from "@ktb/builder";

// The editor calls saveBuilderDocumentFn on publish — stub the fn
// module so tests never touch the server-fn runtime.
vi.mock("./fns.ts", () => ({
	saveBuilderDocumentFn: vi.fn(() => Promise.resolve(true)),
}));

import { SiteBuilderEditorPage } from "./editor-page.tsx";

afterEach(cleanup);

const ctx = (plugins: readonly unknown[] = []): PanelPageContext =>
	({ plugins, locale: "en" }) as unknown as PanelPageContext;

const wire = {
	kind: "page" as const,
	id: 7,
	title: "About",
	subtitle: "/about",
	builderJson: null,
};

describe("SiteBuilderEditorPage", () => {
	it("renders the not-found state for malformed loader data", () => {
		for (const data of [
			null,
			"x",
			{ kind: "bogus", id: 1, title: "t" },
			{ kind: "page" },
			{ kind: "page", id: "7", title: "t" },
			{ kind: "page", id: 7 },
			{ kind: "page", id: 7, title: "t", subtitle: {} },
			{ kind: "page", id: 7, title: "t", builderJson: 42 },
		]) {
			const { container, unmount } = render(<SiteBuilderEditorPage data={data} ctx={ctx()} />);
			expect(container.textContent).toContain("Nothing to edit here.");
			unmount();
		}
	});

	it("mounts the Puck editor with the entity header for a page", () => {
		const { container } = render(<SiteBuilderEditorPage data={wire} ctx={ctx()} />);
		// The title renders in our header AND Puck's headerTitle.
		expect(screen.getAllByText("About").length).toBeGreaterThan(0);
		expect(screen.getByText("/about")).toBeDefined();
		expect(screen.getByText("Publish to save changes")).toBeDefined();
		expect(container.querySelector(".Puck")).not.toBeNull();
	});

	it("mounts for a layout target", () => {
		render(
			<SiteBuilderEditorPage
				data={{ kind: "layout", id: 3, title: "Landing", subtitle: null, builderJson: null }}
				ctx={ctx()}
			/>,
		);
		expect(screen.getAllByText("Landing").length).toBeGreaterThan(0);
	});

	it("opens a stored builder document", () => {
		const builderJson = serializeBuilderDoc(
			builderDocFromData({ root: { props: {} }, content: [], zones: {} }),
		);
		render(<SiteBuilderEditorPage data={{ ...wire, builderJson }} ctx={ctx()} />);
		expect(screen.getAllByText("About").length).toBeGreaterThan(0);
		expect(screen.getByText("Publish to save changes")).toBeDefined();
	});

	it("falls back to an empty document for malformed Puck data", () => {
		const builderJson = serializeBuilderDoc(builderDocFromData({ content: [{}] }));
		render(<SiteBuilderEditorPage data={{ ...wire, builderJson }} ctx={ctx()} />);
		expect(screen.getAllByText("About").length).toBeGreaterThan(0);
		expect(screen.getByText("Publish to save changes")).toBeDefined();
	});
});
