// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const getSessionUserFn = vi.fn(
	async (): Promise<{ id: string; email: string; name: string } | null> => ({
		id: "u1",
		email: "doc@x.com",
		name: "Dra",
	}),
);
const pluginStatesFn = vi.fn(async () => ({ enabled: [] as string[] }));
const portalAudiencesFn = vi.fn(async () => [] as string[]);
const portalPageDataFn = vi.fn(
	async (_path: string): Promise<{ status: string; data?: unknown }> => ({
		status: "ok",
		data: null,
	}),
);
const signOut = vi.fn(async () => {});
const navigate = vi.fn();

vi.mock("@ktb/auth-better/client", () => ({ authClient: { signOut: () => signOut() } }));

vi.mock("#/lib/fns.ts", () => ({
	getSessionUserFn: () => getSessionUserFn(),
	pluginStatesFn: () => pluginStatesFn(),
	portalAudiencesFn: () => portalAudiencesFn(),
	portalPageDataFn: (arg: { data: string }) => portalPageDataFn(arg.data),
}));
// Theme resolution is a server fn — stub it so the loader stays pure.
vi.mock("@ktb/theme/fns", () => ({
	themeScopeFn: vi.fn(async () => null),
}));

vi.mock("#/lib/registry.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/registry.ts")>();
	return {
		...actual,
		collectChrome: (
			pluginList: Parameters<typeof actual.collectChrome>[0],
			region: string,
			path: string,
			portal?: string,
		) => [
			...actual.collectChrome(pluginList, region, path, portal),
			...chromeExtra.filter((entry) => entry.region === region),
		],
	};
});

let instance = "clinician";
let splat: string | undefined = "test";
let pathname = "/portal/clinician/test";
let loaderData: unknown = {
	path: "/portal/clinician/test",
	data: null,
	audiences: [],
	pluginStates: { enabled: [] },
};
let chromeExtra: { id: string; region: string; content: Record<string, unknown> }[] = [];

beforeAll(() => {
	window.matchMedia =
		window.matchMedia ??
		((query: string) =>
			({
				matches: false,
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			}) as MediaQueryList);
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		createFileRoute: () => (opts: Record<string, unknown>) => ({
			options: opts,
			useLoaderData: () => loaderData,
			useParams: () => ({ instance, _splat: splat }),
		}),
		useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) => {
			const loc = { pathname };
			return opts?.select ? opts.select(loc) : loc;
		},
		getRouteApi: () => ({
			useLoaderData: () => ({
				user: { id: "u1", email: "doc@x.com", name: "Dra" },
				pluginStates: { enabled: plugins.map((p) => p.id) },
			}),
		}),
		useNavigate: () => navigate,
		Link: (props: Record<string, unknown>) => {
			const { to, children, ...rest } = props;
			return createElement("a", { href: to as string, ...rest }, children as never);
		},
	};
});

import { Route as PortalInstanceRoute } from "./portal.$instance.$.tsx";
import { KTB_DEFAULT_THEME } from "@ktb/theme/default-theme";
import { portalPages } from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";
import type { PanelPage } from "@ktb/kernel";

const component = (route: unknown) =>
	(route as { options: { component: () => ReactElement } }).options.component;
const beforeLoad = (route: unknown) =>
	(
		route as {
			options: {
				beforeLoad?: (arg: { params: { instance: string; _splat?: string } }) => Promise<unknown>;
			};
		}
	).options.beforeLoad;
const loader = (route: unknown) =>
	(
		route as {
			options: {
				loader: (arg: { params: { instance: string; _splat?: string } }) => Promise<unknown>;
			};
		}
	).options.loader;
const head = (route: unknown) =>
	(
		route as {
			options: {
				head?: (ctx?: { loaderData?: { theme?: unknown } }) => {
					meta: Record<string, unknown>[];
					links: Record<string, unknown>[];
				};
			};
		}
	).options.head;

const TEST_PAGE: PanelPage = {
	id: "test.widget",
	path: "/portal/clinician/test",
	component: () => createElement("div", { "data-testid": "portal-page" }, "CLINICIAN PAGE"),
};

