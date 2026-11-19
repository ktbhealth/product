import { describe, expect, it, vi } from "vitest";
import type { Page, Plugin } from "@ktb/kernel";

import {
	collectPages,
	collectPortals,
	defaultPageContext,
	findPage,
	findPortalInstance,
	isPortalPath,
	portalInstanceIdForPath,
} from "./pages.ts";

const Page = () => null;

const pagePlugin = (id: string, pages: Page[]): Plugin => ({ id, pages });
const panelPlugin = (id: string, path: string): Plugin => ({
	id,
	panel: { pages: [{ id: `${id}.page`, path, component: Page }] },
});

describe("isPortalPath / portalInstanceIdForPath / defaultPageContext", () => {
	it("treats /platform and its descendants as portal", () => {
		expect(isPortalPath("/platform")).toBe(true);
		expect(isPortalPath("/platform/patients")).toBe(true);
		expect(isPortalPath("/platformx")).toBe(false);
		expect(isPortalPath("/about")).toBe(false);
		expect(defaultPageContext("/platform/x")).toBe("portal");
		expect(defaultPageContext("/about")).toBe("app");
	});

	it("treats /portal/<instance>/… as portal but leaves bare /portal to the app", () => {
		expect(isPortalPath("/portal/doctor")).toBe(true);
		expect(isPortalPath("/portal/doctor/patients")).toBe(true);
		expect(isPortalPath("/portal")).toBe(false);
		expect(isPortalPath("/portal/")).toBe(false);
		expect(isPortalPath("/portalx/doctor")).toBe(false);
		expect(defaultPageContext("/portal/doctor/x")).toBe("portal");
	});

	it("derives the instance id from the path", () => {
		expect(portalInstanceIdForPath("/platform")).toBe("platform");
		expect(portalInstanceIdForPath("/platform/patients")).toBe("platform");
		expect(portalInstanceIdForPath("/portal/doctor")).toBe("doctor");
		expect(portalInstanceIdForPath("/portal/doctor/patients")).toBe("doctor");
		expect(portalInstanceIdForPath("/portal")).toBeUndefined();
		expect(portalInstanceIdForPath("/portal/")).toBeUndefined();
		expect(portalInstanceIdForPath("/about")).toBeUndefined();
	});
});

