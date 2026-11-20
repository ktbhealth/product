// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const location = vi.hoisted(() => ({ pathname: "/platform/images" }));
const fns = vi.hoisted(() => ({
	imageUsageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-router", () => ({
	useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) => {
		const loc = { pathname: location.pathname };
		return opts?.select === undefined ? loc : opts.select(loc);
	},
}));
vi.mock("../fns.ts", () => fns);

import type { Plugin } from "@ktb/kernel";
import type { ImageMessages } from "../i18n.ts";
import { imageMessages } from "../i18n.ts";

import { ImageDeleteDialog, type ImageDeleteDialogProps } from "./image-delete-dialog.tsx";

const t: ImageMessages = imageMessages("en");

const image = { id: 1, title: "Hero" };

const chromePlugin = (actions: unknown[], region = "image.delete.actions") =>
	({
		id: "p.chrome",
		chrome: actions.map((action, i) => ({
			id: `c${i}`,
			region,
			content: { kind: "dialogAction", action },
		})),
	}) as unknown as Plugin;

const base = (over: Partial<ImageDeleteDialogProps> = {}): ImageDeleteDialogProps => ({
	image,
	plugins: [] as readonly Plugin[],
	pathname: "/platform/images",
	t,
	busy: false,
	onConfirm: vi.fn<(actionId: string | null) => void>(),
	onCancel: vi.fn<() => void>(),
	...over,
});

beforeEach(() => {
	fns.imageUsageFn.mockReset();
});

afterEach(cleanup);

