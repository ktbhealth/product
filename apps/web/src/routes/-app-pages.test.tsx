// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	appPageDataFn: vi.fn(),
	pluginStatesFn: vi.fn(),
	pages: new Map<
		string,
		{
			page: { component: (p: { data: unknown; ctx: unknown }) => unknown };
			pluginId: string;
			context?: string;
		}
	>(),
	loaderData: { current: undefined as unknown },
	params: { current: {} as { _splat?: string } },
	rootData: { current: { user: null as unknown, pluginStates: { enabled: [] as string[] } } },
}));

vi.mock("#/lib/fns.ts", () => ({
	appPageDataFn: mocks.appPageDataFn,
	pluginStatesFn: mocks.pluginStatesFn,
	i18nRouteFn: vi.fn(async () => undefined),
}));
vi.mock("@ktb/app-host/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/app-host/client")>();
	return { ...actual, appPages: mocks.pages };
});
vi.mock("#/plugins.ts", () => ({ plugins: [{ id: "plugin-a" }] }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		createFileRoute: () => (opts: Record<string, unknown>) => ({
			options: opts,
			useLoaderData: () => mocks.loaderData.current,
			useParams: () => mocks.params.current,
		}),
		getRouteApi: () => ({ useLoaderData: () => mocks.rootData.current }),
		redirect: (o: unknown) => ({ __redirect: o }),
	};
});

import { Route } from "./$.tsx";

type Opts = {
	loaderDeps: (a: { search: Record<string, unknown> }) => {
		search: Record<string, unknown>;
	};
	beforeLoad?: (a: {
		params: { _splat?: string };
		search: Record<string, unknown>;
		location: { pathname: string; searchStr: string; href: string };
		context: unknown;
	}) => Promise<unknown>;
	head?: (a: unknown) => unknown;
	loader: (a?: {
		params: { _splat?: string };
		deps?: { search?: Record<string, unknown> };
	}) => Promise<unknown>;
	component: () => ReactElement | null;
};
const opts = (r: unknown) => (r as { options: Opts }).options;

const Page = ({ data, ctx }: { data: unknown; ctx: unknown }) =>
	createElement("p", { "data-testid": "page" }, `${JSON.stringify(data)}|${JSON.stringify(ctx)}`);

const entry = (path: string, pluginId = "plugin-a", page: Record<string, unknown> = {}) => {
	mocks.pages.set(path, {
		page: { component: Page, ...page },
		pluginId,
		context: "app",
	});
	mocks.pluginStatesFn.mockResolvedValue({ enabled: [pluginId] });
};

const hookArgs = {
	params: { _splat: "about" },
	search: { q: "1" },
	location: { pathname: "/about", searchStr: "?q=1", href: "/about?q=1" },
	context: { user: null },
};

afterEach(() => {
	cleanup();
	mocks.pages.clear();
	mocks.params.current = {};
	mocks.rootData.current = { user: null, pluginStates: { enabled: [] } };
	vi.clearAllMocks();
});

