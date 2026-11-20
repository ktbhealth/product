// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PanelPageContext } from "@ktb/kernel";

// The lazy boundary must not pull @puckeditor/core into this test's
// module graph — stub the editor chunk itself.
vi.mock("./editor-page.tsx", () => ({
	SiteBuilderEditorPage: ({ data }: { data: unknown }) => (
		<div data-testid="editor">{JSON.stringify(data)}</div>
	),
}));

import { SiteBuilderEditorPage } from "./editor-lazy.tsx";

describe("SiteBuilderEditorPage (lazy)", () => {
	it("loads the editor chunk and forwards data/ctx", async () => {
		const data = { kind: "page", id: 7 };
		const ctx = { locale: "en" } as unknown as PanelPageContext;
		render(<SiteBuilderEditorPage data={data} ctx={ctx} />);
		const editor = await screen.findByTestId("editor");
		expect(editor.textContent).toBe(JSON.stringify(data));
	});
});
