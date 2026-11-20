// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Puck's real header gates its publish button behind viewport/menu
// state that jsdom can't reach — stub <Puck> with a button that invokes
// the same onPublish prop the real header's Publish button calls.
vi.mock("@puckeditor/core", () => ({
	Puck: (props: {
		readonly onPublish?: (data: unknown) => void;
		readonly data?: unknown;
		readonly headerTitle?: string;
	}) => (
		<div className="Puck">
			<button type="button" onClick={() => props.onPublish?.(props.data)}>
				Publish
			</button>
		</div>
	),
}));

vi.mock("./fns.ts", () => ({
	saveBuilderDocumentFn: vi.fn(() => Promise.resolve(true)),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { saveBuilderDocumentFn } from "./fns.ts";
import { SiteBuilderEditorPage } from "./editor-page.tsx";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const ctx = (plugins: readonly unknown[] = []): PanelPageContext =>
	({ plugins, locale: "en" }) as unknown as PanelPageContext;

const wire = {
	kind: "page" as const,
	id: 7,
	title: "About",
	subtitle: "/about",
	builderJson: null,
};

const publish = () => fireEvent.click(screen.getByRole("button", { name: "Publish" }));

describe("SiteBuilderEditorPage publish", () => {
	it("serializes the document and reflects the save state", async () => {
		let resolveSave: (value: boolean) => void = () => {};
		vi.mocked(saveBuilderDocumentFn).mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					resolveSave = resolve;
				}),
		);
		render(<SiteBuilderEditorPage data={wire} ctx={ctx()} />);

		publish();
		// Deferred save keeps the "saving" label observable.
		expect(await screen.findByText("Saving…")).toBeDefined();
		expect(saveBuilderDocumentFn).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ kind: "page", id: 7 }),
			}),
		);
		const sent = vi.mocked(saveBuilderDocumentFn).mock.calls[0]![0] as {
			data: { builderJson: string };
		};
		expect(JSON.parse(sent.data.builderJson).version).toBe(1);

		resolveSave(true);
		expect(await screen.findByText("Saved")).toBeDefined();
	});

	it("shows the error label when the save resolves false or rejects", async () => {
		vi.mocked(saveBuilderDocumentFn)
			.mockImplementationOnce(() => Promise.resolve(false))
			.mockImplementationOnce(() => Promise.reject(new Error("boom")));
		render(<SiteBuilderEditorPage data={wire} ctx={ctx()} />);

		publish();
		expect(await screen.findByText("Save failed")).toBeDefined();

		publish();
		expect(await screen.findByText("Save failed")).toBeDefined();
	});
});
