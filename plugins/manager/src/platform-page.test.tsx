// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelPageContext } from "@ktb/kernel";
import type { PluginStateEntry } from "@ktb/platform/plugin-states";

// The view is covered by its own suite — here we only assert the props
// ManagerPage derives (states map, locale, cascadeConfirm).
const seen = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }));
vi.mock("./views/PluginsPage.tsx", () => ({
	PluginsPage: (props: Record<string, unknown>) => {
		seen.last = props;
		return null;
	},
}));
const routesSeen = vi.hoisted(() => ({
	last: undefined as { routes?: readonly unknown[] } | undefined,
}));
vi.mock("./views/RoutesPage.tsx", () => ({
	RoutesPage: (props: { routes: readonly unknown[] }) => {
		routesSeen.last = props;
		return null;
	},
}));
// No router in this suite — the real adapter needs TanStack Router
// context; passthrough keeps the test about prop derivation only.
vi.mock("nuqs/adapters/tanstack-router", () => ({
	NuqsAdapter: ({ children }: { children: React.ReactNode }) => children,
}));

import { ManagerPage, RoutesAdminPage } from "./platform-page.tsx";

const ctx: PanelPageContext = {
	plugins: [],
	locale: "pt-BR",
};

const entry = (pluginId: string, config: unknown): PluginStateEntry => ({
	pluginId,
	enabled: true,
	system: true,
	config,
});

const renderPage = (states: readonly PluginStateEntry[]) =>
	render(<ManagerPage data={{ states }} ctx={ctx} />);

afterEach(() => {
	cleanup();
	seen.last = undefined;
	routesSeen.last = undefined;
});

describe("ManagerPage", () => {
	it("maps loader entries into a states Map and passes ctx through", () => {
		renderPage([entry("manager.chrome", null), entry("manager.panel", { cascadeConfirm: true })]);
		expect(seen.last?.locale).toBe("pt-BR");
		expect(seen.last?.cascadeConfirm).toBe(true);
		const states = seen.last?.states as Map<string, PluginStateEntry>;
		expect(states.get("manager.chrome")?.enabled).toBe(true);
	});

	it("reads cascadeConfirm=false from the manager.panel stored config", () => {
		renderPage([entry("manager.panel", { cascadeConfirm: false })]);
		expect(seen.last?.cascadeConfirm).toBe(false);
	});

	it("defaults cascadeConfirm to true for missing or malformed configs", () => {
		for (const config of [undefined, null, "yes", [false], { cascadeConfirm: "no" }]) {
			renderPage(config === undefined ? [] : [entry("manager.panel", config)]);
			expect(seen.last?.cascadeConfirm).toBe(true);
			cleanup();
		}
	});
});

describe("RoutesAdminPage", () => {
	const row = { key: "patients.detail", path: "/patients/:id", pluginId: "patients.routes" };

	it("passes well-formed route rows through to the view", () => {
		render(<RoutesAdminPage data={[row]} ctx={ctx} />);
		expect(routesSeen.last?.routes).toEqual([row]);
	});

	it("drops malformed rows and non-array data", () => {
		for (const data of [
			undefined,
			{ routes: [row] },
			"nope",
			[null, 42, "x", {}, { key: "k" }, { path: "/p" }, { key: 1, path: "/p" }],
		]) {
			render(<RoutesAdminPage data={data} ctx={ctx} />);
			expect(routesSeen.last?.routes).toEqual([]);
			cleanup();
		}
	});

	it("keeps valid rows and drops invalid ones in a mixed list", () => {
		render(<RoutesAdminPage data={[row, { key: "bad" }, null]} ctx={ctx} />);
		expect(routesSeen.last?.routes).toEqual([row]);
	});
});
