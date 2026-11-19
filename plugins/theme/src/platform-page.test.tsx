// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	getThemeFn: vi.fn(),
	publishThemeFn: vi.fn(),
	setThemeEnabledFn: vi.fn(),
	deleteThemeFn: vi.fn(),
	setThemePreviewFn: vi.fn(),
}));

vi.mock("./fns.ts", () => ({
	getThemeFn: fns.getThemeFn,
	publishThemeFn: fns.publishThemeFn,
	setThemeEnabledFn: fns.setThemeEnabledFn,
	deleteThemeFn: fns.deleteThemeFn,
	setThemePreviewFn: fns.setThemePreviewFn,
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn() }),
	useNavigate: () => vi.fn(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { ThemePlatformPage } from "./platform-page.tsx";

const ctx = { plugins: [], locale: "en" } as unknown as PanelPageContext;

afterEach(cleanup);

describe("ThemePlatformPage", () => {
	it("forwards data and ctx into the theme editor", () => {
		render(<ThemePlatformPage data={{ themes: [] }} ctx={ctx} />);
		expect(document.querySelector('[data-slot="page-header-title"]')?.textContent).toBe("Theme");
		expect(
			screen.getByText("No themes defined yet — the ui defaults apply everywhere."),
		).toBeTruthy();
	});

	it("tolerates a null loader payload", () => {
		render(<ThemePlatformPage data={null} ctx={ctx} />);
		expect(document.querySelector('[data-slot="page-header-title"]')?.textContent).toBe("Theme");
	});
});
