// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as ReactNode),
	};
});

import type { ChromeProps } from "@ktb/kernel";

import { KTB_DEFAULT_THEME } from "../default-theme.ts";
import type { ResolvedTheme } from "../types.ts";
import { ThemeAppBrand } from "./ThemeAppBrand.tsx";

const props = (theme?: unknown): ChromeProps => ({
	user: null,
	locale: "en",
	plugins: [],
	locales: ["en"],
	localeName: (l) => l,
	setLocale: vi.fn(),
	labels: {},
	signOut: vi.fn(async () => {}),
	...(theme !== undefined ? { theme } : {}),
});

const bareTheme = (over: Partial<ResolvedTheme> = {}): ResolvedTheme => ({
	...KTB_DEFAULT_THEME,
	brand: null,
	appName: null,
	...over,
});

afterEach(cleanup);

describe("ThemeAppBrand", () => {
	it("renders the resolved theme's brand mark linking to /", () => {
		render(<ThemeAppBrand {...props(KTB_DEFAULT_THEME)} />);
		const link = screen.getByRole("link");
		expect(link.getAttribute("href")).toBe("/");
		// Logo pair carries the app name as alt text.
		expect(screen.getAllByAltText("KTB Health").length).toBeGreaterThan(0);
	});

	it("renders the app name as text when the theme has no logo assets", () => {
		const theme = bareTheme({ appName: "Acme Care" });
		render(<ThemeAppBrand {...props(theme)} />);
		expect(screen.getByText("Acme Care")).toBeTruthy();
	});

	it("renders nothing without a theme or without any brand data", () => {
		const { container: empty } = render(<ThemeAppBrand {...props()} />);
		expect(empty.innerHTML).toBe("");
		const { container: noBrand } = render(<ThemeAppBrand {...props(bareTheme())} />);
		expect(noBrand.innerHTML).toBe("");
		const { container: nullTheme } = render(<ThemeAppBrand {...props(null)} />);
		expect(nullTheme.innerHTML).toBe("");
	});
});
