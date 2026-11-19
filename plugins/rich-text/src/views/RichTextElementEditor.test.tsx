// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const editor = vi.hoisted(() => ({
	props: null as null | { value?: string; onChange?: (html: string) => void },
}));

// The real module pulls platejs — stub the editor surface the
// component adapts (same seam the admin pane test uses).
vi.mock("@ktbhealth/ui/components/rich-text-editor", () => ({
	RichTextEditor: (props: { value?: string; onChange?: (html: string) => void }) => {
		editor.props = props;
		return <div data-testid="rich-text-editor" />;
	},
	richTextToHtml: (value: unknown) => `<p>${JSON.stringify(value)}</p>`,
	htmlToRichText: (html: string) => [{ type: "p", children: [{ text: html }] }],
}));

import { RichTextElementEditor } from "./RichTextElementEditor.tsx";

afterEach(cleanup);

describe("RichTextElementEditor", () => {
	it("seeds the editor from the stored Plate value", () => {
		render(
			<RichTextElementEditor
				value={[{ type: "p", children: [{ text: "hi" }] }]}
				onChange={() => {}}
			/>,
		);
		expect(screen.getByTestId("rich-text-editor")).toBeTruthy();
		expect(editor.props?.value).toBe('<p>[{"type":"p","children":[{"text":"hi"}]}]</p>');
	});

	it("falls back to the canonical empty doc for nullish values", () => {
		for (const value of [null, undefined]) {
			const { unmount } = render(<RichTextElementEditor value={value} onChange={() => {}} />);
			expect(editor.props?.value).toBe('<p>[{"type":"p","children":[{"text":""}]}]</p>');
			unmount();
		}
	});

	it("emits the converted Plate value when the editor changes", () => {
		const onChange = vi.fn<(value: unknown) => void>();
		render(<RichTextElementEditor value={[]} onChange={onChange} />);
		act(() => editor.props?.onChange?.("<p>edited</p>"));
		expect(onChange).toHaveBeenCalledWith([{ type: "p", children: [{ text: "<p>edited</p>" }] }]);
	});
});
