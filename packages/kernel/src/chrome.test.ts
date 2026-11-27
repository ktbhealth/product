import { describe, expect, it, vi } from "vitest";
import type { ChromeContribution, Plugin } from "@ktb/kernel";

import {
	chromePortal,
	chromeWhenMatches,
	collectChrome,
	KNOWN_CHROME_REGIONS,
	unknownChromeRegions,
	warnUnknownChromeRegions,
} from "./chrome.ts";

const entry = (
	id: string,
	region: string,
	extra?: Partial<ChromeContribution>,
): ChromeContribution => ({
	id,
	region,
	content: { kind: "link", to: `/${id}`, label: id },
	...extra,
});

const plugin = (id: string, chrome: ChromeContribution[]): Plugin => ({ id, chrome }) as Plugin;

describe("chromeWhenMatches", () => {
	it("matches everything without rules", () => {
		expect(chromeWhenMatches(undefined, "/anything")).toBe(true);
		expect(chromeWhenMatches({}, "/anything")).toBe(true);
		expect(chromeWhenMatches({ paths: [] }, "/anything")).toBe(true);
	});

	it("matches exact paths", () => {
		const when = { paths: ["/platform"] };
		expect(chromeWhenMatches(when, "/platform")).toBe(true);
		expect(chromeWhenMatches(when, "/platform/users")).toBe(false);
		expect(chromeWhenMatches(when, "/other")).toBe(false);
	});

	it("matches prefix/* subtrees including the bare prefix", () => {
		const when = { paths: ["/platform/*"] };
		expect(chromeWhenMatches(when, "/platform")).toBe(true);
		expect(chromeWhenMatches(when, "/platform/users")).toBe(true);
		expect(chromeWhenMatches(when, "/platformish")).toBe(false);
		expect(chromeWhenMatches(when, "/")).toBe(false);
	});

	it("lets exceptPaths win over paths", () => {
		const when = { paths: ["/platform/*"], exceptPaths: ["/platform/users"] };
		expect(chromeWhenMatches(when, "/platform/groups")).toBe(true);
		expect(chromeWhenMatches(when, "/platform/users")).toBe(false);
		expect(chromeWhenMatches(when, "/platform/users/42")).toBe(true);
	});

	it("excludes when ANY exceptPaths entry matches, not all of them", () => {
		const when = {
			paths: ["/platform/*"],
			exceptPaths: ["/platform/users", "/platform/groups"],
		};
		expect(chromeWhenMatches(when, "/platform/users")).toBe(false);
		expect(chromeWhenMatches(when, "/platform/groups")).toBe(false);
		expect(chromeWhenMatches(when, "/platform/roles")).toBe(true);
	});

	it("admits when ANY paths entry matches, not all of them", () => {
		const when = { paths: ["/platform", "/admin"] };
		expect(chromeWhenMatches(when, "/platform")).toBe(true);
		expect(chromeWhenMatches(when, "/admin")).toBe(true);
		expect(chromeWhenMatches(when, "/other")).toBe(false);
	});

	it("gates on minDoctorProfiles against the session user", () => {
		const when = { minDoctorProfiles: 2 };
		const solo = { id: "u", email: "u@x", doctorProfiles: 1 };
		const duo = { ...solo, doctorProfiles: 2 };
		expect(chromeWhenMatches(when, "/x", duo)).toBe(true);
		expect(chromeWhenMatches(when, "/x", solo)).toBe(false);
		// Fails closed: unknown count or no user hides the contribution.
		expect(chromeWhenMatches(when, "/x", { id: "u", email: "u@x" })).toBe(false);
		expect(chromeWhenMatches(when, "/x", null)).toBe(false);
		expect(chromeWhenMatches(when, "/x")).toBe(false);
		// Combines with path rules — both must admit.
		const both = { ...when, paths: ["/portal/*"] };
		expect(chromeWhenMatches(both, "/portal/doctor", duo)).toBe(true);
		expect(chromeWhenMatches(both, "/elsewhere", duo)).toBe(false);
	});

	it("gates on minTenantRole against the bound tenant role", () => {
		const when = { minTenantRole: "admin" as const };
		const base = { id: "u", email: "u@x" };
		expect(chromeWhenMatches(when, "/x", { ...base, tenantRole: "owner" })).toBe(true);
		expect(chromeWhenMatches(when, "/x", { ...base, tenantRole: "admin" })).toBe(true);
		expect(chromeWhenMatches(when, "/x", { ...base, tenantRole: "member" })).toBe(false);
		// "member" admits every role.
		expect(
			chromeWhenMatches({ minTenantRole: "member" }, "/x", { ...base, tenantRole: "member" }),
		).toBe(true);
		// Fails closed: unresolved/absent role or no user hides it.
		expect(chromeWhenMatches(when, "/x", base)).toBe(false);
		expect(chromeWhenMatches(when, "/x", { ...base, tenantRole: null })).toBe(false);
		expect(chromeWhenMatches(when, "/x", null)).toBe(false);
		expect(chromeWhenMatches(when, "/x")).toBe(false);
	});
});

