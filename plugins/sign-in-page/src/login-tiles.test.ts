import { describe, expect, it } from "vitest";
import { definePlugin, type ChromeContribution, type Plugin } from "@ktb/kernel";

import { loginTileTargets, visibleLoginTiles } from "./login-tiles.ts";

/**
 * Local reimplementation of app-host's login-tiles gate — these tests
 * mirror the host route's coverage (apps/web/src/routes/login.test.tsx
 * filtering cases) against synthetic registries.
 */

const Icon = () => null;

const tile = (
	id: string,
	to: string,
	extra: Partial<Extract<ChromeContribution["content"], { kind: "loginTile" }>> = {},
): ChromeContribution => ({
	id: `chrome.${id}`,
	region: "app.login.tiles",
	content: {
		kind: "loginTile",
		to,
		labelKey: `nav_${id}_login`,
		fallback: `${id} sign in`,
		icon: Icon,
		...extra,
	},
});

const chromePlugin = (
	id: string,
	pkg: string | undefined,
	entries: readonly ChromeContribution[],
): Plugin =>
	definePlugin({
		id,
		...(pkg === undefined ? {} : { pkg }),
		meta: { keywords: ["ui"] },
		chrome: [...entries],
	});

const markerPlugin = (id: string, pkg: string | undefined): Plugin =>
	definePlugin({
		id,
		...(pkg === undefined ? {} : { pkg }),
		meta: { keywords: ["marker"] },
	});

/** Registry mirroring the real sign-in flows: patient-portal owns the
 * patient tile, auth owns the doctor tile gated on the clinical
 * packages, secretaries owns the secretary tile. */
const registry = (): Plugin[] => [
	markerPlugin("patient-portal.services", "patient-portal"),
	chromePlugin("patient-portal.chrome", "patient-portal", [tile("patient", "/login/patient")]),
	markerPlugin("auth.routes", "auth"),
	chromePlugin("auth.chrome", "auth", [
		tile("doctor", "/login/doctor", {
			requires: ["doctors.services", "clinician.portal"],
		}),
	]),
	markerPlugin("doctors.services", "doctors"),
	markerPlugin("clinician.portal", "clinician"),
	markerPlugin("secretaries.services", "secretaries"),
	chromePlugin("secretaries.chrome", "secretaries", [tile("secretary", "/login/secretary")]),
];

const allEnabled = (plugins: readonly Plugin[]) => ({
	enabled: plugins.map((p) => p.id),
});
const withoutPkg = (plugins: readonly Plugin[], pkg: string) => ({
	enabled: plugins.filter((p) => p.pkg !== pkg).map((p) => p.id),
});

describe("visibleLoginTiles", () => {
	it("returns every loginTile in render order when all plugins are enabled", () => {
		const plugins = registry();
		const tiles = visibleLoginTiles(plugins, allEnabled(plugins));
		expect(tiles.map((e) => (e.content.kind === "loginTile" ? e.content.to : ""))).toEqual([
			"/login/patient",
			"/login/doctor",
			"/login/secretary",
		]);
	});

	it("hides tiles whose plugin is disabled", () => {
		const plugins = registry();
		const states = withoutPkg(plugins, "secretaries");
		const tiles = visibleLoginTiles(plugins, states);
		expect(tiles.map((e) => e.id)).not.toContain("chrome.secretary");
		expect(tiles.map((e) => e.id)).toEqual(
			expect.arrayContaining(["chrome.patient", "chrome.doctor"]),
		);
	});

	it("hides the doctor tile when a `requires` package is disabled", () => {
		const plugins = registry();
		for (const pkg of ["doctors", "clinician"]) {
			const tiles = visibleLoginTiles(plugins, withoutPkg(plugins, pkg));
			expect(tiles.map((e) => e.id)).not.toContain("chrome.doctor");
			// The patient tile is unaffected.
			expect(tiles.map((e) => e.id)).toContain("chrome.patient");
		}
	});

	it("resolves `requires` package-granularly like entryEnabled", () => {
		const plugins = registry();
		// Disabling doctors.services alone keeps package "doctors" live
		// only if another member is enabled — here it is the sole member,
		// so the package is dead and the doctor tile hides.
		const states = {
			enabled: plugins
				.filter((p) => !(p.pkg === "doctors" && p.id === "doctors.services"))
				.map((p) => p.id),
		};
		expect(visibleLoginTiles(plugins, states).map((e) => e.id)).not.toContain("chrome.doctor");
	});

	it("resolves `requires` per-id for unstamped plugins", () => {
		const plugins = [
			chromePlugin("a.chrome", "a", [tile("x", "/login/x", { requires: ["plain.plugin"] })]),
			markerPlugin("plain.plugin", undefined),
		];
		expect(visibleLoginTiles(plugins, allEnabled(plugins))).toHaveLength(1);
		expect(visibleLoginTiles(plugins, { enabled: ["a.chrome"] })).toEqual([]);
	});

	it("fails closed on unknown `requires` ids", () => {
		const plugins = [
			chromePlugin("a.chrome", "a", [tile("x", "/login/x", { requires: ["ghost.plugin"] })]),
		];
		expect(visibleLoginTiles(plugins, allEnabled(plugins))).toEqual([]);
	});

	it("skips non-loginTile contributions in the region defensively", () => {
		const plugins = [
			definePlugin({
				id: "odd.chrome",
				meta: { keywords: ["ui"] },
				chrome: [
					{
						id: "odd.link",
						region: "app.login.tiles",
						content: { kind: "link", to: "/nowhere", label: "nowhere" },
					},
				],
			}),
		];
		expect(visibleLoginTiles(plugins, allEnabled(plugins))).toEqual([]);
	});

	it("accepts an already enabled-filtered registry (ctx.plugins)", () => {
		const plugins = registry();
		const states = allEnabled(plugins);
		const filtered = plugins.filter((p) => states.enabled.includes(p.id));
		// Filtered input resolves the same tiles for per-id requires.
		const tiles = visibleLoginTiles(filtered, states);
		expect(tiles.map((e) => e.id)).toEqual(["chrome.patient", "chrome.doctor", "chrome.secretary"]);
	});
});

describe("loginTileTargets", () => {
	it("returns the `to` paths of the visible tiles", () => {
		const plugins = registry();
		const targets = loginTileTargets(plugins, allEnabled(plugins));
		expect(targets).toEqual(new Set(["/login/patient", "/login/doctor", "/login/secretary"]));
	});

	it("drops targets whose flow is gated off", () => {
		const plugins = registry();
		const targets = loginTileTargets(plugins, withoutPkg(plugins, "clinician"));
		expect(targets.has("/login/doctor")).toBe(false);
		expect(targets.has("/login/patient")).toBe(true);
	});
});
