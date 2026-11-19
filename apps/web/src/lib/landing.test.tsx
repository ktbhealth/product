// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	plugins: null as unknown[] | null,
	realPlugins: [] as { id: string }[],
	disabledIds: [] as string[],
	theme: { appName: "KTB Health" } as unknown,
	i18n: undefined as unknown,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	const React = await import("react");
	return {
		...actual,
		createFileRoute: () => (opts: Record<string, unknown>) => ({
			options: opts,
			useSearch: () => ({ audience: "doctors" }),
		}),
		useNavigate: () => vi.fn(),
		getRouteApi: () => ({
			useLoaderData: () => ({
				// Resolved theme for the MissingLanding brand (PL-006
				// phase 7) — tests vary it to cover the no-theme path.
				theme: state.theme,
				pluginStates: {
					enabled: (state.plugins ?? state.realPlugins)
						.map((p) => (p as { id: string }).id)
						.filter((id) => !state.disabledIds.includes(id)),
				},
				i18n: state.i18n,
			}),
		}),
		useSearch: (opts: { strict: false; select: (s: Record<string, unknown>) => unknown }) =>
			opts.select({ audience: "doctors" }),
		Link: (props: Record<string, unknown>) => {
			const { to, children, ...rest } = props;
			return React.createElement("a", { href: to as string, ...rest }, children as ReactNode);
		},
	};
});

// Default to the REAL client registry (the audience plugin's landing
// page is a real contribution); tests narrow it via state.plugins.
vi.mock("#/plugins.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/plugins.ts")>();
	state.realPlugins = [...actual.plugins];
	return {
		get plugins() {
			return state.plugins ?? state.realPlugins;
		},
	};
});

// Base UI's Select needs pointer/portal plumbing jsdom lacks.
vi.mock("@ktbhealth/ui/components/select", () => ({
	Select: ({ children }: { children: ReactNode }) => createElement("div", null, children),
	SelectTrigger: ({ children, ...props }: { children: ReactNode }) =>
		createElement("button", props, children),
	SelectValue: () => null,
	SelectContent: ({ children }: { children: ReactNode }) => createElement("ul", null, children),
	SelectItem: ({ children, value }: { children: ReactNode; value: string }) =>
		createElement("li", { "data-value": value }, children),
}));

import { Landing } from "./landing.tsx";

afterEach(() => {
	cleanup();
	state.plugins = null;
	state.disabledIds = [];
	state.theme = { appName: "KTB Health" };
	state.i18n = undefined;
});

describe("Landing dispatch", () => {
	it("renders the audience plugin's landing page", () => {
		render(createElement(Landing));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"The doctor decides. KTB Health records.",
		);
	});

	it("passes the root i18n slice to the landing page", () => {
		state.i18n = { locale: "pt-BR" };
		state.plugins = [
			{
				id: "test.landing",
				landing: {
					page: ({ locale, i18n }: { locale: string; i18n?: { locale: string } }) =>
						createElement("p", { "data-testid": "landing-locale" }, `${locale}|${i18n?.locale}`),
				},
			},
		];
		render(createElement(Landing));
		expect(screen.getByTestId("landing-locale").textContent).toBe("pt-BR|pt-BR");
	});

	it("skips a disabled landing plugin and renders the fallback (P-058)", () => {
		state.disabledIds = ["audience.landing"];
		render(createElement(Landing));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("KTB Health");
	});

	it("renders the fallback when no landing plugin is registered", () => {
		state.plugins = [];
		render(createElement(Landing));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("KTB Health");
		expect(screen.getByText("Consultations").closest("a")?.getAttribute("href")).toBe(
			"/consultations",
		);
	});

	it("renders no brand heading when the theme resolved empty", () => {
		state.plugins = [];
		state.theme = null;
		const { container } = render(createElement(Landing));
		expect(container.querySelector("h1")).toBeNull();
		expect(screen.getByText("Consultations").closest("a")?.getAttribute("href")).toBe(
			"/consultations",
		);
	});
});