const registerPage = () => {
	const pages = portalPages as unknown as Map<string, { page: PanelPage; pluginId: string }>;
	pages.set(TEST_PAGE.path, { page: TEST_PAGE, pluginId: "clinician.pages" });
	return () => pages.delete(TEST_PAGE.path);
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	chromeExtra = [];
	signOut.mockClear();
	navigate.mockClear();
	instance = "clinician";
	splat = "test";
	pathname = "/portal/clinician/test";
	getSessionUserFn.mockReset().mockResolvedValue({ id: "u1", email: "doc@x.com", name: "Dra" });
	pluginStatesFn.mockReset().mockResolvedValue({ enabled: plugins.map((p) => p.id) });
	portalAudiencesFn.mockReset().mockResolvedValue([]);
	portalPageDataFn.mockReset().mockResolvedValue({ status: "ok", data: null });
	loaderData = {
		path: "/portal/clinician/test",
		data: null,
		audiences: [],
		pluginStates: { enabled: plugins.map((p) => p.id) },
	};
});

describe("/portal/$instance/$ beforeLoad", () => {
	it.each([
		["doctor", "/login/doctor"],
		["secretary", "/login/secretary"],
		["patient", "/login/patient"],
		["ghost", "/login"],
	] as const)("redirects anonymous /portal/%s visitors to %s", async (instance, login) => {
		getSessionUserFn.mockResolvedValue(null);
		const caught = await beforeLoad(PortalInstanceRoute)!({
			params: { instance, _splat: "x" },
		}).catch((e: unknown) => e);
		expect(caught).toMatchObject({ status: 307, options: { href: login } });
	});

	it("passes for signed-in users", async () => {
		await expect(
			beforeLoad(PortalInstanceRoute)!({ params: { instance: "clinician", _splat: "x" } }),
		).resolves.toBeUndefined();
	});
});

