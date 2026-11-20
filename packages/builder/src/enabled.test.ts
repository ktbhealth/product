import { describe, expect, it } from "vitest";

import { siteBuilderEnabled } from "./enabled.ts";

const builderPlugin = { id: "site-builder.panel", pkg: "site-builder" };
const builderSibling = { id: "site-builder.other", pkg: "site-builder" };
const pagesPlugin = { id: "pages.panel", pkg: "pages" };

describe("siteBuilderEnabled", () => {
	it("is false when the package is not installed", () => {
		expect(siteBuilderEnabled([pagesPlugin])).toBe(false);
		expect(siteBuilderEnabled([])).toBe(false);
	});

	it("is true when installed and no enable-state set is wired", () => {
		expect(siteBuilderEnabled([pagesPlugin, builderPlugin])).toBe(true);
	});

	it("is package-granular: any member id in the enabled set admits", () => {
		const plugins = [pagesPlugin, builderPlugin, builderSibling];
		expect(siteBuilderEnabled(plugins, ["site-builder.panel"])).toBe(true);
		expect(siteBuilderEnabled(plugins, ["site-builder.other"])).toBe(true);
		expect(siteBuilderEnabled(plugins, ["pages.panel"])).toBe(false);
		expect(siteBuilderEnabled(plugins, [])).toBe(false);
	});

	it("falls back to the id prefix when the pkg stamp is absent", () => {
		const unstamped = { id: "site-builder.panel" };
		expect(siteBuilderEnabled([unstamped])).toBe(true);
		expect(siteBuilderEnabled([unstamped], ["site-builder.panel"])).toBe(true);
		expect(siteBuilderEnabled([unstamped], [])).toBe(false);
	});
});
