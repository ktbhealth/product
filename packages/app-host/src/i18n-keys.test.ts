import { describe, expect, it } from "vitest";
import type { Plugin } from "@ktb/kernel";

import { collectI18nKeys } from "./i18n-keys.ts";

const plugin = (id: string, i18nKeys?: Plugin["i18nKeys"]): Plugin => ({ id, i18nKeys }) as Plugin;

describe("collectI18nKeys", () => {
	it("returns empty maps for an empty registry", () => {
		expect(collectI18nKeys([])).toEqual({ labels: {}, groups: {}, notes: {} });
	});

	it("merges labels/groups/notes across plugins", () => {
		const keys = collectI18nKeys([
			plugin("a.chrome", {
				labels: { "/x": "nav_x" },
				groups: { Account: "panel_group_account" },
				notes: { disclaimer: "footer_disclaimer" },
			}),
			plugin("b.chrome", {
				labels: { "/y": "nav_y" },
				groups: { Site: "panel_group_site" },
			}),
			plugin("c.marker"),
		]);
		expect(keys.labels).toEqual({ "/x": "nav_x", "/y": "nav_y" });
		expect(keys.groups).toEqual({
			Account: "panel_group_account",
			Site: "panel_group_site",
		});
		expect(keys.notes).toEqual({ disclaimer: "footer_disclaimer" });
	});

	it("lets later plugins win key collisions (topo order)", () => {
		const keys = collectI18nKeys([
			plugin("a.chrome", { labels: { "/x": "nav_x" } }),
			plugin("b.chrome", { labels: { "/x": "nav_x_b" } }),
		]);
		expect(keys.labels["/x"]).toBe("nav_x_b");
	});
});
