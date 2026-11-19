// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	getThemeFn: vi.fn(),
	listThemeAssetsFn: vi.fn(),
	publishThemeFn: vi.fn(),
	setThemePreviewFn: vi.fn(),
	deleteThemeFn: vi.fn(),
	invalidate: vi.fn(),
	fetchMock: vi.fn(),
	search: { current: { id: "7" } as Record<string, unknown> },
}));

vi.mock("../fns.ts", () => ({
	getThemeFn: fns.getThemeFn,
	listThemeAssetsFn: fns.listThemeAssetsFn,
	publishThemeFn: fns.publishThemeFn,
	setThemePreviewFn: fns.setThemePreviewFn,
	deleteThemeFn: fns.deleteThemeFn,
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: fns.invalidate }),
	useSearch: () => fns.search.current,
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { ResolvedTheme, ThemeAssetSummary, ThemeSummary } from "../types.ts";
import { ThemeEditorPage } from "./ThemeEditorPage.tsx";

const ctx = {
	plugins: [],
	locale: "en",
} as unknown as PanelPageContext;

const theme = (over: Partial<ResolvedTheme> = {}): ResolvedTheme => ({
	id: 7,
	scope: "tenant",
	scopeId: "acme",
	appName: "Acme Health",
	seeds: {},
	tokens: { light: {}, dark: {} },
	styleCss: "",
	fonts: null,
	fontLinks: [],
	fontFaceCss: "",
	brand: null,
	...over,
});

const summary = (over: Partial<ThemeSummary> = {}): ThemeSummary => ({
	id: 7,
	scope: "tenant",
	scopeId: "acme",
	appName: "Acme Health",
	enabled: true,
	isMain: false,
	version: 3,
	...over,
});

const ASSETS: ThemeAssetSummary[] = [
	{
		id: 1,
		themeId: 7,
		kind: "logo-light",
		status: "ready",
		r2Key: "k/logo.png",
		variants: { dominantColor: "#aabbcc" },
		createdAt: "2025-01-01T00:00:00Z",
	},
	{
		id: 2,
		themeId: 7,
		kind: "favicon",
		status: "failed",
		r2Key: null,
		variants: { error: "boom", dominantColor: 5 },
		createdAt: "2025-01-01T00:00:00Z",
	},
	{
		id: 3,
		themeId: 7,
		kind: "font",
		status: "pending",
		r2Key: null,
		variants: null,
		createdAt: "2025-01-01T00:00:00Z",
	},
	{
		id: 4,
		themeId: 7,
		kind: "wordmark",
		status: "processing",
		r2Key: null,
		variants: "nope",
		createdAt: "2025-01-01T00:00:00Z",
	},
];

const deferred = <T,>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

const renderEditor = () => render(<ThemeEditorPage ctx={ctx} />);

const loaded = async () => {
	await screen.findByRole("heading", { name: /^Theme:/ });
};

beforeEach(() => {
	fns.getThemeFn.mockReset().mockResolvedValue(theme());
	fns.listThemeAssetsFn.mockReset().mockResolvedValue(ASSETS);
	fns.publishThemeFn.mockReset().mockResolvedValue(summary());
	fns.setThemePreviewFn.mockReset().mockResolvedValue({ ok: true });
	fns.deleteThemeFn.mockReset().mockResolvedValue({ ok: true });
	fns.invalidate.mockReset().mockResolvedValue(undefined);
	fns.fetchMock.mockReset().mockResolvedValue(new Response("", { status: 200 }));
	fns.search.current = { id: "7" };
	vi.stubGlobal("fetch", fns.fetchMock);
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("ThemeEditorPage — load states", () => {
	it("renders the not-found state for a missing or invalid id", async () => {
		fns.search.current = {};
		renderEditor();
		expect(await screen.findByText(/Theme not found/)).toBeTruthy();
		expect(fns.getThemeFn).not.toHaveBeenCalled();

		cleanup();
		fns.search.current = { id: "abc" };
		renderEditor();
		expect(await screen.findByText(/Theme not found/)).toBeTruthy();
		expect(fns.getThemeFn).not.toHaveBeenCalled();
	});

	it("renders not-found when the theme does not resolve", async () => {
		fns.getThemeFn.mockResolvedValue(null);
		renderEditor();
		expect(await screen.findByText(/Theme not found/)).toBeTruthy();
	});

	it("renders not-found when the load fails", async () => {
		fns.getThemeFn.mockRejectedValue(new Error("boom"));
		renderEditor();
		expect(await screen.findByText(/Theme not found/)).toBeTruthy();
	});

	it("shows a loading state while the theme resolves", () => {
		fns.getThemeFn.mockReturnValue(new Promise(() => {}));
		renderEditor();
		expect(screen.getByText(/Theme/)).toBeTruthy();
	});

	it("loads the theme and its assets into the editor", async () => {
		renderEditor();
		await loaded();
		expect(fns.getThemeFn).toHaveBeenCalledWith({ data: { id: 7 } });
		expect(fns.listThemeAssetsFn).toHaveBeenCalledWith({ data: { themeId: 7 } });
		expect(screen.getByRole("heading", { name: "Theme: Acme Health" })).toBeTruthy();
		expect(screen.getByText(/Tenant · #7/)).toBeTruthy();
	});

	it("ignores a late load resolution after unmount", async () => {
		const d = deferred<ResolvedTheme | null>();
		fns.getThemeFn.mockReturnValue(d.promise);
		const { unmount } = renderEditor();
		unmount();
		d.resolve(theme());
		await tick();
	});

	it("ignores a late load failure after unmount", async () => {
		const d = deferred<ResolvedTheme | null>();
		fns.getThemeFn.mockReturnValue(d.promise);
		const { unmount } = renderEditor();
		unmount();
		d.reject(new Error("boom"));
		await tick();
	});
});

describe("ThemeEditorPage — header actions", () => {
	it("publishes the theme, flags dirty and invalidates", async () => {
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("button", { name: "Publish theme" }));
		await waitFor(() => expect(fns.publishThemeFn).toHaveBeenCalled());
		expect(fns.publishThemeFn).toHaveBeenCalledWith({
			data: expect.objectContaining({
				id: 7,
				scope: "tenant",
				scopeId: "acme",
				appName: "Acme Health",
				fonts: null,
			}),
		});
		expect(await screen.findByText("Theme published")).toBeTruthy();
		expect(fns.invalidate).toHaveBeenCalled();
		expect(screen.getByText("Unsaved changes")).toBeTruthy();
	});

	it("surfaces a notice when publish fails", async () => {
		fns.publishThemeFn.mockRejectedValue(new Error("nope"));
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("button", { name: "Publish theme" }));
		expect(await screen.findByText("Publish failed")).toBeTruthy();
	});

	it("ignores a second publish while saving", async () => {
		const d = deferred<ThemeSummary>();
		fns.publishThemeFn.mockReturnValue(d.promise);
		renderEditor();
		await loaded();
		const publishButton = screen.getByRole("button", { name: "Publish theme" });
		fireEvent.click(publishButton);
		expect(await screen.findByText("Publishing…")).toBeTruthy();
		// The button is disabled while saving; a raw dispatch still reaches
		// the handler, which must bail out on the saving guard.
		fireEvent.click(publishButton);
		expect(fns.publishThemeFn).toHaveBeenCalledTimes(1);
		d.resolve(summary());
		await screen.findByText("Theme published");
	});

	it("toggles the preview on and shows the busy state", async () => {
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("button", { name: "Preview" }));
		await waitFor(() =>
			expect(fns.setThemePreviewFn).toHaveBeenCalledWith({ data: { themeId: 7 } }),
		);
		expect(await screen.findByText("Previewing…")).toBeTruthy();
		expect(screen.getAllByText("Preview").length).toBeGreaterThan(0);
	});

	it("clears the preview when the theme is already previewing", async () => {
		fns.getThemeFn.mockResolvedValue(theme({ preview: true }));
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("button", { name: "Preview" }));
		await waitFor(() =>
			expect(fns.setThemePreviewFn).toHaveBeenCalledWith({ data: { themeId: null } }),
		);
	});

	it("surfaces a notice and resets busy when preview fails", async () => {
		fns.setThemePreviewFn.mockResolvedValue({ ok: false });
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("button", { name: "Preview" }));
		expect(await screen.findByText("Publish failed")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
	});

	it("ignores a second preview while busy", async () => {
		const d = deferred<{ ok: boolean }>();
		fns.setThemePreviewFn.mockReturnValue(d.promise);
		renderEditor();
		await loaded();
		const previewButton = screen.getByRole("button", { name: "Preview" });
		fireEvent.click(previewButton);
		expect(await screen.findByText("Previewing…")).toBeTruthy();
		// Disabled while busy — the handler still bails on the busy guard.
		fireEvent.click(previewButton);
		expect(fns.setThemePreviewFn).toHaveBeenCalledTimes(1);
		d.resolve({ ok: true });
		await tick();
	});
});

describe("ThemeEditorPage — general settings", () => {
	it("edits scope, scope id and app name, then publishes", async () => {
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		const scopeId = screen.getByLabelText("Scope id") as HTMLInputElement;
		await user.clear(scopeId);
		await user.type(scopeId, " acme-2 ");
		const appName = screen.getByLabelText("App name") as HTMLInputElement;
		await user.clear(appName);
		expect(screen.getByText("Unsaved changes")).toBeTruthy();
		await user.click(screen.getByRole("combobox", { name: "Scope" }));
		await user.click(await screen.findByRole("option", { name: "Platform default" }));
		expect(scopeId.disabled).toBe(true);
		await user.click(screen.getByRole("button", { name: "Publish theme" }));
		await waitFor(() =>
			expect(fns.publishThemeFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ scope: "platform", scopeId: "", appName: null }),
			}),
		);
	});

	it("falls back to the scope id and theme id in the heading", async () => {
		fns.getThemeFn.mockResolvedValue(theme({ appName: null }));
		const { unmount } = renderEditor();
		expect(await screen.findByRole("heading", { name: "Theme: acme" })).toBeTruthy();
		unmount();

		fns.getThemeFn.mockResolvedValue(theme({ appName: null, scopeId: "" }));
		renderEditor();
		expect(await screen.findByRole("heading", { name: "Theme: #7" })).toBeTruthy();
	});

	it("falls back to the brand app name when appName is null", async () => {
		fns.getThemeFn.mockResolvedValue(theme({ appName: null, brand: { appName: "Brand App" } }));
		renderEditor();
		expect(await screen.findByRole("heading", { name: "Theme: Brand App" })).toBeTruthy();
	});
});