describe("collectPages", () => {
	it("merges panel.pages (console) and pages contributions into one registry", () => {
		const reg = collectPages([
			panelPlugin("a.panel", "/platform"),
			pagePlugin("b.pages", [
				{ id: "b.about", path: "/about", component: Page },
				{ id: "b.console", path: "/platform/custom", component: Page, context: "portal" },
			]),
		]);
		expect(reg.pages.size).toBe(3);
		expect(reg.portalPages.get("/platform")?.pluginId).toBe("a.panel");
		expect(reg.portalPages.get("/platform/custom")?.context).toBe("portal");
		expect(reg.appPages.get("/about")?.pluginId).toBe("b.pages");
		expect(reg.appPages.has("/platform/custom")).toBe(false);
		expect(reg.portalPages.has("/about")).toBe(false);
	});

	it("propagates the plugin's pkg stamp onto page and portal entries", () => {
		const reg = collectPages([
			{
				id: "patients.panel",
				pkg: "patients",
				panel: { pages: [{ id: "p", path: "/platform/x", component: Page }] },
			},
			pagePlugin("b.pages", [{ id: "b.about", path: "/about", component: Page }]),
		]);
		expect(reg.portalPages.get("/platform/x")?.pkg).toBe("patients");
		// No stamp on the plugin → no pkg on the entry (per-id gate).
		expect(reg.appPages.get("/about")?.pkg).toBeUndefined();
	});

	it("derives context from the path when undeclared", () => {
		const reg = collectPages([
			pagePlugin("x", [
				{ id: "x.a", path: "/platform/deep", component: Page },
				{ id: "x.b", path: "/status", component: Page },
			]),
		]);
		expect(reg.portalPages.has("/platform/deep")).toBe(true);
		expect(reg.appPages.has("/status")).toBe(true);
	});

	it("first contributor in topo order wins path conflicts and warns", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reg = collectPages([
				pagePlugin("first", [{ id: "f", path: "/about", component: Page }]),
				pagePlugin("second", [{ id: "s", path: "/about", component: Page }]),
				panelPlugin("third.panel", "/about"),
			]);
			expect(reg.pages.size).toBe(1);
			expect(reg.pages.get("/about")?.pluginId).toBe("first");
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("ignores app-context pages claiming /platform paths", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reg = collectPages([
				pagePlugin("bad", [
					{ id: "bad", path: "/platform/secret", component: Page, context: "app" },
				]),
			]);
			expect(reg.pages.size).toBe(0);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it("stays silent outside dev", () => {
		vi.stubEnv("DEV", false);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reg = collectPages([
				pagePlugin("first", [{ id: "f", path: "/about", component: Page }]),
				pagePlugin("second", [{ id: "s", path: "/about", component: Page }]),
			]);
			// First-wins still applies — only the warning is dev-gated.
			expect(reg.pages.get("/about")?.pluginId).toBe("first");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			vi.unstubAllEnvs();
		}
	});

	it("routes /portal/<id> pages by contributed instance, not path shape", () => {
		const reg = collectPages([
			{
				id: "clinician.portal",
				portals: [{ id: "clinician", basePath: "/portal/clinician", label: "C" }],
			},
			pagePlugin("sign-in.pages", [
				// Unknown instance id → falls through to the app shell
				// (legacy redirect descriptors live here).
				{ id: "legacy", path: "/portal/login", component: Page, context: "app" },
				{ id: "c.page", path: "/portal/clinician/home", component: Page },
			]),
		]);
		expect(reg.appPages.get("/portal/login")?.pluginId).toBe("sign-in.pages");
		expect(reg.portalPages.get("/portal/clinician/home")?.pluginId).toBe("sign-in.pages");
		expect(reg.appPages.has("/portal/clinician/home")).toBe(false);
	});

	it("ignores app-context pages claiming a known portal instance path", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reg = collectPages([
				{
					id: "clinician.portal",
					portals: [{ id: "clinician", basePath: "/portal/clinician", label: "C" }],
				},
				pagePlugin("bad", [
					{
						id: "bad",
						path: "/portal/clinician/secret",
						component: Page,
						context: "app",
					},
				]),
			]);
			expect(reg.pages.size).toBe(0);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it("ignores portal-context pages under unknown /portal instance ids", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reg = collectPages([
				pagePlugin("odd", [
					{ id: "odd", path: "/portal/ghost/home", component: Page, context: "portal" },
				]),
			]);
			expect(reg.pages.size).toBe(0);
			expect(reg.portalPages.has("/portal/ghost/home")).toBe(false);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it("ignores console-context pages outside /platform (unreachable)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reg = collectPages([
				pagePlugin("odd", [{ id: "odd", path: "/nowhere", component: Page, context: "portal" }]),
			]);
			expect(reg.pages.size).toBe(0);
			expect(reg.portalPages.has("/nowhere")).toBe(false);
			expect(reg.appPages.has("/nowhere")).toBe(false);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("findPage", () => {
	const map = new Map<string, string>([
		["/exact", "exact-entry"],
		["/docs/*", "docs-wildcard"],
		["/*", "catch-all"],
	]);

	it("returns exact-path entries before any wildcard", () => {
		expect(findPage(map, "/exact")).toBe("exact-entry");
		// An exact entry beats a wildcard that would also match.
		expect(findPage(map, "/docs")).toBe("docs-wildcard");
	});

	it("resolves wildcard entries by longest matching base", () => {
		expect(findPage(map, "/docs/guide")).toBe("docs-wildcard");
		expect(findPage(map, "/docs")).toBe("docs-wildcard");
		expect(findPage(map, "/anything/else")).toBe("catch-all");
		expect(findPage(map, "/")).toBe("catch-all");
	});

	it("does not match wildcard bases partially", () => {
		// "/docs/*" must not claim "/docsify" or "/doc".
		expect(findPage(map, "/docsify")).toBe("catch-all");
		expect(findPage(map, "/doc")).toBe("catch-all");
	});

	it("resolves wildcard pages contributed through collectPages", () => {
		const reg = collectPages([
			pagePlugin("db.pages", [{ id: "db.catch", path: "/*", component: Page, context: "app" }]),
			pagePlugin("exact", [{ id: "e", path: "/about", component: Page }]),
		]);
		expect(reg.appPages.get("/*")?.pluginId).toBe("db.pages");
		expect(findPage(reg.appPages, "/about")?.pluginId).toBe("exact");
		expect(findPage(reg.appPages, "/anything")?.pluginId).toBe("db.pages");
	});

	it("returns undefined when nothing matches", () => {
		const exactOnly = new Map<string, string>([["/only", "v"]]);
		expect(findPage(exactOnly, "/nope")).toBeUndefined();
		expect(findPage(exactOnly, "/only")).toBe("v");
	});
});

describe("collectPortals / findPortalInstance", () => {
	const portalsPlugin = (id: string, instances: { id: string }[]): Plugin => ({
		id,
		portals: instances.map((i) => ({
			id: i.id,
			basePath: `/portal/${i.id}`,
			label: i.id,
		})),
	});

	it("collects instance descriptors with their owning plugin id", () => {
		const entries = collectPortals([
			{ id: "a.marker" },
			portalsPlugin("b.portals", [{ id: "doctor" }, { id: "translator" }]),
		]);
		expect(entries.map((e) => [e.instance.id, e.pluginId])).toEqual([
			["doctor", "b.portals"],
			["translator", "b.portals"],
		]);
	});

	it("propagates the pkg stamp onto portal instance entries", () => {
		const entries = collectPortals([
			{
				id: "clinician.portal",
				pkg: "clinician",
				portals: [{ id: "clinician", basePath: "/portal/clinician", label: "C" }],
			},
		]);
		expect(entries[0]?.pkg).toBe("clinician");
	});

	it("finds instances by id and misses unknown ones", () => {
		const entries = collectPortals([portalsPlugin("b.portals", [{ id: "doctor" }])]);
		expect(findPortalInstance(entries, "doctor")?.pluginId).toBe("b.portals");
		expect(findPortalInstance(entries, "nope")).toBeUndefined();
	});
});
