// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmAction } from "./ConfirmAction.tsx";

afterEach(cleanup);

const setup = (over: Partial<Parameters<typeof ConfirmAction>[0]> = {}) => {
	const onConfirm = vi.fn<() => unknown>(async () => undefined);
	render(
		<ConfirmAction
			trigger={(open) => <button onClick={open}>Delete row</button>}
			title="Delete row?"
			description="This cannot be undone."
			confirmLabel="Delete"
			variant="destructive"
			onConfirm={onConfirm}
			{...over}
		/>,
	);
	return { onConfirm };
};

describe("ConfirmAction", () => {
	it("opens the confirm dialog from the trigger and confirms", async () => {
		const { onConfirm } = setup();
		fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
		expect(await screen.findByRole("alertdialog")).toBeTruthy();
		expect(screen.getByText("Delete row?")).toBeTruthy();
		expect(screen.getByText("This cannot be undone.")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	it("supports a plain element trigger via injected onClick", () => {
		setup({ trigger: <button>Plain trigger</button> });
		fireEvent.click(screen.getByRole("button", { name: "Plain trigger" }));
		expect(screen.getByRole("alertdialog")).toBeTruthy();
	});

	it("chains an existing onClick on element triggers", () => {
		const onClick = vi.fn();
		setup({ trigger: <button onClick={onClick}>Chained</button> });
		fireEvent.click(screen.getByRole("button", { name: "Chained" }));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("alertdialog")).toBeTruthy();
	});

	it("cancel closes without running onConfirm", async () => {
		const { onConfirm } = setup();
		fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("shows pending state while onConfirm is in flight, then closes", async () => {
		let resolveFn: (v: unknown) => void = () => {};
		const onConfirm = vi.fn(
			() =>
				new Promise<unknown>((res) => {
					resolveFn = res;
				}),
		);
		setup({ onConfirm });
		fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
		const confirmBtn = await screen.findByRole("button", { name: "Delete" });
		fireEvent.click(confirmBtn);
		await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
		// While pending the confirm button is disabled (busy spinner shows,
		// which also prefixes the accessible name with "Loading").
		await waitFor(() => expect((confirmBtn as HTMLButtonElement).disabled).toBe(true));
		resolveFn(undefined);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	it("closes on settle even when onConfirm rejects", async () => {
		const onConfirm = vi.fn(async () => {
			throw new Error("boom");
		});
		setup({ onConfirm });
		fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});
});
