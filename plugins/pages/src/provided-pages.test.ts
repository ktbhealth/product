import { describe, expect, it } from "vitest";

import type { Page, PanelPage, Plugin } from "@ktb/kernel";

import { collectProvidedPages } from "./provided-pages.ts";

const Page_ = () => null;

const page = (id: string, path: string, context?: "app" | "portal"): Page => ({
	id,
	path,
	component: Page_,
	...(context === undefined ? {} : { context }),
});

const panelPage = (id: string, path: string): PanelPage => ({
	id,
	path,
	component: Page_,
});

const plugin = (
	id: string,
	pages?: readonly Page[],
	panelPages?: readonly PanelPage[],
	extra: Partial<Plugin> = {},
): Plugin =>
	({
		id,
		...(pages === undefined ? {} : { pages }),
		...(panelPages === undefined ? {} : { panel: { pages: panelPages } }),
		...extra,
	}) as Plugin;

describe("collectProvidedPages", () => {
	it("collects panel.pages as portal and pages with path-derived context", () => {
		const plugins = [
			plugin("a.panel", undefined, [panelPage("a.admin", "/platform/a")]),
			plugin("b.pages", [page("b.about", "/about"), page("b.portal", "/portal/clinician/x")]),
		];
		const result = collectProvidedPages(plugins);
		expect(result).toEqual([
			{ pageId: "b.about", path: "/about", pluginId: "b.pages", context: "app" },
			{ pageId: "a.admin", path: "/platform/a", pluginId: "a.panel", context: "portal" },
			// /portal/<id> is app-routed unless a portal instance claims the id.
			{ pageId: "b.portal", path: "/portal/clinician/x", pluginId: "b.pages", context: "app" },
		]);
	});

	it("routes /portal/<id> paths to portal context when the instance is contributed", () => {
		const plugins = [
			plugin("p.portals", undefined, undefined, {
				portals: [{ id: "clinician", basePath: "/portal/clinician", label: "Clinician" }],
			} as Partial<Plugin>),
			plugin("c.pages", [page("c.home", "/portal/clinician")]),
		];
		const result = collectProvidedPages(plugins);
		expect(result).toEqual([
			{ pageId: "c.home", path: "/portal/clinician", pluginId: "c.pages", context: "portal" },
		]);
	});

	it("dedupes by path — first contributor in topo order wins", () => {
		const plugins = [
			plugin("first", [page("first.x", "/dup")]),
			plugin("second", [page("second.x", "/dup")]),
		];
		expect(collectProvidedPages(plugins)).toEqual([
			{ pageId: "first.x", path: "/dup", pluginId: "first", context: "app" },
		]);
	});

	it("skips contract-violating context/path combinations like collectPages", () => {
		const plugins = [
			plugin("bad.app", [page("bad.app", "/platform/x", "app")]),
			plugin("bad.portal", [page("bad.portal", "/about", "portal")]),
			plugin("ok", [page("ok.x", "/fine")]),
		];
		expect(collectProvidedPages(plugins).map((r) => r.pageId)).toEqual(["ok.x"]);
	});

	it("dedupes before the enabled filter — a disabled claimant still shadows", () => {
		const plugins = [
			plugin("off.first", [page("off.first", "/dup")]),
			plugin("on.second", [page("on.second", "/dup")]),
		];
		// collectPages lets the disabled winner claim the path and the
		// dispatcher 404s — the enabled plugin's descriptor is shadowed,
		// so nothing is listed.
		expect(collectProvidedPages(plugins, new Set(["on.second"]))).toEqual([]);
	});

	it("filters disabled plugins when the enabled set is provided", () => {
		const plugins = [
			plugin("on.pages", [page("on.x", "/on")]),
			plugin("off.pages", [page("off.x", "/off")]),
		];
		const result = collectProvidedPages(plugins, new Set(["on.pages"]));
		expect(result.map((r) => r.path)).toEqual(["/on"]);
	});

	it("gates package-granular: any enabled member keeps the package live", () => {
		const plugins = [
			{ ...plugin("pkg.a", [page("pkg.a", "/pkg")]), pkg: "pkg" } as Plugin,
			{ ...plugin("pkg.b"), pkg: "pkg" } as Plugin,
		];
		// Only pkg.b enabled — the package is live, so pkg.a's page lists.
		expect(collectProvidedPages(plugins, new Set(["pkg.b"]))).toHaveLength(1);
		expect(collectProvidedPages(plugins, new Set([]))).toHaveLength(0);
	});
});
