// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	getThemeFn: vi.fn(),
	publishThemeFn: vi.fn(),
	setThemeEnabledFn: vi.fn(),
	setThemePreviewFn: vi.fn(),
	invalidate: vi.fn(),
}));

vi.mock("../fns.ts", () => ({
	getThemeFn: fns.getThemeFn,
	publishThemeFn: fns.publishThemeFn,
	setThemeEnabledFn: fns.setThemeEnabledFn,
	setThemePreviewFn: fns.setThemePreviewFn,
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: fns.invalidate }),
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { ResolvedTheme, ThemeSummary } from "../types.ts";
import { ThemePage } from "./ThemePage.tsx";

const ctx = {
	plugins: [
		{
			id: "p1",
			portals: [{ id: "inst-1", basePath: "/portal", label: "Clinic One" }],
		},
		{ id: "p2" },
	],
	locale: "en",
} as unknown as PanelPageContext;

const summary = (over: Partial<ThemeSummary>): ThemeSummary => ({
	id: 1,
	scope: "platform",
	scopeId: "",
	appName: null,
	enabled: true,
	version: 1,
	...over,
});

const THEMES: ThemeSummary[] = [
	summary({ id: 1, scope: "platform", appName: "Plat", enabled: true, version: 3 }),
	summary({ id: 2, scope: "tenant", scopeId: "", appName: "Tenant Wide", enabled: false }),
	summary({ id: 3, scope: "tenant", scopeId: "t-1", appName: null, enabled: true }),
	summary({ id: 4, scope: "portal-instance", scopeId: "", appName: null, enabled: true }),
	summary({
		id: 5,
		scope: "portal-instance",
		scopeId: "inst-1",
		appName: "Portal Co",
		enabled: true,
	}),
];

const resolved = (over: Partial<ResolvedTheme>): ResolvedTheme =>
	({
		id: 1,
		scope: "platform",
		scopeId: "",
		appName: null,
		seeds: {},
		tokens: { light: {}, dark: {} },
		styleCss: "",
		fonts: null,
		fontLinks: [],
		fontFaceCss: "",
		brand: null,
		...over,
	}) as ResolvedTheme;

const FULL_THEME = resolved({
	id: 1,
	appName: null,
	seeds: {
		primary: "#112233",
		secondary: "#445566",
		accent: "#778899",
		background: "#fafafa",
		foreground: "#111111",
		destructive: "#990000",
		radius: "0.5rem",
		dark: { primary: "#ddeeff", background: "#101010" },
	},
	fonts: {
		delivery: "google-fonts",
		families: { sans: "Inter", heading: "Inter Tight", mono: "JetBrains Mono" },
	},
	brand: { appName: "Brand Co" },
});

const BARE_THEME = resolved({
	id: 2,
	appName: "Direct Name",
	seeds: {},
	fonts: { delivery: "self-host" },
	brand: null,
});

/** No brand, no fonts, no app name — exercises every `??` fallback. */
const NULLISH_THEME = resolved({ id: 4 });

const deferred = <T,>() => {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const renderPage = (data: unknown = { themes: THEMES }) =>
	render(<ThemePage data={data} ctx={ctx} />);

const change = (el: Element, value: string) => fireEvent.change(el, { target: { value } });

/** Picks an option from a design-system Select (trigger is aria-labelled). */
const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
	await user.click(screen.getByLabelText(label));
	await user.click(await screen.findByRole("option", { name: option }));
};

const fileInput = () => document.getElementById("asset-file") as HTMLInputElement;
const byId = (id: string) => document.getElementById(id) as HTMLElement;

beforeEach(() => {
	fns.getThemeFn.mockReset();
	fns.publishThemeFn.mockReset().mockResolvedValue({ id: 9 });
	fns.setThemeEnabledFn.mockReset().mockResolvedValue(undefined);
	fns.setThemePreviewFn.mockReset().mockResolvedValue({ ok: true });
	fns.invalidate.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("ThemePage — rendering", () => {
	it("renders the empty state for null, missing and empty theme lists", () => {
		const { unmount } = renderPage(null);
		expect(
			screen.getByText("No themes defined yet — the ui defaults apply everywhere."),
		).toBeTruthy();
		unmount();

		renderPage({});
		expect(screen.getAllByText(/No themes defined yet/).length).toBeGreaterThan(0);
		// No themes → no upload target → upload controls stay disabled.
		expect(document.getElementById("asset-file") as HTMLInputElement).toBeTruthy();
	});

	it("lists every theme with scope labels, scope ids and names", () => {
		renderPage();
		// Scope column variants — read the table cells (the same labels
		// also appear as <option> text in the scope picker).
		const cells = [...document.querySelectorAll('[data-slot="table-cell"]')].map(
			(c) => c.textContent,
		);
		expect(cells).toContain("Platform default");
		expect(cells).toContain("Tenant");
		expect(cells).toContain("Tenant #t-1");
		expect(cells).toContain("Portal instance");
		expect(cells).toContain("Portal instance · inst-1");
		// Empty scope ids and missing names fall back to em dashes.
		expect(cells.filter((c) => c === "—").length).toBeGreaterThanOrEqual(3);
		// Named rows carry their app name (+ version suffix); unnamed → —.
		expect(cells.some((c) => c?.startsWith("Plat"))).toBe(true);
		expect(cells.some((c) => c?.startsWith("Portal Co"))).toBe(true);
		// Switches expose per-theme aria labels.
		expect(screen.getByLabelText("Plat")).toBeTruthy();
		expect(screen.getByLabelText("theme-3")).toBeTruthy();
	});
});

describe("ThemePage — editing", () => {
	it("loads a full theme into every editor section", async () => {
		fns.getThemeFn.mockResolvedValue(FULL_THEME);
		renderPage();
		fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
		await waitFor(() => expect(byId("theme-app-name")).toHaveProperty("value", "Brand Co"));
		// Seed fields hydrate from the row.
		expect(byId("seed-primary")).toHaveProperty("value", "#112233");
		expect(byId("seed-radius")).toHaveProperty("value", "0.5rem");
		// Dark overrides hydrate the second SeedInputs instance.
		const darkPrimary = document.querySelectorAll("#seed-primary")[1]!;
		expect(darkPrimary).toHaveProperty("value", "#ddeeff");
		// Fonts + delivery hydrate; google delivery shows its warning.
		expect(screen.getByLabelText("Font delivery").textContent).toContain("Google Fonts link");
		expect(screen.getByText(/sends visitor requests to Google/)).toBeTruthy();
		expect(byId("theme-font-sans")).toHaveProperty("value", "Inter");
		expect(byId("theme-font-heading")).toHaveProperty("value", "Inter Tight");
		expect(byId("theme-font-mono")).toHaveProperty("value", "JetBrains Mono");
	});

	it("loads sparse themes and tolerates a missing row", async () => {
		fns.getThemeFn.mockImplementation(({ data }: { data: { id: number } }) =>
			Promise.resolve(data.id === 2 ? BARE_THEME : data.id === 3 ? null : NULLISH_THEME),
		);
		renderPage();
		const edits = screen.getAllByRole("button", { name: "Edit" });
		// Missing row → early return, form untouched.
		fireEvent.click(edits[2]!);
		await waitFor(() => expect(fns.getThemeFn).toHaveBeenCalledWith({ data: { id: 3 } }));
		expect(byId("theme-app-name")).toHaveProperty("value", "");
		// Sparse theme → fallbacks everywhere (self-host, blank families).
		fireEvent.click(edits[1]!);
		await waitFor(() => expect(byId("theme-app-name")).toHaveProperty("value", "Direct Name"));
		expect(screen.getByLabelText("Font delivery").textContent).toContain(
			"Self-hosted (recommended)",
		);
		expect(byId("theme-font-sans")).toHaveProperty("value", "");
		// Empty seeds → every seed field blank.
		expect(byId("seed-primary")).toHaveProperty("value", "");
		// Nullish theme → app name falls back to "" and fonts to self-host.
		fireEvent.click(edits[3]!);
		await waitFor(() => expect(fns.getThemeFn).toHaveBeenCalledWith({ data: { id: 4 } }));
		expect(byId("theme-app-name")).toHaveProperty("value", "");
		expect(screen.getByLabelText("Font delivery").textContent).toContain(
			"Self-hosted (recommended)",
		);
	});
});

describe("ThemePage — scope picker", () => {
	it("reveals the scope id input and portal datalist per scope", async () => {
		const user = userEvent.setup();
		renderPage();
		expect(document.getElementById("theme-scope-id")).toBeNull();
		await choose(user, "Scope", "Tenant");
		expect(document.getElementById("theme-scope-id")).toBeTruthy();
		expect(document.getElementById("theme-portal-ids")).toBeNull();
		await choose(user, "Scope", "Portal instance");
		expect(document.getElementById("theme-portal-ids")).toBeTruthy();
		// Portal instance ids come from the plugin registry.
		const options = document.querySelectorAll("#theme-portal-ids option");
		expect(options).toHaveLength(1);
		expect(options[0]).toHaveProperty("value", "inst-1");
		await choose(user, "Scope", "Platform default");
		expect(document.getElementById("theme-scope-id")).toBeNull();
	});
});

describe("ThemePage — publish", () => {
	it("publishes platform scope with derived empty payload", async () => {
		fns.publishThemeFn.mockResolvedValue({ id: 1 });
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: "Publish theme" }));
		await screen.findByText("Theme published");
		const payload = fns.publishThemeFn.mock.calls[0]![0].data;
		expect(payload).toMatchObject({
			scope: "platform",
			scopeId: "",
			appName: null,
			fonts: null,
		});
		// Every seed field blank → all undefined; no dark overrides.
		expect(payload.seeds).toEqual({
			primary: undefined,
			secondary: undefined,
			accent: undefined,
			background: undefined,
			foreground: undefined,
			destructive: undefined,
			radius: undefined,
		});
		expect(fns.invalidate).toHaveBeenCalled();
	});

	it("publishes tenant scope with seeds, dark overrides, fonts and app name", async () => {
		const user = userEvent.setup();
		renderPage();
		await choose(user, "Scope", "Tenant");
		change(byId("theme-scope-id"), "  t-9  ");
		change(byId("theme-app-name"), "  My Clinic  ");
		change(byId("seed-primary"), "#123456");
		change(byId("seed-radius"), "1rem");
		// Dark seed → seeds.dark ships.
		const darkPrimary = document.querySelectorAll("#seed-primary")[1]!;
		change(darkPrimary, "#abcdef");
		// All three families filled → fonts object with trimmed values.
		change(byId("theme-font-sans"), " Inter ");
		change(byId("theme-font-heading"), "Heading Face");
		change(byId("theme-font-mono"), "Mono Face");
		fireEvent.click(screen.getByRole("button", { name: "Publish theme" }));
		await screen.findByText("Theme published");
		const payload = fns.publishThemeFn.mock.calls[0]![0].data;
		expect(payload).toMatchObject({
			scope: "tenant",
			scopeId: "t-9",
			appName: "My Clinic",
			fonts: {
				delivery: "self-host",
				families: { sans: "Inter", heading: "Heading Face", mono: "Mono Face" },
			},
		});
		expect(payload.seeds).toMatchObject({
			primary: "#123456",
			radius: "1rem",
			dark: { primary: "#abcdef" },
		});
	});

	it("wires the remaining editor controls", async () => {
		const user = userEvent.setup();
		renderPage();
		// Font delivery switch shows the Google Fonts warning.
		await choose(user, "Font delivery", "Google Fonts link");
		expect(screen.getByText(/sends visitor requests to Google/)).toBeTruthy();
		// Brand app name input shares the appName state.
		change(byId("theme-brand-name"), "Brand Typed");
		expect(byId("theme-app-name")).toHaveProperty("value", "Brand Typed");
		// Asset target select retargets uploads to the picked theme.
		await choose(user, "Theme", "Tenant Wide");
		expect(screen.getByLabelText("Theme").textContent).toContain("Tenant Wide");
		// File input cleared/emptied → assetFile null.
		const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
		fireEvent.change(fileInput(), { target: { files: [file] } });
		fireEvent.change(fileInput(), { target: { files: [] } });
	});

	it("shows the publishing state and the error notice on failure", async () => {
		const pending = deferred<{ id: number }>();
		fns.publishThemeFn.mockReturnValue(pending.promise);
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: "Publish theme" }));
		// The spinner's aria-label joins the accessible name.
		expect(await screen.findByRole("button", { name: /Publishing…/ })).toBeTruthy();
		await act(async () => pending.reject(new Error("nope")));
		expect(await screen.findByText("Publish failed")).toBeTruthy();
	});
});

