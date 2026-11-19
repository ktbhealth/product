import { describe, expect, it } from "vitest";

import { KTB_DEFAULT_THEME } from "@ktb/theme/default-theme";

import { themeHeadResult } from "./theme-head.ts";

describe("themeHeadResult", () => {
	it("returns an empty head without a resolved theme", () => {
		expect(themeHeadResult(null)).toEqual({});
		expect(themeHeadResult(undefined)).toEqual({});
	});

	it("projects the title, favicon and touch-icon links from the theme", () => {
		const out = themeHeadResult(KTB_DEFAULT_THEME);
		expect(out.meta).toContainEqual({ title: "KTB Health" });
		expect(out.links).toContainEqual({ rel: "icon", href: "/brand/logo-mark.png" });
		expect(out.links).toContainEqual({
			rel: "apple-touch-icon",
			href: "/brand/logo-mark.png",
		});
	});

	it("omits the title tag when the theme names nothing", () => {
		const theme = { ...KTB_DEFAULT_THEME, brand: null, appName: null };
		expect(themeHeadResult(theme)).toEqual({ meta: [], links: [] });
	});
});
