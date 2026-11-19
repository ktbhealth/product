// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	publishThemeFn: vi.fn(),
	setThemeEnabledFn: vi.fn(),
	setThemePreviewFn: vi.fn(),
	invalidate: vi.fn(),
	navigate: vi.fn(),
}));

vi.mock("../fns.ts", () => ({
	publishThemeFn: fns.publishThemeFn,
	setThemeEnabledFn: fns.setThemeEnabledFn,
	setThemePreviewFn: fns.setThemePreviewFn,
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: fns.invalidate }),
	useNavigate: () => fns.navigate,
}));

import type { PanelPageContext } from "@ktb/kernel";

import type { ThemeSummary } from "../types.ts";
import { ThemePage } from "./ThemePage.tsx";

const ctx = {
	plugins: [],
	locale: "en",
} as unknown as PanelPageContext;

const summary = (over: Partial<ThemeSummary>): ThemeSummary => ({
	id: 1,
	scope: "tenant",
	scopeId: "acme",
	appName: "Acme",
	enabled: true,
	version: 2,
	...over,
});

const THEMES: ThemeSummary[] = [
	summary({ id: 1, scope: "platform", scopeId: "", appName: "Plat", enabled: true, version: 3 }),
	summary({ id: 2, scope: "tenant", scopeId: "", appName: "Tenant Wide", enabled: false }),
	summary({ id: 3, scope: "tenant", scopeId: "t-1", appName: null, enabled: true }),
	summary({
		id: 4,
		scope: "portal-instance",
		scopeId: "inst-1",
		appName: "Portal Co",
		enabled: true,
	}),
];

const renderPage = (data: unknown = { themes: THEMES }) =>
	render(<ThemePage data={data} ctx={ctx} />);

beforeEach(() => {
	fns.publishThemeFn.mockReset().mockResolvedValue(
		summary({
			id: 9,
			scope: "tenant",
			scopeId: "draft-1",
			appName: null,
			enabled: true,
			version: 1,
		}),
	);
	fns.setThemeEnabledFn.mockReset().mockResolvedValue(undefined);
	fns.setThemePreviewFn.mockReset().mockResolvedValue({ ok: true });
	fns.invalidate.mockReset().mockResolvedValue(undefined);
	fns.navigate.mockReset().mockResolvedValue(undefined);
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
});

describe("ThemePage — list", () => {
	it("renders the empty state and creates a draft on New theme click", async () => {
		const user = userEvent.setup();
		renderPage(null);
		expect(
			screen.getByText("No themes defined yet — the ui defaults apply everywhere."),
		).toBeTruthy();
		await user.click(screen.getAllByRole("button", { name: "New theme" })[0]!);
		await waitFor(() => expect(fns.publishThemeFn).toHaveBeenCalled());
		expect(fns.publishThemeFn).toHaveBeenCalledWith({
			data: expect.objectContaining({ scope: "tenant", seeds: {} }),
		});
		await waitFor(() =>
			expect(fns.navigate).toHaveBeenCalledWith(
				expect.objectContaining({
					to: "/platform/theme/editor",
					search: { id: 9, fresh: "1" },
				}),
			),
		);
	});

	it("lists themes and filters them by search text", async () => {
		const user = userEvent.setup();
		renderPage();
		expect(screen.getByText("Plat")).toBeTruthy();
		expect(screen.getByText("Portal Co")).toBeTruthy();
		await user.type(screen.getByLabelText("Search themes"), "portal co");
		expect(screen.getByText("Portal Co")).toBeTruthy();
		expect(screen.queryByText("Tenant Wide")).toBeNull();
		expect(screen.getByText("1 of 4 themes")).toBeTruthy();
		await user.clear(screen.getByLabelText("Search themes"));
		await user.type(screen.getByLabelText("Search themes"), "zzz");
		expect(screen.getByText("No themes match the search.")).toBeTruthy();
	});

	it("navigates to the editor on Edit", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
		expect(fns.navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "/platform/theme/editor",
				search: { id: 1 },
			}),
		);
	});

	it("toggles a theme's enabled flag", async () => {
		renderPage();
		const switches = screen.getAllByRole("switch");
		expect(switches).toHaveLength(4);
		fireEvent.click(switches[0]!);
		await waitFor(() =>
			expect(fns.setThemeEnabledFn).toHaveBeenCalledWith({
				data: { id: 1, enabled: false },
			}),
		);
		expect(fns.invalidate).toHaveBeenCalled();
	});

	it("shows the discarded-draft toast when the flag is set", () => {
		sessionStorage.setItem("ktb-theme-discarded", "1");
		renderPage();
		expect(screen.getByText("Empty theme discarded.")).toBeTruthy();
		expect(sessionStorage.getItem("ktb-theme-discarded")).toBeNull();
	});
});
