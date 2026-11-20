// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Plugin } from "@ktb/kernel";

import { templatesMessages } from "../i18n.ts";
import { SaveAsTemplateDialog, type SaveAsTemplateTarget } from "./SaveAsTemplateDialog.tsx";

const t = templatesMessages("en");

const target: SaveAsTemplateTarget = {
	id: 7,
	kind: "layout",
	defaultName: "landing",
	defaultDescription: "Landing snapshot",
	source: { name: "landing" },
};

const pluginWithAction = (action: Record<string, unknown>): Plugin =>
	({
		id: "x.test",
		chrome: [
			{
				id: "x.actions",
				region: "templates.save.actions",
				content: { kind: "dialogAction", action },
			},
		],
	}) as unknown as Plugin;

const baseProps = {
	target,
	plugins: [] as readonly Plugin[],
	pathname: "/layouts",
	t,
	busy: false,
	onConfirm:
		vi.fn<(input: { name: string; description: string; actionId: string | null }) => void>(),
	onCancel: vi.fn<() => void>(),
};

afterEach(cleanup);

describe("SaveAsTemplateDialog", () => {
	it("stays closed without a target", () => {
		render(<SaveAsTemplateDialog {...baseProps} target={null} />);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("collects name/description and confirms with actionId null when no actions are contributed", async () => {
		const user = userEvent.setup();
		const onConfirm =
			vi.fn<(input: { name: string; description: string; actionId: string | null }) => void>();
		render(<SaveAsTemplateDialog {...baseProps} onConfirm={onConfirm} />);
		expect(screen.getByText("Save as template")).toBeTruthy();
		const name = screen.getByLabelText("Name") as HTMLInputElement;
		const description = screen.getByLabelText("Description") as HTMLInputElement;
		expect(name.value).toBe("landing");
		expect(description.value).toBe("Landing snapshot");
		await user.clear(name);
		await user.type(name, "  hero  ");
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(onConfirm).toHaveBeenCalledWith({
			name: "hero",
			description: "Landing snapshot",
			actionId: null,
		});
	});

	it("renders contributed dialogAction entries and passes the picked actionId", async () => {
		const user = userEvent.setup();
		const onConfirm =
			vi.fn<(input: { name: string; description: string; actionId: string | null }) => void>();
		render(
			<SaveAsTemplateDialog
				{...baseProps}
				onConfirm={onConfirm}
				plugins={[
					pluginWithAction({
						id: "save-as-draft",
						owner: "x.test",
						label: "Save as draft",
						description: "Keep it unpublished",
					}),
					pluginWithAction({
						id: "destructive-thing",
						owner: "y.test",
						label: "Destructive thing",
						destructive: true,
					}),
				]}
			/>,
		);
		const first = screen.getByRole("button", { name: /Save as draft/ });
		const second = screen.getByRole("button", { name: /Destructive thing/ });
		// Non-destructive action preselected.
		expect(first.getAttribute("aria-pressed")).toBe("true");
		expect(second.getAttribute("aria-pressed")).toBe("false");
		await user.click(second);
		expect(second.getAttribute("aria-pressed")).toBe("true");
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(onConfirm).toHaveBeenCalledWith(
			expect.objectContaining({ actionId: "destructive-thing" }),
		);
	});

	it("disables save while busy or when the name is blank", async () => {
		const user = userEvent.setup();
		render(<SaveAsTemplateDialog {...baseProps} busy />);
		expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
		cleanup();
		render(<SaveAsTemplateDialog {...baseProps} />);
		const name = screen.getByLabelText("Name") as HTMLInputElement;
		await user.clear(name);
		expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
	});
});
