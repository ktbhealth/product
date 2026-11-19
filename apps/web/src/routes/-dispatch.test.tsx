// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KTB_DEFAULT_THEME } from "@ktb/theme/default-theme";

const mocks = vi.hoisted(() => ({
	target: { current: { kind: "landing", path: "/" } as Record<string, unknown> },
	platformBeforeLoad: vi.fn(async () => undefined),
	platformLoader: vi.fn(async () => ({ path: "/platform" })),
	portalBeforeLoad: vi.fn(async () => undefined),
	portalLoader: vi.fn(async () => ({ path: "/portal/doctor" })),
	appBeforeLoad: vi.fn(async () => undefined),
	appLoader: vi.fn(async () => ({ data: null })),
	appHead: vi.fn(() => ({ meta: [{ name: "app" }] })),
	loaderData: { current: undefined as unknown },
	params: { current: {} as { _splat?: string } },
}));

vi.mock("#/lib/dispatch-target.ts", () => ({
	dispatchTarget: () => mocks.target.current,
}));
vi.mock("#/lib/platform-dispatch.tsx", async () => {
	const { createElement } = await import("react");
	return {
		platformBeforeLoad: mocks.platformBeforeLoad,
		platformLoader: mocks.platformLoader,
		PlatformShell: ({ loaderData }: { loaderData: { kind?: string } }) =>
			createElement("div", { "data-testid": "platform-shell" }, loaderData.kind),
	};
});
vi.mock("#/lib/portal-dispatch.tsx", async () => {
	const { createElement } = await import("react");
	return {
		portalBeforeLoad: mocks.portalBeforeLoad,
		portalLoader: mocks.portalLoader,
		PortalInstanceShell: ({ loaderData }: { loaderData: { kind?: string } }) =>
			createElement("div", { "data-testid": "portal-shell" }, loaderData.kind),
	};
});
vi.mock("#/lib/app-dispatch.tsx", async () => {
	const { createElement } = await import("react");
	return {
		appBeforeLoad: mocks.appBeforeLoad,
		appLoader: mocks.appLoader,
		appHead: mocks.appHead,
		AppPage: ({ path, loaderData }: { path: string; loaderData: { kind?: string } }) =>
			createElement("div", { "data-testid": "app-page" }, `${path}|${loaderData.kind}`),
	};
});
vi.mock("#/lib/landing.tsx", async () => {
	const { createElement } = await import("react");
	return {
		Landing: () => createElement("div", { "data-testid": "landing" }),
	};
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		createFileRoute: () => (opts: Record<string, unknown>) => ({
			options: opts,
			useLoaderData: () => mocks.loaderData.current,
			useParams: () => mocks.params.current,
		}),
	};
});

import { Route } from "./$.tsx";

type Opts = {
	loaderDeps: (a: { search: Record<string, unknown> }) => { search: unknown };
	beforeLoad?: (a: Record<string, unknown>) => Promise<unknown>;
	loader: (a?: { params: { _splat?: string }; deps?: { search?: unknown } }) => Promise<unknown>;
	head?: (ctx?: Record<string, unknown>) => unknown;
	component: () => ReactElement | null;
};
const opts = () => (Route as unknown as { options: Opts }).options;

const beforeLoadArgs = {
	params: { _splat: "about" },
	search: { q: "1" },
	location: { pathname: "/about", searchStr: "?q=1", href: "/about?q=1" },
	context: { user: null },
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.target.current = { kind: "landing", path: "/" };
	mocks.loaderData.current = undefined;
	mocks.params.current = {};
});

describe("/$ dispatcher beforeLoad", () => {
	it("passes app paths to the app-shell beforeLoad", async () => {
		mocks.target.current = { kind: "app", path: "/about" };
		await expect(opts().beforeLoad?.(beforeLoadArgs)).resolves.toBeUndefined();
		expect(mocks.appBeforeLoad).toHaveBeenCalledWith(beforeLoadArgs);
	});

	it("delegates platform paths to the console gate", async () => {
		mocks.target.current = { kind: "platform", path: "/platform", instanceId: "platform" };
		await opts().beforeLoad?.({ params: { _splat: "platform" } });
		expect(mocks.platformBeforeLoad).toHaveBeenCalledOnce();
		expect(mocks.appBeforeLoad).not.toHaveBeenCalled();
	});

	it("delegates portal paths with the resolved instance id", async () => {
		mocks.target.current = { kind: "portal", path: "/portal/doctor", instanceId: "doctor" };
		await opts().beforeLoad?.({ params: { _splat: "portal/doctor" } });
		expect(mocks.portalBeforeLoad).toHaveBeenCalledWith("doctor");
	});

	it("falls back to an empty instance id for portal targets without one", async () => {
		mocks.target.current = { kind: "portal", path: "/portal/x" };
		await opts().beforeLoad?.({ params: { _splat: "portal/x" } });
		expect(mocks.portalBeforeLoad).toHaveBeenCalledWith("");
	});

	it("lets landing paths through untouched", async () => {
		mocks.target.current = { kind: "landing", path: "/" };
		await expect(opts().beforeLoad?.({ params: {} })).resolves.toBeUndefined();
		expect(mocks.platformBeforeLoad).not.toHaveBeenCalled();
		expect(mocks.portalBeforeLoad).not.toHaveBeenCalled();
		expect(mocks.appBeforeLoad).not.toHaveBeenCalled();
	});
});

