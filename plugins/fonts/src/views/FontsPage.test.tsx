// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	syncFontProviderFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	invalidate: vi.fn<() => Promise<void>>(),
}));

vi.mock("../fns.ts", () => ({
	syncFontProviderFn: fns.syncFontProviderFn,
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: fns.invalidate }),
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { FontFamilySummary, FontProviderSummary } from "../types.ts";
import { FontsPage, type FontsPageData } from "./FontsPage.tsx";

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
	familyCount: 1,
	createdAt: "2025-01-01T00:00:00.000Z",
	updatedAt: null,
	...over,
});

const family = (over: Partial<FontFamilySummary> = {}): FontFamilySummary => ({
	id: 9,
	providerId: 1,
	family: "Inter",
	weights: [400, 700],
	status: "ready",
	meta: null,
	...over,
});

const PROVIDERS: FontProviderSummary[] = [
	provider({ id: 1 }),
	provider({ id: 2, kind: "local", name: "Local", enabled: false }),
];

const FAMILIES: FontFamilySummary[] = [
	family({ id: 9 }),
	family({ id: 10, providerId: 2, family: "Custom", weights: [], status: "failed" }),
	// Provider-less family — exercises the `#id` name fallback.
	family({ id: 11, providerId: 99, family: "Orphan", weights: [300], status: "pending" }),
];

const renderPage = (data: FontsPageData | null = { providers: PROVIDERS, families: FAMILIES }) =>
	render(<FontsPage data={data} ctx={ctx} />);

beforeEach(() => {
	fns.syncFontProviderFn.mockReset().mockResolvedValue([]);
	fns.invalidate.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
});

describe("FontsPage — catalog", () => {
	it("renders statuses, weight chips and the orphan provider fallback", () => {
		renderPage();
		expect(screen.getByText("Inter")).toBeTruthy();
		expect(screen.getByText("400")).toBeTruthy();
		expect(screen.getByText("Ready")).toBeTruthy();
		expect(screen.getByText("Failed")).toBeTruthy();
		expect(screen.getByText("Pending")).toBeTruthy();
		// Empty weights render the placeholder; a provider-less family shows #id.
		expect(screen.getByText("—")).toBeTruthy();
		expect(screen.getByText("#99")).toBeTruthy();
	});

	it("filters by search text and by provider", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.type(screen.getByLabelText("Search providers"), "inter");
		expect(screen.getByText("Inter")).toBeTruthy();
		expect(screen.queryByText("Custom")).toBeNull();
		await user.clear(screen.getByLabelText("Search providers"));

		await user.click(screen.getByRole("combobox"));
		await user.click(await screen.findByRole("option", { name: "Local" }));
		expect(screen.queryByText("Inter")).toBeNull();
		expect(screen.getByText("Custom")).toBeTruthy();

		await user.type(screen.getByLabelText("Search providers"), "zzz");
		expect(screen.getByText("No providers match the search.")).toBeTruthy();
	});

	it("hides the provider filter when no providers exist", () => {
		renderPage({ providers: [], families: [family({ providerId: 1 })] });
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.getByText("Inter")).toBeTruthy();
	});

	it("syncs every provider, shows the busy label and dismisses the toast", async () => {
		const user = userEvent.setup();
		let release: (value: unknown) => void = () => {};
		fns.syncFontProviderFn
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			)
			.mockResolvedValue([]);
		renderPage();
		await user.click(screen.getByRole("button", { name: "Sync" }));
		expect(await screen.findByText("Syncing…")).toBeTruthy();
		release([]);
		await waitFor(() => expect(fns.syncFontProviderFn).toHaveBeenCalledTimes(2));
		expect(fns.syncFontProviderFn).toHaveBeenNthCalledWith(1, { data: { id: 1 } });
		expect(fns.syncFontProviderFn).toHaveBeenNthCalledWith(2, { data: { id: 2 } });
		expect(await screen.findByText("Font catalog synced")).toBeTruthy();
		expect(fns.invalidate).toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
		await waitFor(() => expect(screen.queryByText("Font catalog synced")).toBeNull());
	});

	it("syncs only the selected provider", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("combobox"));
		await user.click(await screen.findByRole("option", { name: "Local" }));
		await user.click(screen.getByRole("button", { name: "Sync" }));
		await waitFor(() => expect(fns.syncFontProviderFn).toHaveBeenCalledWith({ data: { id: 2 } }));
		expect(fns.syncFontProviderFn).toHaveBeenCalledTimes(1);
	});

	it("surfaces a notice when sync fails", async () => {
		const user = userEvent.setup();
		fns.syncFontProviderFn.mockRejectedValueOnce(new Error("boom"));
		renderPage();
		await user.click(screen.getByRole("button", { name: "Sync" }));
		expect(await screen.findByText("Sync failed")).toBeTruthy();
	});
});

describe("FontsPage — empty state", () => {
	it("renders the empty state on a null payload and disables every sync trigger", () => {
		renderPage(null);
		expect(screen.getByText("No font families synced yet — sync a provider first.")).toBeTruthy();
		for (const button of screen.getAllByRole("button", { name: "Sync" })) {
			expect(button).toHaveProperty("disabled", true);
		}
	});

	it("shows the busy label on the empty-state sync button while pending", async () => {
		const user = userEvent.setup();
		let release: (value: unknown) => void = () => {};
		fns.syncFontProviderFn.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		renderPage({ providers: [provider()], families: [] });
		await user.click(screen.getAllByRole("button", { name: "Sync" }).at(-1)!);
		expect((await screen.findAllByText("Syncing…")).length).toBeGreaterThanOrEqual(1);
		release([]);
		await waitFor(() => expect(fns.syncFontProviderFn).toHaveBeenCalledWith({ data: { id: 1 } }));
	});
});