describe("ThemePage — toggle, preview and contrast", () => {
	it("toggles a theme's enabled flag", async () => {
		renderPage();
		const switches = screen.getAllByRole("switch");
		expect(switches).toHaveLength(5);
		fireEvent.click(switches[0]!);
		await waitFor(() =>
			expect(fns.setThemeEnabledFn).toHaveBeenCalledWith({ data: { id: 1, enabled: false } }),
		);
		expect(fns.invalidate).toHaveBeenCalled();
	});

	it("sets the preview cookie and reloads", async () => {
		const pending = deferred<{ ok: boolean }>();
		fns.setThemePreviewFn.mockReturnValue(pending.promise);
		const reload = vi.fn();
		vi.stubGlobal("location", { reload });
		renderPage();
		fireEvent.click(screen.getAllByRole("button", { name: "Preview" })[1]!);
		await waitFor(() =>
			expect(fns.setThemePreviewFn).toHaveBeenCalledWith({ data: { themeId: 2 } }),
		);
		await act(async () => pending.resolve({ ok: true }));
		expect(reload).toHaveBeenCalled();
	});

	it("surfaces failing contrast pairs when seeds break AA", async () => {
		renderPage();
		// #777 background makes the derived ring pairing miss AA.
		change(byId("seed-background"), "#777777");
		expect((await screen.findAllByText("below AA")).length).toBeGreaterThan(0);
	});
});

