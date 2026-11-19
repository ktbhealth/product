// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	createFontProviderFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	setFontProviderEnabledFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	removeFontProviderFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	syncFontProviderFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	invalidate: vi.fn<() => Promise<void>>(),
}));

vi.mock("../fns.ts", () => ({
	createFontProviderFn: fns.createFontProviderFn,
	setFontProviderEnabledFn: fns.setFontProviderEnabledFn,
	removeFontProviderFn: fns.removeFontProviderFn,
	syncFontProviderFn: fns.syncFontProviderFn,
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: fns.invalidate }),
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { FontProviderSummary } from "../types.ts";
import { FontProvidersPage, type FontProvidersPageData } from "./FontProvidersPage.tsx";

const ctx = {
	plugins: [],
	locale: "en",
} as unknown as PanelPageContext;

const provider = (over: Partial<FontProviderSummary> = {}): FontProviderSummary => ({
	id: 1,
	kind: "googlefonts",
	name: "Google Fonts",
	config: null,
	enabled: true,
	familyCount: 46,
	createdAt: "2025-01-01T00:00:00.000Z",
	updatedAt: null,
	...over,
});

const PROVIDERS: FontProviderSummary[] = [
	provider({ id: 1 }),
	provider({
		id: 2,
		kind: "local",
		name: "Local",
		enabled: false,
		familyCount: 2,
		updatedAt: "2025-02-01T00:00:00.000Z",
	}),
];

const renderPage = (
	data: FontProvidersPageData | null = {
		providers: PROVIDERS,
		kinds: ["googlefonts", "local"],
	},
) => render(<FontProvidersPage data={data} ctx={ctx} />);

beforeEach(() => {
	fns.createFontProviderFn.mockReset().mockResolvedValue(provider());
	fns.setFontProviderEnabledFn.mockReset().mockResolvedValue({ ok: true });
	fns.removeFontProviderFn.mockReset().mockResolvedValue({ ok: true });
	fns.syncFontProviderFn.mockReset().mockResolvedValue([]);
	fns.invalidate.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
});

describe("FontProvidersPage — list and search", () => {
	it("filters providers by name/kind and reports the filtered count", async () => {
		const user = userEvent.setup();
		renderPage();
		expect(screen.getByText("Google Fonts")).toBeTruthy();
		expect(screen.getByText("Local")).toBeTruthy();

		await user.type(screen.getByLabelText("Search providers"), "google");
		expect(screen.getByText("Google Fonts")).toBeTruthy();
		expect(screen.queryByText("Local")).toBeNull();
		expect(screen.getByText("1 of 2 providers")).toBeTruthy();

		await user.clear(screen.getByLabelText("Search providers"));
		await user.type(screen.getByLabelText("Search providers"), "zzz");
		expect(screen.getByText("No providers match the search.")).toBeTruthy();
	});
});

describe("FontProvidersPage — add provider dialog", () => {
	it("creates a provider through the dialog and refreshes", async () => {
		const user = userEvent.setup();
		let release: (value: unknown) => void = () => {};
		fns.createFontProviderFn.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		renderPage();
		await user.click(screen.getByRole("button", { name: "Add provider" }));
		expect(await screen.findByText("Add font provider")).toBeTruthy();

		await user.type(screen.getByPlaceholderText("e.g. Google Fonts"), "My provider");
		await user.click(screen.getByRole("combobox"));
		await user.click(await screen.findByRole("option", { name: "local" }));
		await user.click(screen.getByRole("button", { name: "Create" }));

		// Busy state while the fn is in flight.
		expect(await screen.findByText("Creating…")).toBeTruthy();
		release(provider());
		await waitFor(() =>
			expect(fns.createFontProviderFn).toHaveBeenCalledWith({
				data: { kind: "local", name: "My provider" },
			}),
		);
		await waitFor(() => expect(fns.invalidate).toHaveBeenCalled());
	});

	it("creates a provider with the default kind when the picker is untouched", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("button", { name: "Add provider" }));
		await user.type(screen.getByPlaceholderText("e.g. Google Fonts"), "Default kind");
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.createFontProviderFn).toHaveBeenCalledWith({
				data: { kind: "googlefonts", name: "Default kind" },
			}),
		);
	});

	it("early-returns from create when the draft kind is empty", async () => {
		const user = userEvent.setup();
		renderPage({ providers: PROVIDERS, kinds: [""] });
		await user.click(screen.getByRole("button", { name: "Add provider" }));
		await user.type(screen.getByPlaceholderText("e.g. Google Fonts"), "My provider");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(fns.createFontProviderFn).not.toHaveBeenCalled();
	});

	it("disables the add action when no adapter kinds are registered", () => {
		renderPage({ providers: PROVIDERS, kinds: [] });
		const trigger = screen.getByRole("button", { name: "Add provider" });
		expect(trigger).toHaveProperty("disabled", true);
	});

	it("surfaces a notice when create fails, and Cancel closes the dialog", async () => {
		const user = userEvent.setup();
		fns.createFontProviderFn.mockRejectedValueOnce(new Error("boom"));
		renderPage();
		await user.click(screen.getByRole("button", { name: "Add provider" }));
		await user.type(screen.getByPlaceholderText("e.g. Google Fonts"), "My provider");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText("Could not create the provider")).toBeTruthy();
		expect(fns.invalidate).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByText("Add font provider")).toBeNull());
	});
});

describe("FontProvidersPage — row actions", () => {
	it("toggles a provider's enabled flag", async () => {
		renderPage();
		fireEvent.click(screen.getByRole("switch", { name: "Google Fonts" }));
		await waitFor(() =>
			expect(fns.setFontProviderEnabledFn).toHaveBeenCalledWith({
				data: { id: 1, enabled: false },
			}),
		);
		expect(fns.invalidate).toHaveBeenCalled();
	});

	it("syncs a provider and dismisses the success toast", async () => {
		const user = userEvent.setup();
		let release: (value: unknown) => void = () => {};
		fns.syncFontProviderFn.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Sync" })[0]!);
		expect(await screen.findByText("Syncing…")).toBeTruthy();
		release([]);
		await waitFor(() => expect(fns.syncFontProviderFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		expect(await screen.findByText("Font catalog synced")).toBeTruthy();
		expect(fns.invalidate).toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
		await waitFor(() => expect(screen.queryByText("Font catalog synced")).toBeNull());
	});

	it("surfaces a notice when sync fails", async () => {
		const user = userEvent.setup();
		fns.syncFontProviderFn.mockRejectedValueOnce(new Error("boom"));
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Sync" })[0]!);
		expect(await screen.findByText("Sync failed")).toBeTruthy();
	});

	it("confirms before deleting — Cancel clears, confirm removes", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByText("Delete this font provider? Its synced families are removed too."),
		).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(fns.removeFontProviderFn).not.toHaveBeenCalled();

		await user.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
		const again = await screen.findByRole("alertdialog");
		await user.click(within(again).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(fns.removeFontProviderFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		expect(fns.invalidate).toHaveBeenCalled();
	});

	it("surfaces a notice when delete fails", async () => {
		const user = userEvent.setup();
		fns.removeFontProviderFn.mockRejectedValueOnce(new Error("boom"));
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(await screen.findByText("Could not delete the provider")).toBeTruthy();
	});
});
