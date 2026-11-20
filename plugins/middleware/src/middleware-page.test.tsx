// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { MiddlewareRouteInfo, PanelPageContext } from "@ktb/kernel";
import type { MiddlewareStageRow } from "@ktb/platform/middleware";

import { MiddlewarePage } from "./middleware-page.tsx";

const ctx = (locale = "en") =>
	({ plugins: [], locale, i18n: undefined }) as unknown as PanelPageContext;

const stage = (overrides: Partial<MiddlewareStageRow> = {}): MiddlewareStageRow => ({
	id: "ktb.principal.session",
	order: 10,
	pluginId: "app-host",
	origin: "builtin",
	enabled: true,
	...overrides,
});

const route = (overrides: Partial<MiddlewareRouteInfo> = {}): MiddlewareRouteInfo => ({
	path: "/platform/patients",
	context: "platform",
	routeKey: "/platform/patients",
	...overrides,
});

afterEach(cleanup);

describe("MiddlewarePage", () => {
	it("renders the unavailable state when the registry read failed", () => {
		render(<MiddlewarePage data={undefined} ctx={ctx()} />);
		expect(screen.getByText("Registry unavailable")).toBeTruthy();
		render(<MiddlewarePage data={{ stages: null, routes: null }} ctx={ctx("pt-BR")} />);
		expect(screen.getAllByText("Registro indisponível").length).toBeGreaterThan(0);
	});

	it("lists every stage with order, scope, origin and enablement", () => {
		render(
			<MiddlewarePage
				data={{
					stages: [
						stage(),
						stage({
							id: "plugin.audit",
							order: 100,
							pluginId: "audit.services",
							pkg: "audit",
							origin: "plugin",
							scope: { context: "portal", routeKey: "/portal/doctor/*", path: "/portal/*" },
							enabled: false,
						}),
						stage({
							id: "plugin.empty-scope",
							pluginId: "misc.plugin",
							origin: "plugin",
							scope: {},
							enabled: true,
						}),
						// No declared order → the "—" order cell.
						stage({
							id: "plugin.noorder",
							order: undefined,
							pluginId: "misc.plugin",
							origin: "plugin",
							scope: { path: "/nowhere/*" },
							enabled: true,
						}),
					],
					routes: [route()],
				}}
				ctx={ctx()}
			/>,
		);
		expect(screen.getByText("ktb.principal.session")).toBeTruthy();
		expect(screen.getByText("plugin.audit")).toBeTruthy();
		expect(screen.getByText("app-host")).toBeTruthy();
		expect(screen.getByText("audit.services")).toBeTruthy();
		expect(screen.getByText("builtin")).toBeTruthy();
		expect(screen.getAllByText("plugin")).toHaveLength(3);
		// Unscoped stage → "all requests"; scoped stage joins its fields;
		// an empty scope object also collapses to "all requests".
		expect(screen.getAllByText("all requests").length).toBe(2);
		expect(screen.getByText("context:portal route:/portal/doctor/* path:/portal/*")).toBeTruthy();
		expect(screen.getByText("Disabled")).toBeTruthy();
		// Stage count copy renders through the paramMessage plural; the
		// orderless stage renders the "—" order cell.
		expect(screen.getByText(/4 stages/)).toBeTruthy();
		expect(screen.getByText("plugin.noorder")).toBeTruthy();
	});

	it("resolves the effective per-route chain from enabled scoped stages", () => {
		render(
			<MiddlewarePage
				data={{
					stages: [
						stage({ id: "ktb.principal.session", order: 10 }),
						stage({
							id: "ktb.portal.audience",
							order: 30,
							scope: { context: "portal" },
						}),
						stage({
							id: "plugin.unrelated",
							order: 40,
							origin: "plugin",
							pluginId: "audit.services",
							scope: { path: "/audit/*" },
						}),
						stage({
							id: "plugin.disabled",
							order: 50,
							origin: "plugin",
							pluginId: "audit.services",
							enabled: false,
						}),
					],
					routes: [
						route({ path: "/portal/doctor/x", context: "portal", routeKey: "/portal/doctor/*" }),
						route({ path: "/platform/patients", context: "platform" }),
					],
				}}
				ctx={ctx()}
			/>,
		);
		// Portal route: principal (unscoped) + audience (context match);
		// the /audit/*-scoped and disabled stages stay out.
		expect(screen.getByText("ktb.principal.session → ktb.portal.audience")).toBeTruthy();
		// Platform route: only the unscoped principal stage — its chain
		// cell is a second exact "ktb.principal.session" text (the first
		// is the stages-table row).
		expect(screen.getAllByText("ktb.principal.session")).toHaveLength(2);
		// Route count copy.
		expect(screen.getByText(/2 routes/)).toBeTruthy();
	});

	it("renders an em dash for routes no enabled stage claims", () => {
		render(
			<MiddlewarePage
				data={{
					stages: [
						stage({
							id: "plugin.audit",
							origin: "plugin",
							pluginId: "audit.services",
							scope: { path: "/audit/*" },
						}),
					],
					routes: [route()],
				}}
				ctx={ctx("es")}
			/>,
		);
		expect(screen.getByText("—")).toBeTruthy();
	});
});
