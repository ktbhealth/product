// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as never),
	};
});

import type { Plugin } from "@ktb/kernel";

import { DashboardPage } from "./DashboardPage.tsx";

const plugin = (id: string, sidebar = 0): Plugin =>
	sidebar
		? {
				id,
				chrome: [
					{
						id: `${id}.sidebar`,
						region: "portal.sidebar",
						content: { kind: "sidebarItem", item: { to: "/x", label: id } },
					},
				],
			}
		: { id };

const Landing = () => null;

afterEach(cleanup);

describe("DashboardPage", () => {
	it("renders the shell: title, plugins stat and the registered-plugins card", () => {
		render(<DashboardPage plugins={[plugin("a.b")]} />);
		expect(screen.getByText("Dashboard")).toBeTruthy();
		expect(screen.getByText("Plugins")).toBeTruthy();
		expect(screen.getByText("Registered plugins")).toBeTruthy();
		expect(screen.getByText("a.b")).toBeTruthy();
	});

	it("lists landing and panel pages among a plugin's contributions", () => {
		const Page = () => null;
		render(
			<DashboardPage
				plugins={[
					{ id: "site.landing", landing: { page: Landing } },
					{
						id: "site.panel",
						panel: { pages: [{ id: "p", path: "/platform/x", component: Page }] },
					},
				]}
			/>,
		);
		expect(screen.getByText("landing")).toBeTruthy();
		expect(screen.getByText("panel")).toBeTruthy();
	});

	it("renders plugin-contributed dashboard slots and hides disabled plugins' entries", () => {
		const StatWidget = () => <div>custom stat</div>;
		const SectionWidget = () => <div>custom section</div>;
		const slotPlugin = (id: string): Plugin => ({
			id,
			chrome: [
				{
					id: `${id}.stat`,
					region: "portal.dashboard.stats",
					content: { kind: "component", component: StatWidget },
				},
				{
					id: `${id}.sec`,
					region: "portal.dashboard.sections",
					content: { kind: "component", component: SectionWidget },
				},
				// Non-component contents are ignored by the dashboard slots.
				{
					id: `${id}.lnk`,
					region: "portal.dashboard.stats",
					content: { kind: "link", to: "/x", label: "L" },
				},
			],
		});
		render(
			<DashboardPage
				plugins={[slotPlugin("w.one"), slotPlugin("w.two")]}
				pluginStates={[{ pluginId: "w.two", enabled: false, system: false, config: null }]}
			/>,
		);
		expect(screen.getAllByText("custom stat")).toHaveLength(1);
		expect(screen.getAllByText("custom section")).toHaveLength(1);
	});

	it("passes the page ctx (plugins, locale, user, i18n) to slot components", () => {
		let seen: Record<string, unknown> = {};
		const Probe = (props: Record<string, unknown>) => {
			seen = props;
			return null;
		};
		const user = { id: "u1", email: "a@x.com" };
		const i18n = { locale: "en", catalog: {} };
		const p: Plugin = {
			id: "probe.p",
			chrome: [
				{
					id: "probe.sec",
					region: "portal.dashboard.sections",
					content: { kind: "component", component: Probe as never },
				},
			],
		};
		render(<DashboardPage plugins={[p]} locale="pt-BR" user={user} i18n={i18n} />);
		expect(seen.plugins).toEqual([p]);
		expect(seen.locale).toBe("pt-BR");
		expect(seen.user).toEqual(user);
		expect(seen.i18n).toEqual(i18n);
	});

	it("renders breakdowns and plugin enable-state badges", () => {
		render(
			<DashboardPage
				plugins={[plugin("a.b"), plugin("c.d")]}
				pluginStates={[
					{ pluginId: "a.b", enabled: true, system: false, config: null },
					{ pluginId: "c.d", enabled: false, system: false, config: null },
				]}
			/>,
		);
		expect(screen.getByText("1/2")).toBeTruthy();
		expect(screen.getByText("Enabled")).toBeTruthy();
		expect(screen.getByText("Disabled")).toBeTruthy();
	});

	it("marks system plugins and defaults missing state entries to enabled", () => {
		render(
			<DashboardPage
				plugins={[plugin("sys.p"), plugin("plain.p")]}
				pluginStates={[{ pluginId: "sys.p", enabled: true, system: true, config: null }]}
			/>,
		);
		expect(screen.getByText("System")).toBeTruthy();
		expect(screen.getByText("Enabled")).toBeTruthy();
	});

	it("lists routes, chrome, tables and services among a plugin's contributions", () => {
		const everything = {
			id: "full.stack",
			routes: [{ path: "/x" }],
			chrome: [
				{
					id: "c",
					region: "app.header.nav",
					content: { kind: "link", to: "/a", label: "A" },
				},
			],
			tables: {},
			services: {},
		} as unknown as Plugin;
		render(<DashboardPage plugins={[everything]} />);
		expect(screen.getByText("routes, chrome, tables, services")).toBeTruthy();
	});
});
