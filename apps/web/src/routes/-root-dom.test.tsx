// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	pathname: "/",
	user: null as { name?: string; email?: string; patientOnly?: boolean } | null,
	pluginStates: null as { enabled: string[] } | null,
	enabledIds: [] as string[],
	chromeExtra: [] as {
		id: string;
		region: string;
		content: Record<string, unknown>;
	}[],
}));

const initClientTelemetry = vi.hoisted(() => vi.fn());
const instrumentRouter = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@ktb/observability/client", () => ({ initClientTelemetry, instrumentRouter }));
vi.mock("@ktb/auth-better/client", () => ({ authClient: { signOut: () => signOut() } }));
vi.mock("@tanstack/react-devtools", () => ({ TanStackDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtoolsPanel: () => null }));
vi.mock("../styles.css?url", () => ({ default: "/styles.css" }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	const React = await import("react");
	return {
		...actual,
		createRootRoute: (opts: Record<string, unknown>) => ({
			options: opts,
			useLoaderData: () => ({
				user: state.user,
				pluginStates: state.pluginStates ?? { enabled: state.enabledIds },
			}),
		}),
		useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) => {
			const loc = { pathname: state.pathname };
			return opts?.select ? opts.select(loc) : loc;
		},
		useRouter: () => ({ subscribe: vi.fn() }),
		HeadContent: () => null,
		Scripts: () => null,
		Link: (props: Record<string, unknown>) => {
			const { to, children, activeProps: _a, ...rest } = props;
			return React.createElement("a", { href: to as string, ...rest }, children as ReactNode);
		},
	};
});
vi.mock("#/lib/registry.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/registry.ts")>();
	return {
		...actual,
		collectChrome: (
			pluginList: Parameters<typeof actual.collectChrome>[0],
			region: string,
			pathname: string,
		) => [
			...actual.collectChrome(pluginList, region, pathname),
			...state.chromeExtra.filter((entry) => entry.region === region),
		],
	};
});
vi.mock("#/lib/fns.ts", () => ({
	sessionFn: vi.fn(async () => null),
	pluginStatesFn: vi.fn(async () => ({ enabled: [] })),
}));

import { plugins } from "#/plugins.ts";
import { Route } from "./__root.tsx";

state.enabledIds = plugins.map((p) => p.id);

type RootOpts = {
	shellComponent: (p: { children: ReactNode }) => ReactElement;
};
const shell = (Route as unknown as { options: RootOpts }).options.shellComponent;

const renderShell = () =>
	render(createElement(shell, { children: createElement("div", { id: "child" }, "page") }));

afterEach(() => {
	cleanup();
	state.pathname = "/";
	state.user = null;
	state.pluginStates = null;
	state.chromeExtra = [];
	signOut.mockClear();
	initClientTelemetry.mockClear();
	instrumentRouter.mockClear();
});

describe("root document (dom)", () => {
	it("boots client telemetry and instruments the router once", () => {
		renderShell();
		expect(initClientTelemetry).toHaveBeenCalledWith({ endpoint: "/api/telemetry" });
		expect(instrumentRouter).toHaveBeenCalledOnce();
	});

	it("signs out through the chrome-injected action and returns home", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		state.chromeExtra = [
			{
				id: "t.signout",
				region: "app.header.actions",
				content: {
					kind: "component",
					component: (props: { signOut?: () => Promise<void> }) =>
						createElement("button", { onClick: () => void props.signOut?.() }, "do-sign-out"),
				},
			},
		];
		renderShell();
		fireEvent.click(screen.getByText("do-sign-out"));
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
		expect(signOut).toHaveBeenCalledOnce();
	});
});
