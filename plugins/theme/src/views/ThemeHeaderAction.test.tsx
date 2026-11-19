// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	listThemesFn: vi.fn(),
	setThemePreviewFn: vi.fn(),
}));

vi.mock("../fns.ts", () => ({
	listThemesFn: fns.listThemesFn,
	setThemePreviewFn: fns.setThemePreviewFn,
}));

import type { ThemeSummary } from "../types.ts";
import { ThemeHeaderAction } from "./ThemeHeaderAction.tsx";

const summary = (over: Partial<ThemeSummary>): ThemeSummary => ({
	id: 1,
	scope: "platform",
	scopeId: "",
	appName: null,
	enabled: true,
	isMain: false,
	version: 1,
	...over,
});

const THEMES: ThemeSummary[] = [
	summary({ id: 1, scope: "platform", appName: "Platform Theme" }),
	summary({ id: 2, scope: "tenant", scopeId: "", appName: "Tenant Wide" }),
	summary({
		id: 3,
		scope: "tenant",
		scopeId: "t-42",
		appName: null,
		enabled: false,
	}),
	summary({ id: 4, scope: "portal-instance", scopeId: "", appName: null }),
	summary({
		id: 5,
		scope: "portal-instance",
		scopeId: "inst-9",
		appName: "Portal Co",
	}),
];

const deferred = <T,>() => {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	fns.listThemesFn.mockReset();
	fns.setThemePreviewFn.mockReset();
});

describe("ThemeHeaderAction", () => {
	it("renders nothing while the list is empty, null or failed", async () => {
		fns.listThemesFn.mockResolvedValue([]);
		const { container, unmount } = render(<ThemeHeaderAction locale="en" />);
		await act(async () => {});
		expect(container.innerHTML).toBe("");
		unmount();

		fns.listThemesFn.mockRejectedValue(new Error("denied"));
		const { container: failed } = render(<ThemeHeaderAction locale="en" />);
		await act(async () => {});
		expect(failed.innerHTML).toBe("");
	});

	it("ignores late resolutions after unmount", async () => {
		const pending = deferred<ThemeSummary[]>();
		fns.listThemesFn.mockReturnValue(pending.promise);
		const first = render(<ThemeHeaderAction locale="en" />);
		first.unmount();
		await act(async () => pending.resolve(THEMES));

		const rejected = deferred<ThemeSummary[]>();
		fns.listThemesFn.mockReturnValue(rejected.promise);
		const second = render(<ThemeHeaderAction locale="en" />);
		second.unmount();
		await act(async () => rejected.reject(new Error("late")));
	});

	it("lists themes with scope labels and disables non-enabled previews", async () => {
		fns.listThemesFn.mockResolvedValue(THEMES);
		const user = userEvent.setup();
		render(<ThemeHeaderAction locale="en" />);
		const trigger = await screen.findByRole("button", { name: "Theme" });
		expect(trigger).toBeTruthy();
		await user.click(trigger);

		// Named rows show the app name; unnamed fall back to scope labels.
		expect(await screen.findByText("Platform Theme")).toBeTruthy();
		expect(screen.getByText("platform")).toBeTruthy();
		expect(screen.getByText("tenant · t-42 · disabled")).toBeTruthy();
		expect(screen.getByText("portal · —")).toBeTruthy();
		expect(screen.getByText("Portal Co")).toBeTruthy();

		// The disabled theme's preview button is inert; enabled ones work.
		const previewButtons = screen.getAllByRole("button", { name: "Preview" });
		expect(previewButtons).toHaveLength(5);
		expect((previewButtons[2] as HTMLButtonElement).disabled).toBe(true);
		expect((previewButtons[0] as HTMLButtonElement).disabled).toBe(false);

		expect(screen.getByRole("link", { name: "Manage themes" })).toBeTruthy();
	});

	it("previews a theme through the server fn and reloads", async () => {
		fns.listThemesFn.mockResolvedValue(THEMES);
		const pending = deferred<{ ok: boolean }>();
		fns.setThemePreviewFn.mockReturnValue(pending.promise);
		const reload = vi.fn();
		vi.stubGlobal("location", { reload });
		const user = userEvent.setup();
		render(<ThemeHeaderAction locale="en" />);
		await user.click(await screen.findByRole("button", { name: "Theme" }));

		const buttons = await screen.findAllByRole("button", { name: "Preview" });
		await user.click(buttons[0]!);
		expect(fns.setThemePreviewFn).toHaveBeenCalledWith({
			data: { themeId: 1 },
		});
		// Busy state swaps the label while the fn is in flight.
		expect(await screen.findByRole("button", { name: "Previewing…" })).toBeTruthy();
		await act(async () => pending.resolve({ ok: true }));
		expect(reload).toHaveBeenCalled();
	});
});
