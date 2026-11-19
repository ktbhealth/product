// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	syncFontProviderFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	invalidate: vi.fn<() => Promise<void>>(),
	fetch: vi.fn<(...args: never[]) => Promise<unknown>>(),
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
	fns.fetch.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", fns.fetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
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

describe("FontsPage — catalog upload", () => {
	const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
		await user.click(screen.getAllByRole("button", { name: "Upload font" })[0]!);
		return screen.findByText("Upload font to catalog");
	};

	it("uploads family/weight/file to the catalog endpoint and refreshes", async () => {
		const user = userEvent.setup();
		renderPage();
		await openDialog(user);
		const submit = screen.getByRole("button", { name: "Upload" });
		expect(submit).toHaveProperty("disabled", true);
		await user.type(screen.getByPlaceholderText("e.g. Brand Sans"), "Brand Sans");
		await user.type(screen.getByPlaceholderText("400"), "700");
		const file = new File([new Uint8Array([1, 2])], "brand.woff2", { type: "font/woff2" });
		await user.upload(document.querySelector('input[type="file"]')!, file);
		await user.click(submit);
		await waitFor(() => expect(fns.fetch).toHaveBeenCalledTimes(1));
		const [url, init] = fns.fetch.mock.calls[0]! as unknown as [string, RequestInit];
		expect(url).toBe("/api/theme/catalog-fonts");
		const form = init.body as FormData;
		expect(form.get("family")).toBe("Brand Sans");
		expect(form.get("weight")).toBe("700");
		expect((form.get("file") as File).name).toBe("brand.woff2");
		expect(await screen.findByText("Font added to the catalog")).toBeTruthy();
		expect(fns.invalidate).toHaveBeenCalled();
	});

	it("keeps submit disabled when the file picker yields no file", async () => {
		const user = userEvent.setup();
		renderPage();
		await openDialog(user);
		await user.type(screen.getByPlaceholderText("e.g. Brand Sans"), "Plain");
		fireEvent.change(document.querySelector('input[type="file"]')!, {
			target: { files: [] },
		});
		expect(screen.getByRole("button", { name: "Upload" })).toHaveProperty("disabled", true);
	});

	it("closes the dialog via cancel", async () => {
		const user = userEvent.setup();
		renderPage();
		await openDialog(user);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByText("Upload font to catalog")).toBeNull());
		expect(fns.fetch).not.toHaveBeenCalled();
	});

	it("omits the weight field when left blank and surfaces upload errors", async () => {
		const user = userEvent.setup();
		fns.fetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));
		renderPage();
		await openDialog(user);
		await user.type(screen.getByPlaceholderText("e.g. Brand Sans"), "Plain");
		await user.upload(
			document.querySelector('input[type="file"]')!,
			new File([new Uint8Array([1])], "p.woff2", { type: "font/woff2" }),
		);
		await user.click(screen.getByRole("button", { name: "Upload" }));
		await waitFor(() => expect(fns.fetch).toHaveBeenCalledTimes(1));
		const [, init] = fns.fetch.mock.calls[0]! as unknown as [string, RequestInit];
		expect((init.body as FormData).get("weight")).toBeNull();
		expect(await screen.findByText("Font upload failed")).toBeTruthy();
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
