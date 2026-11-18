// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loaderData: {
		current: undefined as { locale: string } | undefined,
	},
	pageProps: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return {
		...actual,
		// The plugin route gate is inert without a registered runtime; the
		// fake keeps the options object and a controllable useLoaderData.
		createPluginFileRoute: () => (path: string) => (opts: Record<string, unknown>) => ({
			path,
			options: opts,
			useLoaderData: () => mocks.loaderData.current,
		}),
	};
});
vi.mock("../fns.ts", () => ({
	localeFn: vi.fn(async () => "pt-BR"),
}));
vi.mock("../views/AdminLoginPage.tsx", () => ({
	AdminLoginPage: (props: Record<string, unknown>) => {
		mocks.pageProps.current = props;
		return createElement("div");
	},
}));

import { Route } from "./login-admin.tsx";

type LoaderData = { locale: string };
type Opts = {
	loader: () => Promise<LoaderData>;
	head: (ctx: { loaderData?: LoaderData }) => { meta: { title: string }[] };
	component: () => ReactElement;
};
const opts = (Route as unknown as { options: Opts }).options;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.loaderData.current = undefined;
	mocks.pageProps.current = undefined;
});

describe("/login/admin route", () => {
	it("loads the active locale", async () => {
		await expect(opts.loader()).resolves.toEqual({ locale: "pt-BR" });
	});

	it("sets the localized admin document title from loader data", () => {
		expect(opts.head({ loaderData: { locale: "pt-BR" } }).meta[0]!.title).toBe(
			"Acesso admin | KTB Health",
		);
		expect(opts.head({ loaderData: { locale: "es" } }).meta[0]!.title).toBe(
			"Acceso admin | KTB Health",
		);
		// Missing loader data falls back to the base locale.
		expect(opts.head({}).meta[0]!.title).toBe("Admin sign in | KTB Health");
	});

	it("renders AdminLoginPage with the loader locale", () => {
		mocks.loaderData.current = { locale: "es" };
		render(createElement(opts.component));
		expect(mocks.pageProps.current).toEqual({ locale: "es" });
	});

	it("falls back to English when the loader data is missing", () => {
		render(createElement(opts.component));
		expect(mocks.pageProps.current).toEqual({ locale: "en" });
	});
});