describe("/$ dispatcher loader", () => {
	it("passes parsed search through loaderDeps", () => {
		expect(opts().loaderDeps({ search: { page: "2" } })).toEqual({ search: { page: "2" } });
	});

	it("loads platform pages through the console loader", async () => {
		mocks.target.current = { kind: "platform", path: "/platform", instanceId: "platform" };
		const params = { _splat: "platform" };
		await expect(opts().loader({ params, deps: { search: {} } })).resolves.toEqual({
			kind: "platform",
			path: "/platform",
		});
		expect(mocks.platformLoader).toHaveBeenCalledWith({ params });
	});

	it("loads portal pages through the instance loader", async () => {
		mocks.target.current = { kind: "portal", path: "/portal/doctor", instanceId: "doctor" };
		const params = { _splat: "portal/doctor" };
		await opts().loader({ params, deps: {} });
		expect(mocks.portalLoader).toHaveBeenCalledWith({ params, instanceId: "doctor" });
	});

	it("falls back to an empty instance id in the portal loader", async () => {
		mocks.target.current = { kind: "portal", path: "/portal/x" };
		await opts().loader({ params: { _splat: "portal/x" }, deps: {} });
		expect(mocks.portalLoader).toHaveBeenCalledWith({
			params: { _splat: "portal/x" },
			instanceId: "",
		});
	});

	it("loads app pages through the app loader", async () => {
		mocks.target.current = { kind: "app", path: "/about" };
		const params = { _splat: "about" };
		const deps = { search: { q: "x" } };
		await expect(opts().loader({ params, deps })).resolves.toEqual({
			kind: "app",
			data: null,
		});
		expect(mocks.appLoader).toHaveBeenCalledWith({ params, deps });
	});

	it("resolves landing with no inner loader data", async () => {
		mocks.target.current = { kind: "landing", path: "/" };
		await expect(opts().loader({ params: {}, deps: {} })).resolves.toEqual({ kind: "landing" });
	});
});

describe("/$ dispatcher head", () => {
	const headCtx = { params: { _splat: "platform" }, loaderData: { theme: null } };

	it("delegates app paths to the page head hook", () => {
		mocks.target.current = { kind: "app", path: "/about" };
		expect(opts().head?.(headCtx)).toEqual({ meta: [{ name: "app" }] });
		expect(mocks.appHead).toHaveBeenCalledWith(headCtx);
	});

	it("projects the theme head for platform and portal contexts", () => {
		for (const kind of ["platform", "portal"] as const) {
			mocks.target.current = { kind, path: "/x", instanceId: "doctor" };
			const out = opts().head?.({
				params: { _splat: "x" },
				loaderData: { theme: KTB_DEFAULT_THEME },
			}) as { meta: unknown[] };
			expect(out.meta).toContainEqual({ title: "KTB Health" });
		}
	});

	it("emits no head tags without a resolved theme", () => {
		for (const kind of ["platform", "portal", "landing"] as const) {
			mocks.target.current = { kind, path: "/x", instanceId: "doctor" };
			expect(opts().head?.({ params: { _splat: "x" }, loaderData: {} })).toEqual({});
			expect(opts().head?.({ params: { _splat: "x" } })).toEqual({});
		}
	});
});

describe("/$ dispatcher component", () => {
	it("renders the platform shell for platform loader data", () => {
		mocks.target.current = { kind: "platform", path: "/platform" };
		mocks.loaderData.current = { kind: "platform", path: "/platform" };
		render(createElement(opts().component));
		expect(screen.getByTestId("platform-shell").textContent).toBe("platform");
	});

	it("renders the portal shell for portal loader data", () => {
		mocks.target.current = { kind: "portal", path: "/portal/doctor" };
		mocks.loaderData.current = { kind: "portal", path: "/portal/doctor" };
		render(createElement(opts().component));
		expect(screen.getByTestId("portal-shell").textContent).toBe("portal");
	});

	it("renders the app page with the splat path", () => {
		mocks.target.current = { kind: "app", path: "/about" };
		mocks.params.current = { _splat: "about" };
		mocks.loaderData.current = { kind: "app", data: { rows: 1 } };
		render(createElement(opts().component));
		expect(screen.getByTestId("app-page").textContent).toBe("/about|app");
	});

	it("renders the landing picker for landing loader data", () => {
		mocks.target.current = { kind: "landing", path: "/" };
		mocks.loaderData.current = { kind: "landing" };
		render(createElement(opts().component));
		expect(screen.getByTestId("landing")).toBeTruthy();
	});
});
