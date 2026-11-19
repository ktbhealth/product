// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	publishThemeFn: vi.fn(),
	setThemeEnabledFn: vi.fn(),
	setThemeMainFn: vi.fn(),
	deleteThemeFn: vi.fn(),
	setThemePreviewFn: vi.fn(),
	invalidate: vi.fn(),
	navigate: vi.fn(),
}));

vi.mock("../fns.ts", () => ({
	publishThemeFn: fns.publishThemeFn,
	setThemeEnabledFn: fns.setThemeEnabledFn,
	setThemeMainFn: fns.setThemeMainFn,
	deleteThemeFn: fns.deleteThemeFn,
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
	isMain: false,
	version: 2,
	...over,
});

const THEMES: ThemeSummary[] = [
	summary({
		id: 1,
		scope: "platform",
		scopeId: "",
		appName: "Plat",
		enabled: true,
		isMain: true,
		version: 3,
	}),
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
	fns.setThemeMainFn.mockReset().mockResolvedValue({ ok: true });
	fns.deleteThemeFn.mockReset().mockResolvedValue({ ok: true });
	fns.setThemePreviewFn.mockReset().mockResolvedValue({ ok: true });
	fns.invalidate.mockReset().mockResolvedValue(undefined);
	fns.navigate.mockReset().mockResolvedValue(undefined);
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
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
		// Wait for the busy flag to clear before re-clicking.
		await waitFor(() => expect(fns.navigate).toHaveBeenCalled());
		// The empty-state body offers the same action a second time.
		await user.click(screen.getAllByRole("button", { name: "New theme" })[1]!);
		await waitFor(() => expect(fns.publishThemeFn).toHaveBeenCalledTimes(2));
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

	it("dismisses the discarded-draft toast", async () => {
		sessionStorage.setItem("ktb-theme-discarded", "1");
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
		expect(screen.queryByText("Empty theme discarded.")).toBeNull();
	});

	it("ignores further create clicks while a publish is in flight", async () => {
		// Never settles — the busy flag stays up for the whole test.
		fns.publishThemeFn.mockReturnValue(new Promise<ThemeSummary>(() => {}));
		renderPage(null);
		const buttons = screen.getAllByRole("button", { name: "New theme" });
		fireEvent.click(buttons[0]!);
		await waitFor(() => expect(fns.publishThemeFn).toHaveBeenCalledTimes(1));
		// Both buttons disable while busy; a raw DOM click still reaches
		// the handler and the busy guard drops it.
		fireEvent.click(buttons[0]!);
		fireEvent.click(buttons[1]!);
		expect(fns.publishThemeFn).toHaveBeenCalledTimes(1);
	});

	it("surfaces a notice when creating a draft fails", async () => {
		fns.publishThemeFn.mockRejectedValueOnce(new Error("nope"));
		const user = userEvent.setup();
		renderPage(null);
		await user.click(screen.getAllByRole("button", { name: "New theme" })[0]!);
		await waitFor(() => expect(screen.getByText("Publish failed")).toBeTruthy());
	});
});

describe("ThemePage — main row and row actions", () => {
	it("badges the main row and hides its Set main/Delete actions", () => {
		renderPage();
		expect(screen.getByText("Main")).toBeTruthy();
		// 4 themes, 1 main → 3 Set main + 3 Delete buttons.
		expect(screen.getAllByRole("button", { name: "Set main" })).toHaveLength(3);
		expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(3);
	});

	it("calls setThemeMainFn and invalidates on Set main", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Set main" })[0]!);
		await waitFor(() => expect(fns.setThemeMainFn).toHaveBeenCalledWith({ data: { id: 2 } }));
		expect(screen.getByText("Main theme updated")).toBeTruthy();
		expect(fns.invalidate).toHaveBeenCalled();
	});

	it("surfaces a notice when Set main fails", async () => {
		fns.setThemeMainFn.mockRejectedValueOnce(new Error("nope"));
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Set main" })[0]!);
		await waitFor(() => expect(screen.getByText("Publish failed")).toBeTruthy());
	});

	it("previews a theme through the server fn and reloads", async () => {
		let resolvePreview!: (value: { readonly ok: boolean }) => void;
		fns.setThemePreviewFn.mockReturnValue(
			new Promise<{ readonly ok: boolean }>((resolve) => {
				resolvePreview = resolve;
			}),
		);
		const reload = vi.fn<() => void>();
		vi.stubGlobal("location", { reload });
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Preview" })[0]!);
		expect(fns.setThemePreviewFn).toHaveBeenCalledWith({ data: { themeId: 1 } });
		// The busy row swaps label + spinner while the fn is in flight
		// (the Spinner's own aria-label joins the accessible name).
		expect(await screen.findByText("Previewing…")).toBeTruthy();
		await act(async () => resolvePreview({ ok: true }));
		expect(reload).toHaveBeenCalled();
	});

	it("confirms before deleting and calls deleteThemeFn", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText("Delete this theme? This cannot be undone.")).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(fns.deleteThemeFn).toHaveBeenCalledWith({ data: { id: 2 } }));
		expect(fns.invalidate).toHaveBeenCalled();
	});

	it("surfaces a notice when the delete fails", async () => {
		fns.deleteThemeFn.mockRejectedValueOnce(new Error("cannot delete the main theme"));
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.getByText("Could not delete theme")).toBeTruthy());
	});
});
