// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const location = vi.hoisted(() => ({ pathname: "/platform/images" }));
const fns = vi.hoisted(() => ({
	updateImageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteImageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	imageUsageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listImagesFn: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
	useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) => {
		const loc = { pathname: location.pathname };
		return opts?.select === undefined ? loc : opts.select(loc);
	},
}));
vi.mock("../fns.ts", () => fns);

import type { Plugin } from "@ktb/kernel";

import { ImageAdminPage, type ImageRow } from "./ImageAdminPage.tsx";

const row = (over: Partial<ImageRow> = {}): ImageRow => ({
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

/** Fake chrome plugin contributing `dialogAction` entries to the
 * image delete region — mirrors what a future referencer plugin
 * registers. */
const builderChromePlugin = {
	id: "builder.chrome",
	chrome: [
		{
			id: "builder.delete.actions",
			region: "image.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "builder.unlink",
					owner: "builder",
					label: "Unlink blocks",
					description: "Keep the blocks, drop the image",
				},
			},
		},
		{
			id: "builder.delete.blocks",
			region: "image.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "builder.delete-blocks",
					owner: "builder",
					label: "Delete blocks",
					destructive: true,
				},
			},
		},
		{
			// Owner that never reports referents — must stay hidden.
			id: "ghost.delete.actions",
			region: "image.delete.actions",
			content: {
				kind: "dialogAction",
				action: { id: "ghost.act", owner: "ghost", label: "Ghost action" },
			},
		},
	],
} as unknown as Plugin;

const usageBuilder = [{ id: "builder", items: [{ id: 7, title: "Hero block", path: "/" }] }];

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

beforeEach(() => {
	invalidate.mockClear();
	fns.updateImageFn.mockReset();
	fns.deleteImageFn.mockReset();
	fns.imageUsageFn.mockReset();
	fns.listImagesFn.mockReset();
	vi.unstubAllGlobals();
});

afterEach(cleanup);