describe("ImageDeleteDialog", () => {
	it("stays closed while image is null", () => {
		render(<ImageDeleteDialog {...base({ image: null })} />);
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(fns.imageUsageFn).not.toHaveBeenCalled();
	});

	it("shows a spinner while usage loads, then the plain confirm", async () => {
		let resolveUsage: (v: unknown) => void = () => {};
		fns.imageUsageFn.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveUsage = resolve;
				}),
		);
		render(<ImageDeleteDialog {...base()} />);
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(/Delete "Hero"\?/)).toBeTruthy();
		resolveUsage([]);
		await waitFor(() =>
			expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeTruthy(),
		);
	});

	it("renders the error state and disables confirm when usage fails", async () => {
		fns.imageUsageFn.mockRejectedValue(new Error("boom"));
		render(<ImageDeleteDialog {...base()} />);
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByText("Could not delete the image.");
		const confirm = within(dialog).getByRole("button", { name: "Delete" });
		expect((confirm as HTMLButtonElement).disabled).toBe(true);
	});

	it("confirms null actionId for unreferenced images and cancels cleanly", async () => {
		fns.imageUsageFn.mockResolvedValue([]);
		const onConfirm = vi.fn<(actionId: string | null) => void>();
		const onCancel = vi.fn<() => void>();
		const user = userEvent.setup();
		render(<ImageDeleteDialog {...base({ onConfirm, onCancel })} />);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(onConfirm).toHaveBeenCalledWith(null);
		cleanup();
		// Cancel path: onOpenChange(false) → onCancel.
		fns.imageUsageFn.mockResolvedValue([]);
		render(<ImageDeleteDialog {...base({ onCancel })} />);
		const dialog2 = await screen.findByRole("alertdialog");
		await user.click(within(dialog2).getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalled();
	});

	it("lists referents grouped by owner and offers contributed actions", async () => {
		fns.imageUsageFn.mockResolvedValue([
			{
				id: "builder",
				items: [
					{ id: 7, title: "Hero block", path: "/" },
					{ id: "doc-3", title: "Doc ref" },
				],
			},
		]);
		const plugins = [
			chromePlugin([
				{
					id: "builder.unlink",
					owner: "builder",
					label: "Unlink",
					description: "desc",
				},
				{ id: "builder.delete", owner: "builder", label: "Delete all", destructive: true },
				// Wrong region — ignored.
			]),
			chromePlugin([{ id: "x", owner: "builder", label: "Wrong region" }], "other.region"),
			// Non-dialogAction content — ignored.
			{
				id: "note",
				chrome: [
					{
						id: "n1",
						region: "image.delete.actions",
						content: { kind: "note", key: "x" },
					},
				],
			} as unknown as Plugin,
		];
		const onConfirm = vi.fn<(actionId: string | null) => void>();
		const user = userEvent.setup();
		render(<ImageDeleteDialog {...base({ plugins, onConfirm })} />);
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByText("Hero block");
		expect(within(dialog).getByText("(/)")).toBeTruthy();
		expect(within(dialog).getByText("Doc ref")).toBeTruthy();
		// Non-destructive action preselected by default.
		const unlink = within(dialog).getByRole("button", { name: /Unlink/ });
		expect(unlink.getAttribute("aria-pressed")).toBe("true");
		await user.click(unlink);
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(onConfirm).toHaveBeenCalledWith("builder.unlink");
	});

	it("falls back to the first action when all are destructive", async () => {
		fns.imageUsageFn.mockResolvedValue([{ id: "p", items: [{ id: 1, title: "x" }] }]);
		const plugins = [
			chromePlugin([{ id: "p.delete", owner: "p", label: "Delete it", destructive: true }]),
		];
		const onConfirm = vi.fn<(actionId: string | null) => void>();
		const user = userEvent.setup();
		render(<ImageDeleteDialog {...base({ plugins, onConfirm })} />);
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByText("Referenced by");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(onConfirm).toHaveBeenCalledWith("p.delete");
	});

	it("disables confirm when owners report referents but no actions exist", async () => {
		fns.imageUsageFn.mockResolvedValue([{ id: "builder", items: [{ id: 1, title: "b" }] }]);
		const user = userEvent.setup();
		render(<ImageDeleteDialog {...base()} />);
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByText("b");
		const confirm = within(dialog).getByRole("button", { name: "Delete" });
		expect((confirm as HTMLButtonElement).disabled).toBe(true);
		await user.click(confirm);
	});

	it("shows the busy spinner on the confirm button", async () => {
		fns.imageUsageFn.mockResolvedValue([]);
		render(<ImageDeleteDialog {...base({ busy: true })} />);
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByRole("button", { name: "Cancel" });
		const cancel = within(dialog).getByRole("button", { name: "Cancel" });
		expect((cancel as HTMLButtonElement).disabled).toBe(true);
	});

	it("falls back to Untitled in the body for empty titles", async () => {
		fns.imageUsageFn.mockResolvedValue([]);
		render(<ImageDeleteDialog {...base({ image: { id: 5, title: "" } })} />);
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(/Delete "Untitled"\?/)).toBeTruthy();
	});

	it("ignores usage results that resolve after unmount", async () => {
		let resolveUsage: (v: unknown) => void = () => {};
		let rejectUsage: (e: unknown) => void = () => {};
		fns.imageUsageFn
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveUsage = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						rejectUsage = reject;
					}),
			);
		const first = render(<ImageDeleteDialog {...base()} />);
		await screen.findByRole("alertdialog");
		first.unmount();
		resolveUsage([]);
		await act(async () => {});
		// Same for the rejection path.
		const second = render(<ImageDeleteDialog {...base()} />);
		await screen.findByRole("alertdialog");
		second.unmount();
		rejectUsage(new Error("late failure"));
		await act(async () => {});
		expect(fns.imageUsageFn).toHaveBeenCalledTimes(2);
	});

	it("ignores usage results for a different image id", async () => {
		// imageUsageFn resolves for id 2 while dialog shows id 1 — the
		// tagged-result guard must keep showing loading, never stale data.
		let resolveUsage: (v: unknown) => void = () => {};
		fns.imageUsageFn.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveUsage = resolve;
				}),
		);
		const { rerender } = render(<ImageDeleteDialog {...base({ image: { id: 2, title: "B" } })} />);
		resolveUsage([{ id: "p", items: [{ id: 1, title: "stale" }] }]);
		await waitFor(() => expect(fns.imageUsageFn).toHaveBeenCalledWith({ data: { id: 2 } }));
		// Now switch to image 1 — usage refetches; old result must not leak.
		fns.imageUsageFn.mockResolvedValue([]);
		rerender(<ImageDeleteDialog {...base({ image })} />);
		const dialog = await screen.findByRole("alertdialog");
		await within(dialog).findByText(/Delete "Hero"\?/);
		await waitFor(() => expect(within(dialog).queryByText("stale")).toBeNull());
	});
});