describe("/$ app page dispatcher (P-059)", () => {
	it("passes the parsed search through loaderDeps", () => {
		expect(opts(Route).loaderDeps({ search: { page: "2" } })).toEqual({ search: { page: "2" } });
	});

	it("throws notFound when no plugin owns the path", async () => {
		await expect(
			opts(Route).loader({ params: { _splat: "nope" }, deps: {} }),
		).rejects.toMatchObject({
			isNotFound: true,
		});
		expect(mocks.appPageDataFn).not.toHaveBeenCalled();
	});

	it("throws notFound when the owning plugin is disabled (P-058)", async () => {
		entry("/about");
		mocks.pluginStatesFn.mockResolvedValue({ enabled: [] });
		await expect(
			opts(Route).loader({ params: { _splat: "about" }, deps: {} }),
		).rejects.toMatchObject({
			isNotFound: true,
		});
		expect(mocks.appPageDataFn).not.toHaveBeenCalled();
	});

	it("throws notFound when the page's guard denies", async () => {
		entry("/about");
		mocks.appPageDataFn.mockResolvedValue({ status: "notfound" });
		await expect(
			opts(Route).loader({ params: { _splat: "about" }, deps: {} }),
		).rejects.toMatchObject({
			isNotFound: true,
		});
		expect(mocks.appPageDataFn).toHaveBeenCalledWith({
			data: { path: "/about", search: undefined },
		});
	});

	it("returns the loader Effect's data", async () => {
		entry("/about");
		mocks.appPageDataFn.mockResolvedValue({ status: "ok", data: { rows: 2 } });
		await expect(opts(Route).loader({ params: { _splat: "about" }, deps: {} })).resolves.toEqual({
			data: { rows: 2 },
			pluginStates: { enabled: ["plugin-a"] },
		});
	});

	it("resolves nested splat paths against the registry", async () => {
		entry("/docs/guide");
		mocks.appPageDataFn.mockResolvedValue({ status: "ok", data: null });
		await opts(Route).loader({ params: { _splat: "docs/guide" }, deps: {} });
		expect(mocks.appPageDataFn).toHaveBeenCalledWith({
			data: { path: "/docs/guide", search: undefined },
		});
	});

	it("forwards the parsed search to the page data fn", async () => {
		entry("/search-page");
		mocks.appPageDataFn.mockResolvedValue({ status: "ok", data: null });
		await opts(Route).loader({
			params: { _splat: "search-page" },
			deps: { search: { q: "x", page: "2" } },
		});
		expect(mocks.appPageDataFn).toHaveBeenCalledWith({
			data: { path: "/search-page", search: { q: "x", page: "2" } },
		});
	});

	it("404s an empty splat (the index route owns /)", async () => {
		await expect(opts(Route).loader({ params: {}, deps: {} })).rejects.toMatchObject({
			isNotFound: true,
		});
	});

	it("renders nothing when the path resolves no page", () => {
		mocks.params.current = {};
		mocks.loaderData.current = { data: null, pluginStates: { enabled: [] } };
		const { container } = render(createElement(opts(Route).component));
		expect(container.innerHTML).toBe("");
	});

	it("renders the contributed component with data, enabled plugins, locale and user", () => {
		entry("/about");
		mocks.params.current = { _splat: "about" };
		mocks.loaderData.current = {
			data: { rows: 2 },
			pluginStates: { enabled: ["plugin-a"] },
		};
		mocks.rootData.current = {
			user: { id: "u1", email: "a@x.com", name: "A" },
			pluginStates: { enabled: ["plugin-a"] },
		};
		render(createElement(opts(Route).component));
		expect(screen.getByTestId("page").textContent).toBe(
			'{"rows":2}|{"plugins":[{"id":"plugin-a"}],"locale":"en","user":{"id":"u1","email":"a@x.com","name":"A"},"pluginStates":{"enabled":["plugin-a"]}}',
		);
	});

	it("runs the page beforeLoad hook with route facts", async () => {
		const beforeLoad = vi.fn(async () => ({ theme: "x" }));
		entry("/about", "plugin-a", { beforeLoad });
		await expect(opts(Route).beforeLoad?.(hookArgs)).resolves.toEqual({ theme: "x" });
		expect(beforeLoad).toHaveBeenCalledWith({
			path: "/about",
			params: { _splat: "about" },
			search: { q: "1" },
			location: { pathname: "/about", searchStr: "?q=1", href: "/about?q=1" },
			context: { user: null },
		});
	});

	it("no-ops beforeLoad when the page declares no hook", async () => {
		entry("/about");
		await expect(opts(Route).beforeLoad?.(hookArgs)).resolves.toBeUndefined();
	});

	it("ignores non-object beforeLoad results", async () => {
		entry("/about", "plugin-a", { beforeLoad: async () => "nope" });
		await expect(opts(Route).beforeLoad?.(hookArgs)).resolves.toBeUndefined();
	});

	it("translates a beforeLoad redirect into a router redirect", async () => {
		entry("/about", "plugin-a", {
			beforeLoad: async () => ({ redirectTo: "/login", replace: true }),
		});
		await expect(opts(Route).beforeLoad?.(hookArgs)).rejects.toEqual({
			__redirect: { href: "/login", replace: true },
		});
	});

	it("translates a beforeLoad notFound into router notFound", async () => {
		entry("/about", "plugin-a", { beforeLoad: async () => ({ notFound: true }) });
		await expect(opts(Route).beforeLoad?.(hookArgs)).rejects.toMatchObject({
			isNotFound: true,
		});
	});

	it("runs the page head hook with route facts and drops undefined search values", () => {
		const head = vi.fn(() => ({ meta: [] }));
		entry("/about", "plugin-a", { head });
		opts(Route).head?.({
			params: { _splat: "about" },
			match: { search: { a: undefined, b: "2" }, pathname: "/about" },
			loaderData: undefined,
			matches: [],
		});
		expect(head).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/about",
				params: { _splat: "about" },
				search: { a: undefined, b: "2" },
				location: { pathname: "/about", searchStr: "?b=2", href: "/about?b=2" },
			}),
		);
	});

	it("falls back to the concrete path when head has no match", () => {
		const head = vi.fn(() => ({ meta: [] }));
		entry("/about", "plugin-a", { head });
		opts(Route).head?.({ params: { _splat: "about" } });
		expect(head).toHaveBeenCalledWith(
			expect.objectContaining({
				location: { pathname: "/about", searchStr: "", href: "/about" },
			}),
		);
	});

	it("returns an empty head when the page declares no hook", () => {
		entry("/about");
		expect(
			opts(Route).head?.({
				params: { _splat: "about" },
				match: { search: {}, pathname: "/about" },
				loaderData: undefined,
				matches: [],
			}),
		).toEqual({});
	});

	it("returns an empty head when the hook returns undefined", () => {
		entry("/about", "plugin-a", { head: () => undefined });
		expect(
			opts(Route).head?.({
				params: { _splat: "about" },
				match: { search: {}, pathname: "/about" },
				loaderData: undefined,
				matches: [],
			}),
		).toEqual({});
	});

	it("coerces non-object search deps to an empty record", async () => {
		for (const search of [null, [], "x"]) {
			entry("/about");
			mocks.appPageDataFn.mockResolvedValue({ status: "ok", data: null });
			await opts(Route).loader({
				params: { _splat: "about" },
				deps: { search: search as unknown as Record<string, unknown> },
			});
			expect(mocks.appPageDataFn).toHaveBeenCalledWith({
				data: { path: "/about", search: {} },
			});
			mocks.pages.clear();
			vi.clearAllMocks();
		}
	});

	it("lets validateSearch transform the parsed search", async () => {
		entry("/about", "plugin-a", {
			validateSearch: ({ search }: { search: Record<string, unknown> }) => ({
				...search,
				extra: "1",
			}),
		});
		mocks.appPageDataFn.mockResolvedValue({ status: "ok", data: null });
		await opts(Route).loader({
			params: { _splat: "about" },
			deps: { search: { q: "x" } },
		});
		expect(mocks.appPageDataFn).toHaveBeenCalledWith({
			data: { path: "/about", search: { q: "x", extra: "1" } },
		});
	});

	it("keeps the parsed search when validateSearch returns undefined", async () => {
		entry("/about", "plugin-a", { validateSearch: () => undefined });
		mocks.appPageDataFn.mockResolvedValue({ status: "ok", data: null });
		await opts(Route).loader({
			params: { _splat: "about" },
			deps: { search: { q: "x" } },
		});
		expect(mocks.appPageDataFn).toHaveBeenCalledWith({
			data: { path: "/about", search: { q: "x" } },
		});
	});
});
