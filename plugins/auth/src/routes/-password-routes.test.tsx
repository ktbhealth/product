// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loaderData: {
		current: undefined as { locale: string; emailEnabled: boolean } | undefined,
	},
	search: {
		current: { token: undefined as string | undefined, error: undefined as string | undefined },
	},
	pageProps: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return {
		...actual,
		// The plugin route gate is inert without a registered runtime; the
		// fake keeps the options object plus controllable loader/search data.
		createPluginFileRoute: () => (path: string) => (opts: Record<string, unknown>) => ({
			path,
			options: opts,
			useLoaderData: () => mocks.loaderData.current,
			useSearch: () => mocks.search.current,
		}),
	};
});
vi.mock("../fns.ts", () => ({
	localeFn: vi.fn(async () => "pt-BR"),
	emailEnabledFn: vi.fn(async () => true),
}));
vi.mock("../views/ForgotPasswordPage.tsx", () => ({
	ForgotPasswordPage: (props: Record<string, unknown>) => {
		mocks.pageProps.current = props;
		return createElement("div");
	},
}));
vi.mock("../views/ResetPasswordPage.tsx", () => ({
	ResetPasswordPage: (props: Record<string, unknown>) => {
		mocks.pageProps.current = props;
		return createElement("div");
	},
}));

import { Route as ForgotRoute } from "./forgot-password.tsx";
import { Route as ResetRoute } from "./reset-password.tsx";

type LoaderData = { locale: string; emailEnabled: boolean };
type ForgotOpts = {
	loader: () => Promise<LoaderData>;
	head: (ctx: { loaderData?: LoaderData }) => { meta: { title: string }[] };
	component: () => ReactElement;
};
type ResetOpts = {
	validateSearch: (search: Record<string, unknown>) => {
		token: string | undefined;
		error: string | undefined;
	};
	loader: () => Promise<{ locale: string }>;
	head: (ctx: { loaderData?: { locale: string } }) => { meta: { title: string }[] };
	component: () => ReactElement;
};

const forgotOpts = (ForgotRoute as unknown as { options: ForgotOpts }).options;
const resetOpts = (ResetRoute as unknown as { options: ResetOpts }).options;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.loaderData.current = undefined;
	mocks.search.current = { token: undefined, error: undefined };
	mocks.pageProps.current = undefined;
});

describe("/forgot-password route", () => {
	it("loads the active locale and email capability", async () => {
		await expect(forgotOpts.loader()).resolves.toEqual({
			locale: "pt-BR",
			emailEnabled: true,
		});
	});

	it("sets the localized document title from loader data", () => {
		expect(
			forgotOpts.head({ loaderData: { locale: "pt-BR", emailEnabled: true } }).meta[0]!.title,
		).toBe("Redefinir senha | KTB Health");
		expect(
			forgotOpts.head({ loaderData: { locale: "es", emailEnabled: true } }).meta[0]!.title,
		).toBe("Restablecer contraseña | KTB Health");
		expect(forgotOpts.head({}).meta[0]!.title).toBe("Reset password | KTB Health");
	});

	it("renders ForgotPasswordPage with the loader data", () => {
		mocks.loaderData.current = { locale: "es", emailEnabled: true };
		render(createElement(forgotOpts.component));
		expect(mocks.pageProps.current).toEqual({ locale: "es", emailEnabled: true });
	});

	it("falls back to English without email when the loader data is missing", () => {
		render(createElement(forgotOpts.component));
		expect(mocks.pageProps.current).toEqual({ locale: "en", emailEnabled: false });
	});
});

describe("/reset-password route", () => {
	it("keeps only string token/error params", () => {
		expect(resetOpts.validateSearch({ token: "abc", error: "INVALID_TOKEN", other: 1 })).toEqual({
			token: "abc",
			error: "INVALID_TOKEN",
		});
		expect(resetOpts.validateSearch({ token: 42, error: null })).toEqual({
			token: undefined,
			error: undefined,
		});
		expect(resetOpts.validateSearch({})).toEqual({ token: undefined, error: undefined });
	});

	it("loads the active locale and sets the localized title", async () => {
		await expect(resetOpts.loader()).resolves.toEqual({ locale: "pt-BR" });
		expect(resetOpts.head({ loaderData: { locale: "pt-BR" } }).meta[0]!.title).toBe(
			"Escolha uma nova senha | KTB Health",
		);
		expect(resetOpts.head({}).meta[0]!.title).toBe("Choose a new password | KTB Health");
	});

	it("hands the validated token to the page when the link is good", () => {
		mocks.loaderData.current = { locale: "en", emailEnabled: true };
		mocks.search.current = { token: "tok-9", error: undefined };
		render(createElement(resetOpts.component));
		expect(mocks.pageProps.current).toEqual({
			locale: "en",
			token: "tok-9",
			invalid: false,
		});
	});

	it.each([
		["an api error", { token: "tok-9", error: "INVALID_TOKEN" }],
		["no token", { token: undefined, error: undefined }],
	] as const)("renders the invalid-link state with %s", (_label, search) => {
		mocks.search.current = { ...search };
		render(createElement(resetOpts.component));
		expect(mocks.pageProps.current).toMatchObject({ invalid: true });
	});
});
