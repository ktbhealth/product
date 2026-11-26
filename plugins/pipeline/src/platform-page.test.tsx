// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelPageContext } from "@ktb/kernel";

const listSeen = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }));
vi.mock("./views/PipelinesPage.tsx", () => ({
	PipelinesPage: (props: Record<string, unknown>) => {
		listSeen.last = props;
		return null;
	},
}));
const editorSeen = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }));
vi.mock("./views/OrchestrationEditorPage.tsx", () => ({
	OrchestrationEditorPage: (props: Record<string, unknown>) => {
		editorSeen.last = props;
		return null;
	},
}));

import { OrchestrationEditorPanelPage, PipelinesAdminPage } from "./platform-page.tsx";

const ctx = { i18n: undefined, locale: "en", plugins: [] } as unknown as PanelPageContext;

afterEach(cleanup);

describe("PipelinesAdminPage", () => {
	it("narrows loader data into view props", () => {
		const rows = [
			{ id: "demo", version: "1", nodeCount: 2, enabled: true, createdAt: 1, updatedAt: 2 },
		];
		render(<PipelinesAdminPage data={{ rows }} ctx={ctx} />);
		expect(listSeen.last?.rows).toEqual(rows);
		expect(listSeen.last?.locale).toBe("en");
	});

	it("degrades malformed loader data to an empty table", () => {
		render(<PipelinesAdminPage data={null} ctx={ctx} />);
		expect(listSeen.last?.rows).toEqual([]);
	});
});

describe("OrchestrationEditorPanelPage", () => {
	const def = { id: "demo", nodes: [] };

	it("passes edit mode, the stored def and the kind palette", () => {
		render(
			<OrchestrationEditorPanelPage
				data={{ mode: "edit", def: { def }, kinds: ["ai", "emit"] }}
				ctx={ctx}
			/>,
		);
		expect(editorSeen.last).toMatchObject({ mode: "edit", def, kinds: ["ai", "emit"] });
	});

	it("passes new mode with a null def", () => {
		render(<OrchestrationEditorPanelPage data={{ mode: "new", def: null, kinds: [] }} ctx={ctx} />);
		expect(editorSeen.last).toMatchObject({ mode: "new", def: null, kinds: [] });
	});

	it("missing records arrive as a null def in edit mode", () => {
		render(
			<OrchestrationEditorPanelPage data={{ mode: "edit", def: null, kinds: [] }} ctx={ctx} />,
		);
		expect(editorSeen.last).toMatchObject({ mode: "edit", def: null });
	});

	it("degrades absent loader data to edit mode with no kinds", () => {
		render(<OrchestrationEditorPanelPage data={null} ctx={ctx} />);
		expect(editorSeen.last).toMatchObject({ mode: "edit", def: null, kinds: [] });
	});
});