describe("collectChrome", () => {
	it("filters by region and when, preserving plugin/entry order", () => {
		const plugins = [
			plugin("a", [entry("a.nav", "app.header.nav"), entry("a.side", "portal.sidebar")]),
			plugin("b", [entry("b.nav", "app.header.nav", { when: { paths: ["/x"] } })]),
		];
		expect(collectChrome(plugins, "app.header.nav", "/x").map((e) => e.id)).toEqual([
			"a.nav",
			"b.nav",
		]);
		expect(collectChrome(plugins, "app.header.nav", "/y").map((e) => e.id)).toEqual(["a.nav"]);
		expect(collectChrome(plugins, "portal.sidebar", "/x").map((e) => e.id)).toEqual(["a.side"]);
	});

	it("sorts by order, then plugin topo order, then array index", () => {
		const plugins = [
			plugin("a", [
				entry("a.late", "r", { order: 20 }),
				entry("a.first", "r", { order: 0 }),
				entry("a.unordered", "r"),
			]),
			plugin("b", [entry("b.mid", "r", { order: 10 })]),
		];
		expect(collectChrome(plugins, "r", "/").map((e) => e.id)).toEqual([
			"a.first",
			"b.mid",
			"a.late",
			"a.unordered",
		]);
		// Same order → plugin order, then entry index.
		const tied = [
			plugin("a", [entry("a.2", "r", { order: 1 }), entry("a.1", "r", { order: 1 })]),
			plugin("b", [entry("b.1", "r", { order: 1 })]),
		];
		expect(collectChrome(tied, "r", "/").map((e) => e.id)).toEqual(["a.2", "a.1", "b.1"]);
	});

	it("filters clinical conditions against the session user", () => {
		const plugins = [
			plugin("a", [
				entry("a.switch", "portal.sidebar", {
					portal: "doctor",
					when: { minDoctorProfiles: 2 },
				}),
				entry("a.plain", "portal.sidebar", { portal: "doctor" }),
			]),
		];
		const solo = { id: "u", email: "u@x", doctorProfiles: 1 };
		const duo = { ...solo, doctorProfiles: 2 };
		const ids = (user?: typeof solo | null) =>
			collectChrome(plugins, "portal.sidebar", "/x", "doctor", user).map((e) => e.id);
		expect(ids(duo)).toEqual(["a.switch", "a.plain"]);
		expect(ids(solo)).toEqual(["a.plain"]);
		// No resolved user → clinical conditions fail closed.
		expect(ids()).toEqual(["a.plain"]);
	});

	it("collects loginTile content like any other kind (P-099)", () => {
		const Icon = () => null;
		const plugins = [
			plugin("a", [
				entry("a.tile", "app.login.tiles", {
					order: 1,
					content: {
						kind: "loginTile",
						to: "/login/doctor",
						labelKey: "nav_doctor_login",
						fallback: "Doctor sign in",
						icon: Icon,
						requires: ["doctors.services"],
					},
				}),
				entry("a.other", "app.login.tiles", { order: 0 }),
			]),
		];
		const collected = collectChrome(plugins, "app.login.tiles", "/login");
		expect(collected.map((e) => e.id)).toEqual(["a.other", "a.tile"]);
		expect(collected[1]?.content).toMatchObject({
			kind: "loginTile",
			to: "/login/doctor",
			labelKey: "nav_doctor_login",
			requires: ["doctors.services"],
		});
	});

	it("scopes portal-tagged entries to the requested portal instance", () => {
		const plugins = [
			plugin("a", [
				entry("a.doc", "portal.sidebar", { portal: "doctor" }),
				entry("a.plat", "portal.sidebar"), // untagged → platform
				entry("a.clinic", "portal.sidebar", { portal: "clinic" }),
			]),
		];
		const ids = (portal?: string) =>
			collectChrome(plugins, "portal.sidebar", "/", portal).map((e) => e.id);
		expect(ids("doctor")).toEqual(["a.doc"]);
		expect(ids("platform")).toEqual(["a.plat"]);
		// No portal arg → every instance's entries collect, in entry order.
		expect(ids()).toEqual(["a.doc", "a.plat", "a.clinic"]);
	});

	it("tolerates plugins without a chrome contribution", () => {
		const plugins = [{ id: "bare" } as Plugin, plugin("a", [entry("a.nav", "app.header.nav")])];
		expect(collectChrome(plugins, "app.header.nav", "/").map((e) => e.id)).toEqual(["a.nav"]);
	});
});

