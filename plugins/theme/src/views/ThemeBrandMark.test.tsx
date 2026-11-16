// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KTB_DEFAULT_THEME } from "../default-theme.ts";
import type { ResolvedTheme } from "../types.ts";
import { ThemeBrandMark } from "./ThemeBrandMark.tsx";

const theme = (over: Partial<ResolvedTheme> = {}): ResolvedTheme => ({
	...KTB_DEFAULT_THEME,
	brand: null,
	appName: null,
	...over,
});

afterEach(cleanup);

describe("ThemeBrandMark", () => {
	it("renders nothing without a theme", () => {
		const { container } = render(<ThemeBrandMark theme={null} />);
		expect(container.innerHTML).toBe("");
		const { container: undef } = render(<ThemeBrandMark theme={undefined} />);
		expect(undef.innerHTML).toBe("");
	});

	it("renders the light logo alone when only logoLight is set", () => {
		render(
			<ThemeBrandMark
				theme={theme({
					appName: "Acme",
					brand: { logoLight: "/l-light.svg" },
				})}
			/>,
		);
		const img = screen.getByAltText("Acme");
		expect(img.getAttribute("src")).toBe("/l-light.svg");
		expect(img.className).toContain("dark:hidden");
	});

	it("falls back to an empty alt when no name exists anywhere", () => {
		render(<ThemeBrandMark theme={theme({ brand: { logoLight: "/l.svg" } })} />);
		expect(screen.getByAltText("").getAttribute("src")).toBe("/l.svg");
		cleanup();
		render(<ThemeBrandMark theme={theme({ brand: { wordmark: "/w.svg" } })} />);
		expect(screen.getByAltText("").getAttribute("src")).toBe("/w.svg");
	});

	it("renders the dark logo alone when only logoDark is set", () => {
		render(
			<ThemeBrandMark
				theme={theme({
					brand: { logoDark: "/l-dark.svg" },
				})}
			/>,
		);
		const img = screen.getByAltText("");
		expect(img.getAttribute("src")).toBe("/l-dark.svg");
		expect(img.className).toContain("dark:block");
	});

	it("renders both logo variants when both are set", () => {
		render(
			<ThemeBrandMark
				theme={theme({
					appName: "Pair Co",
					brand: { logoLight: "/a.svg", logoDark: "/b.svg" },
				})}
			/>,
		);
		expect(screen.getAllByAltText("Pair Co")).toHaveLength(2);
	});

	it("renders the wordmark when no logo pair exists", () => {
		render(
			<ThemeBrandMark
				theme={theme({
					appName: "Word Co",
					brand: { wordmark: "/wm.svg" },
				})}
			/>,
		);
		const img = screen.getByAltText("Word Co");
		expect(img.getAttribute("src")).toBe("/wm.svg");
	});

	it("prefers brand.appName for alt text when theme.appName is absent", () => {
		render(
			<ThemeBrandMark theme={theme({ brand: { appName: "Brand Name", logoLight: "/l.svg" } })} />,
		);
		expect(screen.getByAltText("Brand Name")).toBeTruthy();
	});

	it("renders the app name as text when there are no image assets", () => {
		render(<ThemeBrandMark theme={theme({ appName: "Text Co" })} />);
		expect(screen.getByText("Text Co")).toBeTruthy();
	});

	it("renders nothing for empty app names and empty brands", () => {
		const { container: empty } = render(
			<ThemeBrandMark theme={theme({ appName: "", brand: { appName: null } })} />,
		);
		expect(empty.innerHTML).toBe("");
		const { container: bare } = render(<ThemeBrandMark theme={theme()} />);
		expect(bare.innerHTML).toBe("");
	});
});