describe("ThemeEditorPage — colors section", () => {
	it("edits light and dark seeds plus the radius, then publishes them", async () => {
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Colors" }));

		const pickers = screen.getAllByRole("button", { name: "oklch(…) / #rrggbb" });
		expect(pickers).toHaveLength(12);
		await user.click(pickers[0]!);
		fireEvent.change(await screen.findByLabelText("Color value"), {
			target: { value: "#ff0000" },
		});
		await user.keyboard("{Escape}");

		const darkPickers = screen.getAllByRole("button", { name: "oklch(…) / #rrggbb" });
		await user.click(darkPickers[5]!);
		fireEvent.change(await screen.findByLabelText("Color value"), {
			target: { value: "#224466" },
		});
		await user.keyboard("{Escape}");

		const radiusInputs = screen.getAllByPlaceholderText("0.45rem");
		await user.type(radiusInputs[0]!, "0.9rem");
		await user.type(radiusInputs[1]!, "0.8rem");

		expect(screen.getByText("Unsaved changes")).toBeTruthy();

		await user.click(screen.getByRole("button", { name: "Publish theme" }));
		await waitFor(() =>
			expect(fns.publishThemeFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					seeds: expect.objectContaining({
						primary: "#ff0000",
						radius: "0.9rem",
						dark: expect.objectContaining({ primary: "#224466" }),
					}),
				}),
			}),
		);
	});

	it("derives dark seeds from the loaded theme", async () => {
		fns.getThemeFn.mockResolvedValue(
			theme({
				seeds: {
					primary: "#3355ff",
					secondary: "#eeeeee",
					accent: "#dddddd",
					background: "#ffffff",
					foreground: "#111111",
					destructive: "#cc0000",
					radius: "0.6rem",
					dark: { primary: "#aabbcc", background: "#101010" },
				},
			}),
		);
		renderEditor();
		await loaded();
		const user = userEvent.setup();
		await user.click(screen.getByRole("tab", { name: "Colors" }));
		expect(screen.getAllByRole("button", { name: "#3355ff" }).length).toBe(1);
		expect(screen.getAllByRole("button", { name: "#aabbcc" }).length).toBe(1);
		expect(screen.getByText("Radius — 0.6rem")).toBeTruthy();
	});
});

