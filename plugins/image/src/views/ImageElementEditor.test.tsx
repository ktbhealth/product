// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	listImagesFn: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../fns.ts", () => fns);

// The real Select is a Base UI popover — stub it to a button that
// fires onValueChange so the fit-change path is exercisable in jsdom.
vi.mock("@ktbhealth/ui/components/select", () => ({
	Select: (props: { onValueChange?: (v: string) => void; children?: React.ReactNode }) => (
		<div>
			<button
				type="button"
				data-testid="fit-pick-contain"
				onClick={() => props.onValueChange?.("contain")}
			/>
			{props.children}
		</div>
	),
	SelectContent: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	SelectItem: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	SelectTrigger: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	SelectValue: () => null,
}));

import { ImageElementEditor } from "./ImageElementEditor.tsx";

const image = (over: Record<string, unknown> = {}) => ({
	id: 1,
	title: "Hero",
	alt: "A hero",
	mime: "image/png",
	size: 10,
	width: 2,
	height: 3,
	createdAt: "2025-01-01T00:00:00.000Z",
	src: "/api/images/1",
	...over,
});

beforeEach(() => {
	fns.listImagesFn.mockReset();
	vi.unstubAllGlobals();
});

afterEach(cleanup);

describe("ImageElementEditor", () => {
	it("shows the choose button and confirms nothing without an image", async () => {
		const onChange = vi.fn<(value: unknown) => void>();
		render(<ImageElementEditor value={null} onChange={onChange} />);
		expect(screen.getByRole("button", { name: "Choose image" })).toBeTruthy();
	});

	it("opens the dialog, loads the library and picks an image", async () => {
		fns.listImagesFn.mockResolvedValue([
			image(),
			image({ id: 2, title: "Second", src: "/api/images/2" }),
		]);
		const onChange = vi.fn<(value: unknown) => void>();
		const user = userEvent.setup();
		render(
			<ImageElementEditor
				value={{ imageId: 1, alt: "override", fit: "fill" }}
				onChange={onChange}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Change image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		expect(within(dialog).getByText("Second")).toBeTruthy();
		// Draft seeded from value: alt override + fill fit survive.
		const altInput = within(dialog).getByLabelText("Alt text") as HTMLInputElement;
		expect(altInput.value).toBe("override");
		await user.click(within(dialog).getByRole("option", { name: /Second/ }));
		await user.click(within(dialog).getByRole("button", { name: "Use image" }));
		expect(onChange).toHaveBeenCalledWith({ imageId: 2, alt: "override", fit: "fill" });
	});

	it("emits { imageId } without alt/fit extras when fields are blank/default", async () => {
		fns.listImagesFn.mockResolvedValue([image()]);
		const onChange = vi.fn<(value: unknown) => void>();
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={onChange} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		await user.click(within(dialog).getByRole("option", { name: /Hero/ }));
		// fit stays "cover" → emitted as fit? draft.fit defaults to "cover".
		await user.click(within(dialog).getByRole("button", { name: "Use image" }));
		expect(onChange).toHaveBeenCalledWith({ imageId: 1, fit: "cover" });
	});

	it("drops a blank alt override and honors fit changes", async () => {
		fns.listImagesFn.mockResolvedValue([image()]);
		const onChange = vi.fn<(value: unknown) => void>();
		const user = userEvent.setup();
		render(
			<ImageElementEditor value={{ imageId: 1, alt: "  ", fit: "bogus" }} onChange={onChange} />,
		);
		await user.click(screen.getByRole("button", { name: "Change image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		await user.click(within(dialog).getByTestId("fit-pick-contain"));
		await user.click(within(dialog).getByRole("button", { name: "Use image" }));
		expect(onChange).toHaveBeenCalledWith({ imageId: 1, fit: "contain" });
	});

	it("keeps Use image disabled until an image is picked", async () => {
		fns.listImagesFn.mockResolvedValue([image()]);
		const onChange = vi.fn<(value: unknown) => void>();
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={onChange} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		const use = within(dialog).getByRole("button", { name: "Use image" }) as HTMLButtonElement;
		expect(use.disabled).toBe(true);
		await user.click(within(dialog).getByRole("option", { name: /Hero/ }));
		expect(use.disabled).toBe(false);
	});

	it("shows the empty-library state", async () => {
		fns.listImagesFn.mockResolvedValue([]);
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("No images yet — upload the first one.")).toBeTruthy();
	});

	it("shows the load-failed state when listImagesFn rejects", async () => {
		fns.listImagesFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Could not load the image library.")).toBeTruthy();
	});

	it("uploads through POST /api/images and refreshes the grid", async () => {
		fns.listImagesFn.mockResolvedValueOnce([]).mockResolvedValue([image()]);
		const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"ok":true}', { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("No images yet — upload the first one.");
		const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
		await user.upload(input, new File([new Uint8Array([1])], "new.png", { type: "image/png" }));
		await waitFor(() => expect(fns.listImagesFn).toHaveBeenCalledTimes(2));
		await within(dialog).findByText("Hero");
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/images",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("shows the selected thumbnail and label outside the dialog", async () => {
		fns.listImagesFn.mockResolvedValue([image()]);
		const user = userEvent.setup();
		render(<ImageElementEditor value={{ imageId: 1 }} onChange={() => {}} />);
		// Selected row shows title outside the dialog (images load lazily
		// only when the dialog opens, so label falls back to #id).
		expect(screen.getByText("Image #1")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Change image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		expect(within(dialog).getByRole("option", { name: /Hero/ }).getAttribute("aria-selected")).toBe(
			"true",
		);
	});

	it("clicking Upload image triggers the hidden file input", async () => {
		fns.listImagesFn.mockResolvedValue([image()]);
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
		const clickSpy = vi.spyOn(input, "click");
		await user.click(within(dialog).getByRole("button", { name: "Upload image" }));
		expect(clickSpy).toHaveBeenCalled();
	});

	it("ignores file-input changes that carry no file", async () => {
		fns.listImagesFn.mockResolvedValue([image()]);
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [] } });
		await act(async () => {});
		expect(fns.listImagesFn).toHaveBeenCalledTimes(1);
	});

	it("does not refresh the grid when the upload POST fails", async () => {
		fns.listImagesFn.mockResolvedValue([image()]);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => new Response("no", { status: 500 })),
		);
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
		await user.upload(input, new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
		await act(async () => {});
		// Only the initial open-load ran — no refresh on failure.
		expect(fns.listImagesFn).toHaveBeenCalledTimes(1);
	});

	it("tolerates the file ref being gone when an upload resolves late", async () => {
		fns.listImagesFn.mockResolvedValue([image()]);
		let resolveFetch: (r: Response) => void = () => {};
		const fetchMock = vi.fn<typeof fetch>(
			() => new Promise<Response>((resolve) => (resolveFetch = resolve)),
		);
		vi.stubGlobal("fetch", fetchMock);
		const user = userEvent.setup();
		const { unmount } = render(<ImageElementEditor value={null} onChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
		await user.upload(input, new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
		unmount();
		resolveFetch(new Response("{}", { status: 200 }));
		await act(async () => {});
		expect(fetchMock).toHaveBeenCalled();
	});

	it("emits a typed alt override and falls back to Image #id labels", async () => {
		fns.listImagesFn.mockResolvedValue([
			image({ id: 9, title: "", alt: "" }),
			image({ id: 10, title: "", alt: "Alt only" }),
		]);
		const onChange = vi.fn<(value: unknown) => void>();
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={onChange} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		// Untitled/alt-less rows degrade to "Image #id"; alt-only rows
		// use the alt text as the label.
		await within(dialog).findByText("Image #9");
		await within(dialog).findByText("Alt only");
		const altInput = within(dialog).getByLabelText("Alt text");
		await user.type(altInput, "Custom alt");
		await user.click(within(dialog).getByRole("option", { name: /Image #9/ }));
		await user.click(within(dialog).getByRole("button", { name: "Use image" }));
		expect(onChange).toHaveBeenCalledWith({ imageId: 9, alt: "Custom alt", fit: "cover" });
	});

	it("closes via Cancel without emitting", async () => {
		fns.listImagesFn.mockResolvedValue([image()]);
		const onChange = vi.fn<(value: unknown) => void>();
		const user = userEvent.setup();
		render(<ImageElementEditor value={null} onChange={onChange} />);
		await user.click(screen.getByRole("button", { name: "Choose image" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByText("Hero");
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(onChange).not.toHaveBeenCalled();
	});
});
