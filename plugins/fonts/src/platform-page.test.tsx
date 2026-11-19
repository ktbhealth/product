// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	createFontProviderFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	updateFontProviderFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	setFontProviderEnabledFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	removeFontProviderFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	listFontFamiliesFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
	syncFontProviderFn: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

vi.mock("./fns.ts", () => ({
	createFontProviderFn: fns.createFontProviderFn,
	updateFontProviderFn: fns.updateFontProviderFn,
	setFontProviderEnabledFn: fns.setFontProviderEnabledFn,
	removeFontProviderFn: fns.removeFontProviderFn,
	listFontFamiliesFn: fns.listFontFamiliesFn,
	syncFontProviderFn: fns.syncFontProviderFn,
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn<() => Promise<void>>() }),
	useNavigate: () => vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import { FontProvidersPlatformPage, FontsPlatformPage } from "./platform-page.tsx";

const ctx = { plugins: [], locale: "en" } as unknown as PanelPageContext;

afterEach(cleanup);

describe("FontProvidersPlatformPage", () => {
	it("renders the providers table from loader data", () => {
		render(
			<FontProvidersPlatformPage
				data={{
					providers: [
						{
							id: 1,
							kind: "googlefonts",
							name: "Google Fonts",
							config: null,
							enabled: true,
							familyCount: 46,
							createdAt: "2025-01-01T00:00:00.000Z",
							updatedAt: null,
						},
					],
					kinds: ["googlefonts", "local"],
				}}
				ctx={ctx}
			/>,
		);
		expect(document.querySelector('[data-slot="page-header-title"]')?.textContent).toBe(
			"Font providers",
		);
		expect(screen.getByText("Google Fonts")).toBeTruthy();
		expect(screen.getByText("googlefonts")).toBeTruthy();
	});

	it("renders the empty state on a null payload", () => {
		render(<FontProvidersPlatformPage data={null} ctx={ctx} />);
		expect(document.querySelector('[data-slot="page-header-title"]')?.textContent).toBe(
			"Font providers",
		);
		expect(
			screen.getByText("No font providers yet — add one to start syncing families."),
		).toBeTruthy();
	});
});

describe("FontsPlatformPage", () => {
	it("renders the families table with weights and status", () => {
		render(
			<FontsPlatformPage
				data={{
					providers: [
						{
							id: 1,
							kind: "googlefonts",
							name: "Google Fonts",
							config: null,
							enabled: true,
							familyCount: 1,
							createdAt: "2025-01-01T00:00:00.000Z",
							updatedAt: null,
						},
					],
					families: [
						{
							id: 9,
							providerId: 1,
							family: "Inter",
							weights: [400, 700],
							status: "ready",
							meta: null,
						},
					],
				}}
				ctx={ctx}
			/>,
		);
		expect(document.querySelector('[data-slot="page-header-title"]')?.textContent).toBe("Fonts");
		expect(screen.getByText("Inter")).toBeTruthy();
		expect(screen.getByText("400")).toBeTruthy();
		expect(screen.getByText("Ready")).toBeTruthy();
	});

	it("renders the empty state when no families exist", () => {
		render(<FontsPlatformPage data={{ providers: [], families: [] }} ctx={ctx} />);
		expect(screen.getByText("No font families synced yet — sync a provider first.")).toBeTruthy();
	});
});
