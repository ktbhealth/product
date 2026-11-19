// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormDialog } from "./FormDialog.tsx";

afterEach(cleanup);

const FIELDS = [
	{ name: "name", label: "Name", required: true },
	{ name: "notes", label: "Notes", type: "textarea" as const },
];

const setup = (over: Partial<Parameters<typeof FormDialog>[0]> = {}) => {
	const onOpenChange = vi.fn<(open: boolean) => void>();
	const onSubmit = vi.fn<
		(values: Record<string, string>) => Promise<boolean | void> | boolean | void
	>(async () => true);
	render(
		<FormDialog
			open
			onOpenChange={onOpenChange}
			title="New thing"
			submitLabel="Create"
			fields={FIELDS}
			onSubmit={onSubmit}
			{...over}
		/>,
	);
	return { onOpenChange, onSubmit };
};

const submitForm = () => {
	const form = document.querySelector("form");
	expect(form).not.toBeNull();
	fireEvent.submit(form as HTMLFormElement);
};

describe("FormDialog", () => {
	it("renders title, fields and footer actions", () => {
		const { container } = render(
			<FormDialog
				open
				onOpenChange={vi.fn()}
				title="New thing"
				description="Fill it in"
				submitLabel="Create"
				fields={FIELDS}
				onSubmit={vi.fn()}
			/>,
		);
		expect(screen.getByText("New thing")).toBeTruthy();
		expect(screen.getByText("Fill it in")).toBeTruthy();
		expect(screen.getByLabelText("Name")).toBeTruthy();
		expect(screen.getByLabelText("Notes")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
		expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
	});

	it("blocks submit when a required field is empty", async () => {
		const { onSubmit, onOpenChange } = setup();
		submitForm();
		await waitFor(() => expect(onSubmit).not.toHaveBeenCalled());
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("submits trimmed values, closes and resets on success", async () => {
		const { onSubmit, onOpenChange } = setup();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Acme  " } });
		fireEvent.change(screen.getByLabelText("Notes"), { target: { value: " hello " } });
		submitForm();
		await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: "Acme", notes: "hello" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		// Reopen with empty state — values were reset.
		expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
	});

	it("stays open when onSubmit returns false", async () => {
		const onSubmit = vi.fn(async () => false);
		const onOpenChange = vi.fn<(open: boolean) => void>();
		render(
			<FormDialog
				open
				onOpenChange={onOpenChange}
				title="New thing"
				submitLabel="Create"
				fields={FIELDS}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme" } });
		submitForm();
		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
		await waitFor(() =>
			expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Acme"),
		);
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("renders the error line above the footer", () => {
		setup({ error: "Name already taken" });
		expect(screen.getByText("Name already taken")).toBeTruthy();
	});

	it("cancel button closes via onOpenChange", () => {
		const { onOpenChange } = setup();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
