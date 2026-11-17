// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	invitePreviewFn: vi.fn(),
	acceptInviteFn: vi.fn(),
	localeFn: vi.fn(async () => "pt-BR"),
	loaderData: { current: undefined as unknown },
	props: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("./fns.ts", () => ({
	invitePreviewFn: mocks.invitePreviewFn,
	acceptInviteFn: mocks.acceptInviteFn,
	localeFn: mocks.localeFn,
}));
vi.mock("./views/index.ts", () => ({
	AcceptInvitePage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "accept-invite" });
	},
}));
// Server fns become plain async calls; with no runtime registered the
// plugin route gate (createPluginFileRoute → pluginEnabledFn) is inert.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((value: unknown) => unknown) | undefined;
		const api = {
			validator: (fn: (value: unknown) => unknown) => {
				validate = fn;
				return api;
			},
			handler: (h: (arg: { data: unknown }) => unknown) => async (call: { data?: unknown }) =>
				h({
					data: validate === undefined ? call?.data : validate(call?.data),
				}),
		};
		return api;
	},
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		getRouteApi: () => ({ useLoaderData: () => ({ i18n: undefined }) }),
		createFileRoute: () => (opts: Record<string, unknown>) => ({
			options: opts,
			useLoaderData: () => mocks.loaderData.current,
		}),
	};
});

import { Route } from "./routes/index.tsx";

const options = (
	Route as unknown as {
		options: {
			loader: () => Promise<unknown>;
			head: (arg: { loaderData?: string }) => {
				meta: Record<string, string>[];
			};
			component: () => ReactElement;
		};
	}
).options;

const invite = {
	email: "sec@ktb.test",
	kind: "secretary",
	inviterName: "Dra. Ana",
	accountExists: false,
};

type PageProps = {
	invite: unknown;
	locale: string;
	api: { accept(input: { name: string; password: string }): Promise<unknown> };
};
const pageProps = () => mocks.props.current as PageProps;

/** The route's own placeholder while the link is being looked up. */
const lookupSpinner = (container: HTMLElement) => container.querySelector('div[role="status"]');

beforeEach(() => {
	vi.clearAllMocks();
	mocks.props.current = undefined;
	mocks.loaderData.current = "en";
	window.location.hash = "#tok-abc";
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
});

describe("/invite", () => {
	it("loads only the locale — the token never reaches the loader", async () => {
		await expect(options.loader()).resolves.toBe("pt-BR");
		expect(mocks.invitePreviewFn).not.toHaveBeenCalled();
	});

	it("titles the document in the loaded locale and keeps it out of search indexes", () => {
		expect(options.head({ loaderData: "pt-BR" }).meta).toEqual([
			{ title: "Aceitar convite | KTB Health" },
			{ name: "robots", content: "noindex" },
		]);
		expect(options.head({}).meta).toEqual([
			{ title: "Accept invitation | KTB Health" },
			{ name: "robots", content: "noindex" },
		]);
	});

	it("shows a spinner while it looks up the link in the URL fragment", async () => {
		let resolvePreview: ((value: unknown) => void) | null = null;
		mocks.invitePreviewFn.mockImplementation(
			() =>
				new Promise((r) => {
					resolvePreview = r;
				}),
		);
		mocks.loaderData.current = "es";
		const { container } = render(createElement(options.component));
		expect(lookupSpinner(container)).not.toBeNull();
		expect(lookupSpinner(container)!.querySelector("svg")).not.toBeNull();
		expect(screen.queryByTestId("accept-invite")).toBeNull();
		expect(mocks.props.current).toBeUndefined();
		expect(mocks.invitePreviewFn.mock.calls).toEqual([[{ data: "tok-abc" }]]);

		await act(async () => {
			resolvePreview?.(invite);
		});
		expect(screen.getByTestId("accept-invite")).toBeTruthy();
		expect(lookupSpinner(container)).toBeNull();
		expect(pageProps().invite).toBe(invite);
		expect(pageProps().locale).toBe("es");
		// Looked up once, and nothing is accepted before the person submits.
		expect(mocks.invitePreviewFn).toHaveBeenCalledTimes(1);
		expect(mocks.acceptInviteFn).not.toHaveBeenCalled();
	});

	it("renders a link that opens nothing as a dead link", async () => {
		mocks.invitePreviewFn.mockResolvedValue(null);
		render(createElement(options.component));
		await screen.findByTestId("accept-invite");
		expect(pageProps()).toMatchObject({ invite: null, locale: "en" });
	});

	it("treats a failed lookup as a dead link", async () => {
		mocks.invitePreviewFn.mockRejectedValue(new Error("network down"));
		const { container } = render(createElement(options.component));
		expect(lookupSpinner(container)).not.toBeNull();
		await screen.findByTestId("accept-invite");
		expect(lookupSpinner(container)).toBeNull();
		expect(mocks.invitePreviewFn).toHaveBeenCalledWith({ data: "tok-abc" });
		expect(pageProps()).toMatchObject({ invite: null, locale: "en" });
	});

	it("binds accept to the fragment's token", async () => {
		window.location.hash = "#tok-9";
		mocks.invitePreviewFn.mockResolvedValue(invite);
		const result = { ok: true, email: "sec@ktb.test", kind: "secretary" };
		mocks.acceptInviteFn.mockResolvedValue(result);
		render(createElement(options.component));
		await screen.findByTestId("accept-invite");
		await expect(
			pageProps().api.accept({ name: "Maria Souza", password: "senha12345" }),
		).resolves.toBe(result);
		expect(mocks.acceptInviteFn.mock.calls).toEqual([
			[
				{
					data: { token: "tok-9", name: "Maria Souza", password: "senha12345" },
				},
			],
		]);
	});

	it("looks up an empty token when the URL has no fragment, ending in a dead link", async () => {
		window.location.hash = "";
		// What the server answers for a token that opens nothing.
		mocks.invitePreviewFn.mockResolvedValue(null);
		render(createElement(options.component));
		await waitFor(() => expect(screen.getByTestId("accept-invite")).toBeTruthy());
		expect(mocks.invitePreviewFn.mock.calls).toEqual([[{ data: "" }]]);
		expect(pageProps().invite).toBeNull();
	});
});
