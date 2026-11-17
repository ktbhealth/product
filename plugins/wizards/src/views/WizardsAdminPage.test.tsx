// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn(async () => {}) }),
}));

vi.mock("../fns.ts", () => ({
	adminDeleteWizardDefFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	adminSaveWizardDefFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	adminSetWizardPublishedFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

import type { WizardDefinition } from "../definition.ts";
import {
	adminDeleteWizardDefFn,
	adminSaveWizardDefFn,
	adminSetWizardPublishedFn,
	type WizardDefWire,
} from "../fns.ts";
import { WizardsAdminPage } from "./WizardsAdminPage.tsx";
import type { Json } from "effect/Schema";

const DEF: WizardDefinition = {
	id: "intake",
	title: "Intake",
	steps: [{ kind: "info", id: "s" }],
};

const row = (over: Partial<WizardDefWire> = {}): WizardDefWire => ({
	key: "intake",
	title: "Intake",
	description: "desc",
	definition: DEF as unknown as Json,
	published: false,
	updatedAt: "2024-01-02T03:04:05.000Z",
	...over,
});

const renderPage = (defs: readonly WizardDefWire[] = [], codeDefs: WizardDefinition[] = []) =>
	render(<WizardsAdminPage defs={defs} codeDefs={codeDefs} locale="en" />);

beforeEach(() => {
	vi.mocked(adminSaveWizardDefFn).mockResolvedValue(row({ published: true }) as never);
	vi.mocked(adminSetWizardPublishedFn).mockResolvedValue(true);
	vi.mocked(adminDeleteWizardDefFn).mockResolvedValue(true);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("WizardsAdminPage", () => {
	it("renders the empty state and the new-def action", () => {
		renderPage();
		expect(screen.getAllByText("No wizard definitions yet.").length).toBeGreaterThan(0);
		expect(screen.getByRole("button", { name: "New wizard" })).toBeTruthy();
	});

	it("lists DB defs with publish badges", () => {
		renderPage([row({}), row({ key: "other", title: "Other", published: true })]);
		expect(screen.getByText("intake")).toBeTruthy();
		expect(screen.getByText("other")).toBeTruthy();
		// badges + row toggle buttons both render the state labels
		expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Published").length).toBeGreaterThan(0);
	});

	it("lists code defs read-only and marks DB-shadowed ones", () => {
		const code = [
			{ ...DEF, id: "code-wiz", owner: "clinic.x" },
			{ ...DEF, id: "intake", owner: "clinic.y" }, // shadowed by the DB row
		];
		renderPage([row({})], code);
		expect(screen.getByText("code-wiz")).toBeTruthy();
		expect(screen.getByText("clinic.x")).toBeTruthy();
		// shadowed row renders with the DB marker
		expect(screen.getByText("Draft · DB")).toBeTruthy();
	});

	it("falls back to ids for untitled code defs and lists shadowed-only sets", () => {
		const bare: WizardDefinition = {
			id: "bare-wiz",
			steps: [{ kind: "info", id: "s" }],
			// no owner — exercises the "plugin" badge fallback
		};
		const shadowBare: WizardDefinition = {
			id: "intake",
			steps: [{ kind: "info", id: "s" }],
			owner: "clinic.y",
		};
		renderPage([row({})], [bare, shadowBare]);
		// untitled defs render their id as the title
		expect(screen.getAllByText("bare-wiz").length).toBeGreaterThan(0);
		expect(screen.getByText("Draft · DB")).toBeTruthy();

		// every code def shadowed → empty-state hint must not appear
		cleanup();
		renderPage([row({})], [shadowBare]);
		expect(screen.queryByText("No wizard definitions yet")).toBeNull();
	});

	it("rejects invalid JSON in the editor", async () => {
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: "New wizard" }));
		fireEvent.change(screen.getByLabelText("Definition (JSON)"), {
			target: { value: "{not json" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Definition is not valid JSON.")).toBeTruthy();
		expect(adminSaveWizardDefFn).not.toHaveBeenCalled();
	});

	it("saves a valid definition and closes the dialog", async () => {
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: "New wizard" }));
		fireEvent.change(screen.getByLabelText("Key"), { target: { value: "intake" } });
		fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Intake" } });
		fireEvent.change(screen.getByLabelText("Description"), {
			target: { value: "A wizard" },
		});
		fireEvent.change(screen.getByLabelText("Definition (JSON)"), {
			target: { value: JSON.stringify(DEF) },
		});
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(adminSaveWizardDefFn).toHaveBeenCalledWith({
				data: {
					key: "intake",
					title: "Intake",
					description: "A wizard",
					definition: DEF as unknown as Json,
					published: true,
				},
			}),
		);
		expect(await screen.findByText("Saved.")).toBeTruthy();
	});

	it("closes the editor via the cancel button and Escape", async () => {
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: "New wizard" }));
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByLabelText("Definition (JSON)")).toBeNull());
		// reopen and dismiss with Escape → Dialog onOpenChange
		fireEvent.click(screen.getByRole("button", { name: "New wizard" }));
		await screen.findByLabelText("Definition (JSON)");
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(screen.queryByLabelText("Definition (JSON)")).toBeNull());
	});

	it("surfaces a failed save", async () => {
		vi.mocked(adminSaveWizardDefFn).mockResolvedValue(null);
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: "New wizard" }));
		fireEvent.change(screen.getByLabelText("Key"), { target: { value: "intake" } });
		fireEvent.change(screen.getByLabelText("Definition (JSON)"), {
			target: { value: JSON.stringify(DEF) },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("The wizard definition could not be saved.")).toBeTruthy();
	});

	it("toggles the published flag", async () => {
		renderPage([row({ published: false })]);
		// the row's toggle button shows the target state label
		fireEvent.click(screen.getByRole("button", { name: "Published" }));
		await waitFor(() =>
			expect(adminSetWizardPublishedFn).toHaveBeenCalledWith({
				data: { key: "intake", published: true },
			}),
		);
	});

	it("opens the editor prefilled from an existing row", async () => {
		renderPage([row({ title: "Intake v2" })]);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		expect(await screen.findByDisplayValue("Intake v2")).toBeTruthy();
		expect(screen.getByDisplayValue("intake")).toBeTruthy();
	});

	it("deletes a def after confirmation", async () => {
		renderPage([row({})]);
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		// the confirm action is the last "Delete" button (row + dialog)
		const buttons = await screen.findAllByRole("button", { name: "Delete" });
		fireEvent.click(buttons[buttons.length - 1]!);
		await waitFor(() =>
			expect(adminDeleteWizardDefFn).toHaveBeenCalledWith({ data: { key: "intake" } }),
		);
	});

	it("cancels the delete confirmation", async () => {
		renderPage([row({})]);
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByText("Delete this wizard definition?")).toBeNull());
		expect(adminDeleteWizardDefFn).not.toHaveBeenCalled();
	});
});