describe("ThemePage — asset uploads", () => {
	const okFetch = () => vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

	it("uploads a logo file and confirms the queued job", async () => {
		const fetchMock = okFetch();
		vi.stubGlobal("fetch", fetchMock);
		renderPage();
		const file = new File([new Uint8Array([137, 80])], "logo.png", { type: "image/png" });
		fireEvent.change(fileInput(), { target: { files: [file] } });
		fireEvent.click(screen.getByRole("button", { name: "Upload" }));
		await screen.findByText("Upload queued — variants are generated asynchronously.");
		const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
		expect(url).toBe("/api/theme/assets");
		const form = init.body as FormData;
		expect(form.get("kind")).toBe("logo-light");
		expect(form.get("themeId")).toBe("1");
		expect(form.get("family")).toBeNull();
	});

	it("uploads a font with family fallback and slot", async () => {
		const user = userEvent.setup();
		const fetchMock = okFetch();
		vi.stubGlobal("fetch", fetchMock);
		renderPage();
		await choose(user, "Asset kind", "font");
		await choose(user, "Font slot", "mono");
		const file = new File([new Uint8Array([1, 2])], "My Font.woff2", {
			type: "font/woff2",
		});
		fireEvent.change(fileInput(), { target: { files: [file] } });
		fireEvent.click(screen.getByRole("button", { name: "Upload" }));
		await screen.findByText(/Upload queued/);
		const form = (fetchMock.mock.calls[0]![1] as RequestInit).body as FormData;
		// Empty family field → derived from the file name.
		expect(form.get("family")).toBe("My Font");
		expect(form.get("slot")).toBe("mono");
	});

	it("prefers an explicit font family over the file-name fallback", async () => {
		const user = userEvent.setup();
		const fetchMock = okFetch();
		vi.stubGlobal("fetch", fetchMock);
		renderPage();
		await choose(user, "Asset kind", "font");
		change(byId("asset-font-family"), "Custom Family");
		const file = new File([new Uint8Array([1])], "x.woff2", { type: "font/woff2" });
		fireEvent.change(fileInput(), { target: { files: [file] } });
		fireEvent.click(screen.getByRole("button", { name: "Upload" }));
		await screen.findByText(/Upload queued/);
		const form = (fetchMock.mock.calls[0]![1] as RequestInit).body as FormData;
		expect(form.get("family")).toBe("Custom Family");
	});

	it("shows the upload error notice when the request fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
		renderPage();
		const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
		fireEvent.change(fileInput(), { target: { files: [file] } });
		fireEvent.click(screen.getByRole("button", { name: "Upload" }));
		expect(await screen.findByText("Upload failed")).toBeTruthy();
	});

	it("fetches a Google font and reports failures", async () => {
		const fetchMock = okFetch();
		vi.stubGlobal("fetch", fetchMock);
		renderPage();
		const input = screen.getByLabelText("Font family");
		change(input, "Inter");
		fireEvent.click(screen.getByRole("button", { name: "Fetch from Google Fonts" }));
		await screen.findByText(/Upload queued/);
		const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
		expect(url).toBe("/api/theme/fonts");
		expect(JSON.parse(String(init.body))).toEqual({
			themeId: 1,
			family: "Inter",
			slot: "sans",
		});
	});

	it("shows the google fetch error notice", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 } as Response));
		renderPage();
		change(screen.getByLabelText("Font family"), "Nope");
		fireEvent.click(screen.getByRole("button", { name: "Fetch from Google Fonts" }));
		expect(await screen.findByText("Font fetch failed")).toBeTruthy();
	});
});