describe("/portal/$instance/$ loader", () => {
	it("404s unknown instance ids", async () => {
		await expect(
			loader(PortalInstanceRoute)!({ params: { instance: "ghost", _splat: "x" } }),
		).rejects.toMatchObject({ isNotFound: true });
	});

	it("404s paths no portal page owns", async () => {
		const unregister = registerPage();
		try {
			await expect(
				loader(PortalInstanceRoute)!({ params: { instance: "clinician", _splat: "nope" } }),
			).rejects.toMatchObject({ isNotFound: true });
			expect(portalPageDataFn).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});

	it("404s when the owning plugin or the instance plugin is disabled", async () => {
		const unregister = registerPage();
		try {
			pluginStatesFn.mockResolvedValue({
				enabled: plugins.filter((p) => p.id !== "clinician.pages").map((p) => p.id),
			});
			await expect(
				loader(PortalInstanceRoute)!({ params: { instance: "clinician", _splat: "test" } }),
			).rejects.toMatchObject({ isNotFound: true });
			pluginStatesFn.mockResolvedValue({
				enabled: plugins.filter((p) => p.id !== "clinician.portal").map((p) => p.id),
			});
			await expect(
				loader(PortalInstanceRoute)!({ params: { instance: "clinician", _splat: "test" } }),
			).rejects.toMatchObject({ isNotFound: true });
		} finally {
			unregister();
		}
	});

	it("404s when the data fn reports notfound", async () => {
		const unregister = registerPage();
		try {
			portalPageDataFn.mockResolvedValue({ status: "notfound" });
			await expect(
				loader(PortalInstanceRoute)!({ params: { instance: "clinician", _splat: "test" } }),
			).rejects.toMatchObject({ isNotFound: true });
		} finally {
			unregister();
		}
	});

	it("resolves the bare instance root and empty splat to the instance path", async () => {
		const unregister = registerPage();
		try {
			portalPageDataFn.mockResolvedValue({ status: "ok", data: { view: "home" } });
			// Bare root (no splat) and empty splat both resolve to the
			// instance path — the real clinician home page.
			const bare = (await loader(PortalInstanceRoute)!({
				params: { instance: "clinician" },
			})) as { path: string };
			expect(bare.path).toBe("/portal/clinician");
			// Empty splat resolves to /portal/clinician — the real home page.
			const res = (await loader(PortalInstanceRoute)!({
				params: { instance: "clinician", _splat: "" },
			})) as { path: string; data: unknown };
			expect(res.path).toBe("/portal/clinician");
			expect(portalPageDataFn).toHaveBeenCalledWith("/portal/clinician");
		} finally {
			unregister();
		}
	});

	it("returns path, data, audiences and plugin states on success", async () => {
		const unregister = registerPage();
		try {
			portalAudiencesFn.mockResolvedValue(["clinician"]);
			pluginStatesFn.mockResolvedValue({ enabled: ["clinician.portal", "clinician.pages"] });
			portalPageDataFn.mockResolvedValue({ status: "ok", data: { rows: [1] } });
			const res = (await loader(PortalInstanceRoute)!({
				params: { instance: "clinician", _splat: "test" },
			})) as Record<string, unknown>;
			expect(res).toEqual({
				path: "/portal/clinician/test",
				data: { rows: [1] },
				audiences: ["clinician"],
				pluginStates: { enabled: ["clinician.portal", "clinician.pages"] },
				theme: null,
			});
			expect(portalPageDataFn).toHaveBeenCalledWith("/portal/clinician/test");
		} finally {
			unregister();
		}
	});

	it("head emits no theme tags without a resolved theme", () => {
		const h = head(PortalInstanceRoute)!;
		expect(h({ loaderData: { theme: null } })).toEqual({});
		expect(h({ loaderData: {} })).toEqual({});
		expect(h({})).toEqual({});
	});

	it("head projects title and favicon links from the resolved theme", () => {
		const out = head(PortalInstanceRoute)!({ loaderData: { theme: KTB_DEFAULT_THEME } });
		expect(out.meta).toContainEqual({ title: "KTB Health" });
		expect(out.links).toContainEqual({ rel: "icon", href: "/brand/logo-mark.png" });
	});

	it("head omits the title tag when the theme names nothing", () => {
		const theme = { ...KTB_DEFAULT_THEME, brand: null, appName: null };
		expect(head(PortalInstanceRoute)!({ loaderData: { theme } })).toEqual({
			meta: [],
			links: [],
		});
	});
});

describe("/portal/$instance/$ component", () => {
	it("renders the contributed page inside PortalShell", () => {
		const unregister = registerPage();
		try {
			render(createElement(component(PortalInstanceRoute)));
			expect(screen.getByTestId("portal-page").textContent).toBe("CLINICIAN PAGE");
			expect(screen.getAllByText("Clinician").length).toBeGreaterThan(0);
		} finally {
			unregister();
		}
	});

	it("returns null when the instance or page is unknown", () => {
		instance = "ghost";
		const { container } = render(createElement(component(PortalInstanceRoute)));
		expect(container.innerHTML).toBe("");
	});

	it("renders injected sidebar and header chrome, skipping mismatched kinds", () => {
		const unregister = registerPage();
		chromeExtra = [
			{
				id: "t.sb",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: { to: "/portal/clinician/test", label: "Test Page", group: "Care" },
				},
			},
			{
				id: "t.hdr",
				region: "portal.header.actions",
				content: {
					kind: "headerAction",
					id: "t.hdr.c",
					component: () => createElement("div", null, "HDR-ACTION"),
				},
			},
			// Mismatched kinds are dropped by the flatMap filters.
			{
				id: "t.sb-link",
				region: "portal.sidebar",
				content: { kind: "link", to: "/x", label: "X" },
			},
			{
				id: "t.hdr-note",
				region: "portal.header.actions",
				content: { kind: "note", key: "k", fallback: "f" },
			},
		];
		try {
			render(createElement(component(PortalInstanceRoute)));
			expect(screen.getAllByText("Test Page").length).toBeGreaterThan(0);
			expect(screen.getAllByText("Care").length).toBeGreaterThan(0);
			expect(screen.getByText("HDR-ACTION")).toBeTruthy();
		} finally {
			unregister();
		}
	});

	it("shows the portal switcher when more than one instance admits the user", () => {
		const unregister = registerPage();
		loaderData = {
			path: "/portal/clinician/test",
			data: null,
			audiences: ["clinician", "platform-admin", "member"],
			pluginStates: { enabled: plugins.map((p) => p.id) },
		};
		try {
			render(createElement(component(PortalInstanceRoute)));
			expect(screen.getByLabelText("Switch portal")).toBeTruthy();
		} finally {
			unregister();
		}
	});

	it("omits header actions when the platform header plugin is absent", async () => {
		// headerEnabled is a module-level registry check — re-import the
		// route with the header plugin filtered out of #/plugins.ts.
		vi.resetModules();
		vi.doMock("#/plugins.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("#/plugins.ts")>();
			return {
				...actual,
				plugins: actual.plugins.filter((p) => p.id !== "platform.header"),
			};
		});
		try {
			const [{ Route: R }, { portalPages: freshPages }] = await Promise.all([
				import("./portal.$instance.$.tsx"),
				import("#/lib/registry.ts"),
			]);
			const pages = freshPages as unknown as Map<string, { page: PanelPage; pluginId: string }>;
			pages.set(TEST_PAGE.path, { page: TEST_PAGE, pluginId: "clinician.pages" });
			chromeExtra = [
				{
					id: "t.hdr",
					region: "portal.header.actions",
					content: {
						kind: "headerAction",
						id: "t.hdr.c",
						component: () => createElement("div", null, "HDR-ACTION"),
					},
				},
			];
			render(
				createElement(
					(R as unknown as { options: { component: () => ReactElement } }).options.component,
				),
			);
			expect(screen.getByTestId("portal-page")).toBeTruthy();
			expect(screen.queryByText("HDR-ACTION")).toBeNull();
			pages.delete(TEST_PAGE.path);
		} finally {
			vi.doUnmock("#/plugins.ts");
			vi.resetModules();
		}
	});

	it("signs out and returns to the app", async () => {
		const unregister = registerPage();
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		try {
			render(createElement(component(PortalInstanceRoute)));
			fireEvent.click(screen.getByTitle("Sign out"));
			await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
			expect(signOut).toHaveBeenCalledOnce();
		} finally {
			unregister();
		}
	});

	const themedLoaderData = (theme: unknown) => ({
		path: "/portal/clinician/test",
		data: null,
		audiences: [],
		pluginStates: { enabled: plugins.map((p) => p.id) },
		theme,
	});

	it("renders the theme brand mark, style block and preview banner", () => {
		const unregister = registerPage();
		loaderData = themedLoaderData({ ...KTB_DEFAULT_THEME, preview: true });
		try {
			const { container } = render(createElement(component(PortalInstanceRoute)));
			expect(screen.getByText("Theme preview active")).toBeTruthy();
			expect(container.querySelector("style")).not.toBeNull();
			expect(container.querySelector('img[src="/brand/logo-horizontal.svg"]')).not.toBeNull();
		} finally {
			unregister();
		}
	});

	it("falls back to the row appName for brand when brand json is empty", () => {
		const unregister = registerPage();
		loaderData = themedLoaderData({ ...KTB_DEFAULT_THEME, brand: null, appName: "Acme Health" });
		try {
			render(createElement(component(PortalInstanceRoute)));
			expect(screen.getByText("Acme Health")).toBeTruthy();
		} finally {
			unregister();
		}
	});

	it("renders no brand slot for a brand-less theme but still emits theme css", () => {
		const unregister = registerPage();
		loaderData = themedLoaderData({ ...KTB_DEFAULT_THEME, brand: null, appName: null });
		try {
			const { container } = render(createElement(component(PortalInstanceRoute)));
			expect(container.querySelector("style")).not.toBeNull();
			expect(container.querySelector('img[src^="/brand/"]')).toBeNull();
			expect(screen.queryByText("Theme preview active")).toBeNull();
		} finally {
			unregister();
		}
	});

	it("renders portal.brand chrome with host chrome props and wires sign-out", async () => {
		const unregister = registerPage();
		chromeExtra = [
			{
				id: "t.brand-btn",
				region: "portal.brand",
				content: {
					kind: "component",
					component: (props: { signOut?: () => Promise<void> }) =>
						createElement(
							"button",
							{
								"data-testid": "brand-signout",
								onClick: () => void props.signOut?.(),
							},
							"BRAND-SIGNOUT",
						),
				},
			},
			// Non-component kinds in the brand region are dropped.
			{
				id: "t.brand-note",
				region: "portal.brand",
				content: { kind: "note", key: "k", fallback: "f" },
			},
		];
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		try {
			render(createElement(component(PortalInstanceRoute)));
			fireEvent.click(screen.getByTestId("brand-signout"));
			await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
			expect(signOut).toHaveBeenCalledOnce();
		} finally {
			unregister();
		}
	});
});