describe("ThemeEditorPage — typography section", () => {
	it("configures delivery, families and weights, then publishes fonts", async () => {
		fns.getThemeFn.mockResolvedValue(
			theme({
				fonts: {
					delivery: "self-host",
					families: { sans: "Inter" },
					weights: [400, 700],
				},
			}),
		);
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Typography" }));

		const weights = screen.getByLabelText(/Weights/) as HTMLInputElement;
		expect(weights.value).toBe("400, 700");

		await user.click(screen.getByRole("combobox"));
		await user.click(await screen.findByRole("option", { name: "Google Fonts link" }));
		expect(await screen.findByText(/Google Fonts sends visitor requests/)).toBeTruthy();
		await user.click(screen.getByRole("combobox"));
		await user.click(await screen.findByRole("option", { name: "Self-hosted (recommended)" }));

		const sans = screen.getByLabelText("Sans");
		await user.clear(sans);
		expect(screen.getByText("Unsaved changes")).toBeTruthy();
		await user.type(screen.getByLabelText("Mono"), "JetBrains Mono");
		fireEvent.change(weights, { target: { value: "400, abc, 50, 700" } });
		fireEvent.change(weights, { target: { value: "xyz" } });

		await user.click(screen.getByRole("button", { name: "Publish theme" }));
		await waitFor(() =>
			expect(fns.publishThemeFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					fonts: expect.objectContaining({
						delivery: "self-host",
						families: expect.objectContaining({ sans: null, mono: "JetBrains Mono" }),
					}),
				}),
			}),
		);
	});

	it("builds font families from scratch when the theme has none", async () => {
		// Typing a family while fonts is null exercises the `f ?? {}` /
		// `f?.x ?? default` arms of setFontDelivery and setFontFamilySlot.
		fns.getThemeFn.mockResolvedValue(theme({ fonts: null }));
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Typography" }));

		await user.type(screen.getByLabelText("Heading"), "Fraunces");
		await user.click(screen.getByRole("combobox"));
		await user.click(await screen.findByRole("option", { name: "Google Fonts link" }));
		expect(await screen.findByText(/Google Fonts sends visitor requests/)).toBeTruthy();

		await user.click(screen.getByRole("button", { name: "Publish theme" }));
		await waitFor(() =>
			expect(fns.publishThemeFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					fonts: expect.objectContaining({
						delivery: "google-fonts",
						families: expect.objectContaining({ heading: "Fraunces" }),
					}),
				}),
			}),
		);
	});

	it("sets the delivery while fonts is still null", async () => {
		// Changing delivery before any family exercises the `f ?? {}` arm
		// of setFontDelivery — later updates see a non-null draft.
		fns.getThemeFn.mockResolvedValue(theme({ fonts: null }));
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Typography" }));

		await user.click(screen.getByRole("combobox"));
		await user.click(await screen.findByRole("option", { name: "Google Fonts link" }));
		expect(await screen.findByText(/Google Fonts sends visitor requests/)).toBeTruthy();
	});

	it("builds font weights from scratch when the theme has none", async () => {
		// Typing weights while fonts is null exercises the `f ?? {}` /
		// `f?.x ?? default` arms of setFontWeights.
		fns.getThemeFn.mockResolvedValue(theme({ fonts: null }));
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Typography" }));
		fireEvent.change(screen.getByLabelText(/Weights/), {
			target: { value: "500 600" },
		});
		await user.click(screen.getByRole("button", { name: "Publish theme" }));
		await waitFor(() =>
			expect(fns.publishThemeFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					fonts: expect.objectContaining({
						delivery: "self-host",
						weights: [500, 600],
					}),
				}),
			}),
		);
	});
});