describe("ImageAdminPage", () => {
	it("renders the grid with titles and the untitled fallback", () => {
		render(
			<ImageAdminPage
				images={[
					row({}),
					row({ id: 2, title: "", alt: "", src: "/api/images/2" }),
					row({ id: 3, title: "", alt: "Alt only", src: "/api/images/3" }),
				]}
			/>,
		);
		expect(screen.getByText("Hero")).toBeTruthy();
		expect(screen.getByText("Untitled")).toBeTruthy();
		expect(screen.getByText("Alt only")).toBeTruthy();
		// The empty-alt row is presentational (alt="") so only two imgs
		// carry the img role — count elements directly.
		expect(document.querySelectorAll("img")).toHaveLength(3);
	});

	it("uploads a file through POST /api/images and invalidates on success", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"ok":true}', { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} />);
		const file = new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" });
		await user.upload(fileInput(), file);
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/images",
			expect.objectContaining({ method: "POST" }),
		);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: FormData }];
		expect((init.body.get("file") as File).name).toBe("pic.png");
		expect(init.body.get("title")).toBe("pic");
	});

	it("shows the upload-failed toast on HTTP errors and thrown fetches", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => new Response("no", { status: 500 })),
		);
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} />);
		// The input's accept list filters uploads — the File needs a
		// matching MIME type or userEvent drops it silently.
		const png = () => new File([new Uint8Array([1])], "x.png", { type: "image/png" });
		await user.upload(fileInput(), png());
		expect(await screen.findByText("Could not upload the image.")).toBeTruthy();
		cleanup();
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => {
				throw new Error("net down");
			}),
		);
		render(<ImageAdminPage images={[row()]} />);
		await user.upload(fileInput(), png());
		expect(await screen.findByText("Could not upload the image.")).toBeTruthy();
	});

	it("ignores file-input changes that carry no file", async () => {
		const fetchMock = vi.fn<() => Promise<unknown>>();
		vi.stubGlobal("fetch", fetchMock);
		render(<ImageAdminPage images={[row()]} />);
		fireEvent.change(fileInput(), { target: { files: [] } });
		await act(async () => {});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("clicking Upload triggers the hidden file input", async () => {
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} />);
		const clickSpy = vi.spyOn(fileInput(), "click");
		await user.click(screen.getByRole("button", { name: "Upload image" }));
		expect(clickSpy).toHaveBeenCalled();
	});

	it("shows the uploading state while the POST is in flight", async () => {
		let resolveFetch: (r: Response) => void = () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
		);
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} />);
		await user.upload(fileInput(), new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
		expect(await screen.findByRole("button", { name: /Uploading/ })).toBeTruthy();
		resolveFetch(new Response("{}", { status: 200 }));
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
	});

	it("dismisses the toast via its close button", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => new Response("no", { status: 500 })),
		);
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} />);
		await user.upload(fileInput(), new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
		await screen.findByText("Could not upload the image.");
		await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
		await waitFor(() => expect(screen.queryByText("Could not upload the image.")).toBeNull());
	});

	it("closes the edit dialog on Escape without saving", async () => {
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByRole("dialog");
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(fns.updateImageFn).not.toHaveBeenCalled();
	});

	it("tolerates the file ref being gone when an upload resolves late", async () => {
		let resolveFetch: (r: Response) => void = () => {};
		const fetchMock = vi.fn<typeof fetch>(
			() => new Promise<Response>((resolve) => (resolveFetch = resolve)),
		);
		vi.stubGlobal("fetch", fetchMock);
		const user = userEvent.setup();
		const { unmount } = render(<ImageAdminPage images={[row()]} />);
		await user.upload(fileInput(), new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
		unmount();
		resolveFetch(new Response("{}", { status: 200 }));
		await act(async () => {});
		expect(fetchMock).toHaveBeenCalled();
	});

	it("edits title/alt through updateImageFn and invalidates", async () => {
		fns.updateImageFn.mockResolvedValue(row({ title: "New", alt: "new alt" }));
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} />);
		await user.click(screen.getByLabelText("Edit"));
		const dialog = await screen.findByRole("dialog");
		const titleInput = within(dialog).getByLabelText("Title");
		const altInput = within(dialog).getByLabelText("Alt text");
		expect((titleInput as HTMLInputElement).value).toBe("Hero");
		expect((altInput as HTMLInputElement).value).toBe("A hero");
		await user.clear(titleInput);
		await user.type(titleInput, "New");
		await user.clear(altInput);
		await user.type(altInput, "new alt");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.updateImageFn).toHaveBeenCalledWith({
				data: { id: 1, title: "New", alt: "new alt" },
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
	});

	it("toasts save-failed when updateImageFn resolves null or throws", async () => {
		fns.updateImageFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} />);
		await user.click(screen.getByLabelText("Edit"));
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Could not save the image.")).toBeTruthy();
		cleanup();
		fns.updateImageFn.mockRejectedValue(new Error("boom"));
		render(<ImageAdminPage images={[row()]} />);
		await user.click(screen.getByLabelText("Edit"));
		const dialog2 = await screen.findByRole("dialog");
		await user.click(within(dialog2).getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Could not save the image.")).toBeTruthy();
	});

	it("cancels the edit dialog without saving", async () => {
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} />);
		await user.click(screen.getByLabelText("Edit"));
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(fns.updateImageFn).not.toHaveBeenCalled();
	});

	it("deletes an unreferenced image with the plain confirm", async () => {
		fns.imageUsageFn.mockResolvedValue([]);
		fns.deleteImageFn.mockResolvedValue(true);
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} plugins={[]} />);
		await user.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByText(/Delete "Hero"\?/);
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(fns.deleteImageFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await screen.findByText("Image deleted");
	});

	it("runs the picked referencer action for referenced images", async () => {
		fns.imageUsageFn.mockResolvedValue(usageBuilder);
		fns.deleteImageFn.mockResolvedValue(true);
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} plugins={[builderChromePlugin]} />);
		await user.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByText("Hero block");
		// Referenced by builder → extended dialog lists owners + actions.
		expect(within(dialog).getByText("Referenced by")).toBeTruthy();
		const unlink = within(dialog).getByRole("button", { name: /Unlink blocks/ });
		const delBlocks = within(dialog).getByRole("button", { name: /Delete blocks/ });
		expect(within(dialog).queryByRole("button", { name: /Ghost action/ })).toBeNull();
		await user.click(delBlocks);
		expect(unlink.getAttribute("aria-pressed")).toBe("false");
		expect(delBlocks.getAttribute("aria-pressed")).toBe("true");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() =>
			expect(fns.deleteImageFn).toHaveBeenCalledWith({
				data: { id: 1, actionId: "builder.delete-blocks" },
			}),
		);
	});

	it("keeps confirm disabled and toasts failure when usage lookup fails", async () => {
		fns.imageUsageFn.mockRejectedValue(new Error("usage boom"));
		const user = userEvent.setup();
		render(<ImageAdminPage images={[row()]} plugins={[]} />);
		await user.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByText("Could not delete the image.");
		const confirm = within(dialog).getByRole("button", { name: "Delete" });
		expect((confirm as HTMLButtonElement).disabled).toBe(true);
		fns.deleteImageFn.mockResolvedValue(false);
		// Cancel out, reopen with usage working but delete failing.
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		cleanup();
		fns.imageUsageFn.mockResolvedValue([]);
		render(<ImageAdminPage images={[row()]} plugins={[]} />);
		await user.click(screen.getByLabelText("Delete"));
		const dialog2 = await screen.findByRole("alertdialog");
		await user.click(within(dialog2).getByRole("button", { name: "Delete" }));
		await screen.findByText("Could not delete the image.");
	});

	it("handles the extended dialog with owners but no contributed actions", async () => {
		fns.imageUsageFn.mockResolvedValue(usageBuilder);
		fns.deleteImageFn.mockResolvedValue(true);
		const user = userEvent.setup();
		// plugins=[] → no dialogAction entries → confirm disabled.
		render(<ImageAdminPage images={[row()]} plugins={[]} />);
		await user.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByText("Hero block");
		const confirm = within(dialog).getByRole("button", { name: "Delete" });
		expect((confirm as HTMLButtonElement).disabled).toBe(true);
	});

	it("renders inside StrictMode without warnings breaking interactions", async () => {
		fns.imageUsageFn.mockResolvedValue([]);
		fns.deleteImageFn.mockResolvedValue(true);
		const user = userEvent.setup();
		render(
			<StrictMode>
				<ImageAdminPage images={[row()]} plugins={[]} />
			</StrictMode>,
		);
		await user.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(fns.deleteImageFn).toHaveBeenCalledWith({ data: { id: 1 } }));
	});
});