describe("unknownChromeRegions", () => {
	it("lists contributed regions outside the known set", () => {
		const plugins = [
			plugin("a", [entry("a.1", "app.header.nav"), entry("a.2", "bogus.region")]),
			plugin("b", [entry("b.1", "bogus.region"), entry("b.2", "also.bogus")]),
		];
		expect(unknownChromeRegions(plugins, new Set(["app.header.nav"]))).toEqual([
			"also.bogus",
			"bogus.region",
		]);
	});

	it("ignores plugins without chrome", () => {
		const plugins = [{ id: "bare" } as Plugin];
		expect(unknownChromeRegions(plugins, new Set())).toEqual([]);
	});

	it("warns once per unknown region", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const plugins = [plugin("a", [entry("a.1", "bogus"), entry("a.2", "bogus")])];
		warnUnknownChromeRegions(plugins, new Set());
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("bogus"));
		warn.mockRestore();
	});
});

describe("KNOWN_CHROME_REGIONS", () => {
	it("declares exactly the regions the first-party shells render", () => {
		expect([...KNOWN_CHROME_REGIONS].sort()).toEqual(
			[
				"app.header.brand",
				"app.header.nav",
				"app.header.actions",
				"app.header.session",
				"app.footer.blocks",
				"app.footer.note",
				"app.notFound.actions",
				"app.error.actions",
				"app.login.tiles",
				"portal.sidebar",
				"portal.brand",
				"portal.header.actions",
				"portal.dashboard.stats",
				"portal.dashboard.sections",
				"rich-text.delete.actions",
				"templates.save.actions",
			].sort(),
		);
	});

	it("does not flag contributions aimed at declared regions", () => {
		const plugins = [plugin("a", [entry("a.1", "app.header.nav"), entry("a.2", "portal.sidebar")])];
		expect(unknownChromeRegions(plugins, KNOWN_CHROME_REGIONS)).toEqual([]);
	});
});

describe("chromePortal", () => {
	it("defaults untagged entries to the platform portal", () => {
		expect(chromePortal(entry("a.1", "portal.sidebar"))).toBe("platform");
		expect(chromePortal(entry("a.2", "portal.sidebar", { portal: "doctor" }))).toBe("doctor");
	});
});