describe("ThemeEditorPage — assets section", () => {
	const fileInputs = () => document.querySelectorAll<HTMLInputElement>('input[type="file"]');

	it("lists brand references and uploaded assets", async () => {
		// appName null keeps the brand appName ref empty while the other
		// brand fields cover the set/null/undefined/"" skips.
		fns.getThemeFn.mockResolvedValue(
			theme({
				appName: null,
				brand: { logoLight: "/logo.svg", wordmark: null, favicon: "" },
			}),
		);
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		expect(screen.getByText("Current brand references")).toBeTruthy();
		// "/logo.svg" appears both as a brand ref and the kind's current URL.
		expect(screen.getAllByText("/logo.svg").length).toBeGreaterThan(0);
		// Asset status rows: ready / failed+error / pending / other.
		expect(screen.getByText("boom")).toBeTruthy();
		expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
		expect(screen.getByText("Failed")).toBeTruthy();
		expect(screen.getByText("Font file")).toBeTruthy();
	});

	it("shows the empty assets message and no brand refs", async () => {
		fns.getThemeFn.mockResolvedValue(theme({ appName: null, brand: null }));
		fns.listThemeAssetsFn.mockResolvedValue([]);
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		expect(screen.getByText("No assets uploaded yet.")).toBeTruthy();
		expect(screen.queryByText("Current brand references")).toBeNull();
	});

	it("uploads an image asset and refreshes the list", async () => {
		// The refresh reload resolves a theme without appName/brand so the
		// brand.appName fallbacks in refreshAssets are exercised.
		fns.getThemeFn
			.mockResolvedValueOnce(theme())
			.mockResolvedValue(theme({ appName: null, brand: null }));
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		fireEvent.change(fileInputs()[0]!, {
			target: { files: [new File(["x"], "logo.png", { type: "image/png" })] },
		});
		// Clearing the file selection falls back to null.
		fireEvent.change(fileInputs()[1]!, { target: { files: [] } });
		const uploadButtons = screen.getAllByRole("button", { name: "Upload" });
		// Disabled buttons are inert.
		fireEvent.click(uploadButtons[1]!);
		expect(fns.fetchMock).not.toHaveBeenCalled();
		await user.click(uploadButtons[0]!);
		await waitFor(() =>
			expect(fns.fetchMock).toHaveBeenCalledWith(
				"/api/theme/assets",
				expect.objectContaining({ method: "POST" }),
			),
		);
		const form = fns.fetchMock.mock.calls[0]![1].body as FormData;
		expect(form.get("kind")).toBe("logo-light");
		expect(form.get("themeId")).toBe("7");
		expect(
			await screen.findByText("Upload queued — variants are generated asynchronously."),
		).toBeTruthy();
		await waitFor(() => expect(fns.listThemeAssetsFn.mock.calls.length).toBeGreaterThanOrEqual(2));
	});

	it("surfaces a notice when an image upload fails", async () => {
		fns.fetchMock.mockResolvedValue(new Response("", { status: 500 }));
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		fireEvent.change(fileInputs()[0]!, {
			target: { files: [new File(["x"], "logo.png")] },
		});
		await user.click(screen.getAllByRole("button", { name: "Upload" })[0]!);
		expect(await screen.findByText("Upload failed")).toBeTruthy();
	});

	it("surfaces a notice when the post-upload refresh fails", async () => {
		fns.listThemeAssetsFn
			.mockResolvedValueOnce(ASSETS)
			.mockRejectedValue(new Error("refresh broke"));
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		fireEvent.change(fileInputs()[0]!, {
			target: { files: [new File(["x"], "logo.png")] },
		});
		await user.click(screen.getAllByRole("button", { name: "Upload" })[0]!);
		expect(await screen.findByText("Upload failed")).toBeTruthy();
	});

	it("tolerates the theme disappearing during refresh", async () => {
		fns.getThemeFn.mockResolvedValueOnce(theme()).mockResolvedValue(null);
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		fireEvent.change(fileInputs()[0]!, {
			target: { files: [new File(["x"], "logo.png")] },
		});
		await user.click(screen.getAllByRole("button", { name: "Upload" })[0]!);
		await waitFor(() => expect(fns.getThemeFn).toHaveBeenCalledTimes(2));
	});

	it("shows the upload spinner while an upload is in flight", async () => {
		const d = deferred<Response>();
		fns.fetchMock.mockReturnValue(d.promise);
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		fireEvent.change(fileInputs()[0]!, {
			target: { files: [new File(["x"], "logo.png")] },
		});
		fireEvent.click(screen.getAllByRole("button", { name: "Upload" })[0]!);
		await waitFor(() => expect(screen.getAllByRole("status").length).toBeGreaterThan(0));
		d.resolve(new Response("", { status: 200 }));
		await screen.findByText("Upload queued — variants are generated asynchronously.");
	});

	it("uploads a font file with family and slot metadata", async () => {
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		await user.type(screen.getByPlaceholderText("Font family"), "Inter");
		const combos = screen.getAllByRole("combobox");
		await user.click(combos[0]!);
		await user.click(await screen.findByRole("option", { name: "mono" }));
		fireEvent.change(fileInputs()[5]!, {
			target: { files: [new File(["x"], "Inter.woff2")] },
		});
		await user.click(screen.getByRole("button", { name: "Upload font" }));
		await waitFor(() => expect(fns.fetchMock).toHaveBeenCalled());
		const form = fns.fetchMock.mock.calls[0]![1].body as FormData;
		expect(form.get("kind")).toBe("font");
		expect(form.get("family")).toBe("Inter");
		expect(form.get("slot")).toBe("mono");
	});

	it("derives the font family from the file name when left blank", async () => {
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		// Disabled font upload button is inert.
		fireEvent.click(screen.getByRole("button", { name: "Upload font" }));
		expect(fns.fetchMock).not.toHaveBeenCalled();
		// Clearing the font selection falls back to null.
		fireEvent.change(fileInputs()[5]!, { target: { files: [] } });
		fireEvent.change(fileInputs()[5]!, {
			target: { files: [new File(["x"], "MyFont.woff2")] },
		});
		// A failed upload keeps the selected file.
		fns.fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
		await user.click(screen.getByRole("button", { name: "Upload font" }));
		expect(await screen.findByText("Upload failed")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Upload font" }));
		await waitFor(() => expect(fns.fetchMock).toHaveBeenCalledTimes(2));
		const form = fns.fetchMock.mock.calls[1]![1].body as FormData;
		expect(form.get("family")).toBe("MyFont");
		expect(form.get("slot")).toBe("sans");
	});

	it("fetches a Google font and surfaces failures", async () => {
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Brand & assets" }));
		// Disabled fetch button is inert while the family is empty.
		fireEvent.click(screen.getByRole("button", { name: "Fetch from Google Fonts" }));
		expect(fns.fetchMock).not.toHaveBeenCalled();
		await user.type(screen.getByPlaceholderText("Google Fonts family"), "Roboto");
		const combos = screen.getAllByRole("combobox");
		await user.click(combos[1]!);
		await user.click(await screen.findByRole("option", { name: "heading" }));
		await user.click(screen.getByRole("button", { name: "Fetch from Google Fonts" }));
		await waitFor(() =>
			expect(fns.fetchMock).toHaveBeenCalledWith(
				"/api/theme/fonts",
				expect.objectContaining({ method: "POST" }),
			),
		);
		const body = JSON.parse(String(fns.fetchMock.mock.calls[0]![1].body));
		expect(body).toEqual({ themeId: 7, family: "Roboto", slot: "heading" });
		expect(
			await screen.findByText("Upload queued — variants are generated asynchronously."),
		).toBeTruthy();

		fns.fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
		await user.click(screen.getByRole("button", { name: "Fetch from Google Fonts" }));
		expect(await screen.findByText("Font fetch failed")).toBeTruthy();
	});
});

describe("ThemeEditorPage — preview tabs", () => {
	it("renders the tokens tab and toggles color schemes", async () => {
		fns.getThemeFn.mockResolvedValue(
			theme({
				fonts: {
					delivery: "self-host",
					families: { sans: "Inter", mono: "JetBrains Mono" },
				},
			}),
		);
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		// Tokens tab is active by default.
		expect(screen.getByText("Contrast report")).toBeTruthy();
		expect(screen.getByText("Token reference")).toBeTruthy();
		expect(screen.getByText("Radius — 0.45rem")).toBeTruthy();
		expect(screen.getAllByText("AA pass").length).toBeGreaterThan(0);
		expect(screen.getAllByText("--background").length).toBeGreaterThan(0);
		expect(screen.getByText("Aa — Body text, buttons and inputs")).toBeTruthy();
		expect(screen.getByText("Aa — Display heading")).toBeTruthy();
		expect(screen.getByText("Aa — Code and identifiers")).toBeTruthy();

		await user.click(screen.getByRole("button", { name: "Dark" }));
		expect(screen.getByText("Dark — Colors")).toBeTruthy();
		expect(screen.getByText(/Dark custom properties/)).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Light" }));
		expect(screen.getByText("Light — Colors")).toBeTruthy();
	});

	it("renders the components gallery", async () => {
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Components" }));
		expect(screen.getByText("Buttons")).toBeTruthy();
		expect(screen.getByText("Form controls")).toBeTruthy();
		expect(screen.getByText("Feedback & data")).toBeTruthy();
		expect(screen.getByText("Surfaces")).toBeTruthy();
		expect(screen.getAllByRole("checkbox")).toHaveLength(2);
		expect(screen.getAllByRole("switch")).toHaveLength(2);
		await user.click(screen.getByRole("button", { name: "Dark" }));
		await user.click(screen.getByRole("button", { name: "Light" }));
	});

	it("renders the blocks demo", async () => {
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Blocks" }));
		expect(screen.getByText("Stats")).toBeTruthy();
		expect(screen.getByText("KTB default")).toBeTruthy();
		expect(screen.getByText("Acme brand")).toBeTruthy();
		expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Acme Health");
		await user.click(screen.getByRole("button", { name: "Dark" }));
	});

	it("falls back to the stock name in the blocks demo", async () => {
		fns.getThemeFn.mockResolvedValue(theme({ appName: null }));
		const user = userEvent.setup();
		renderEditor();
		await loaded();
		await user.click(screen.getByRole("tab", { name: "Blocks" }));
		expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("KTB Health");
	});
});

describe("ThemeEditorPage — fresh draft discard", () => {
	it("deletes an untouched fresh draft on unmount and flags the toast", async () => {
		fns.search.current = { id: "7", fresh: "1" };
		const { unmount } = renderEditor();
		await loaded();
		unmount();
		await waitFor(() => expect(fns.deleteThemeFn).toHaveBeenCalledWith({ data: { id: 7 } }));
		await waitFor(() => expect(sessionStorage.getItem("ktb-theme-discarded")).toBe("1"));
	});

	it("swallows delete failures on unmount", async () => {
		fns.search.current = { id: "7", fresh: "1" };
		fns.deleteThemeFn.mockRejectedValue(new Error("cannot delete"));
		const { unmount } = renderEditor();
		await loaded();
		unmount();
		await waitFor(() => expect(fns.deleteThemeFn).toHaveBeenCalled());
		await tick();
		expect(sessionStorage.getItem("ktb-theme-discarded")).toBeNull();
	});

	it("keeps a touched fresh draft on unmount", async () => {
		fns.search.current = { id: "7", fresh: "1" };
		const user = userEvent.setup();
		const { unmount } = renderEditor();
		await loaded();
		await user.type(screen.getByLabelText("App name"), "x");
		unmount();
		await tick();
		expect(fns.deleteThemeFn).not.toHaveBeenCalled();
	});

	it("keeps a fresh draft whose theme never loaded", async () => {
		fns.search.current = { id: "7", fresh: "1" };
		fns.getThemeFn.mockResolvedValue(null);
		const { unmount } = renderEditor();
		await screen.findByText(/Theme not found/);
		unmount();
		await tick();
		expect(fns.deleteThemeFn).not.toHaveBeenCalled();
	});

	it("keeps a non-fresh draft on unmount", async () => {
		const { unmount } = renderEditor();
		await loaded();
		unmount();
		await tick();
		expect(fns.deleteThemeFn).not.toHaveBeenCalled();
	});

	it("keeps the draft when only the fresh flag changes", async () => {
		fns.search.current = { id: "7", fresh: "1" };
		const { unmount, rerender } = renderEditor();
		await loaded();
		fns.search.current = { id: "7", fresh: "0" };
		rerender(<ThemeEditorPage ctx={ctx} />);
		await tick();
		expect(fns.deleteThemeFn).not.toHaveBeenCalled();
		unmount();
		await tick();
	});
});
