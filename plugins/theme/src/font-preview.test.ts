import { describe, expect, it } from "vitest";

import { googleFontCssHref } from "@ktb/fonts/adapters/googlefonts";

import { fontPreviewModel } from "./font-preview.ts";
import type { ThemeFontConfig, ThemeFontSourceOption } from "./types.ts";

const SOURCES: readonly ThemeFontSourceOption[] = [
	{
		providerId: 7,
		providerName: "Google",
		providerKind: "googlefonts",
		family: "Inter",
		weights: [400, 700],
	},
	{
		providerId: 9,
		providerName: "Local",
		providerKind: "local",
		family: "Brand Sans",
		weights: [],
	},
];

const slot = (model: ReturnType<typeof fontPreviewModel>, name: string) =>
	model.slots.find((s) => s.slot === name)!;

describe("fontPreviewModel", () => {
	it("returns inherit specimens and no payloads for a null config", () => {
		const model = fontPreviewModel(null, SOURCES);
		expect(model.slots.map((s) => s.slot)).toEqual(["sans", "heading", "mono"]);
		for (const s of model.slots) {
			expect(s.family).toBeNull();
			expect(s.fontFamily).toBe("");
			expect(s.weights).toEqual([400, 500, 600, 700]);
		}
		expect(model.links).toEqual([]);
		expect(model.faceCss).toBe("");
	});

	it("links free-form families only under google-fonts delivery", () => {
		const fonts: ThemeFontConfig = {
			delivery: "google-fonts",
			families: { sans: "Inter", heading: "Inter", mono: "JetBrains Mono" },
			weights: [700, 400, 400],
		};
		const model = fontPreviewModel(fonts, []);
		// Heading repeats sans's family — deduped to a single link.
		expect(model.links).toEqual([
			googleFontCssHref("Inter", [400, 700]),
			googleFontCssHref("JetBrains Mono", [400, 700]),
		]);
		expect(slot(model, "sans").family).toBe("Inter");
		expect(slot(model, "sans").fontFamily).toContain('"Inter"');
		expect(slot(model, "heading").family).toBe("Inter");
		expect(slot(model, "mono").weights).toEqual([400, 700]);
		expect(model.faceCss).toBe("");
	});

	it("emits no links when google-fonts delivery has no families", () => {
		const model = fontPreviewModel({ delivery: "google-fonts" }, SOURCES);
		expect(model.links).toEqual([]);
		for (const s of model.slots) expect(s.family).toBeNull();
	});

	it("tolerates explicit null slot sources", () => {
		const model = fontPreviewModel(
			{
				delivery: "self-host",
				sources: { sans: null, heading: { providerId: 7, family: "Inter" } },
			},
			SOURCES,
		);
		expect(slot(model, "sans").family).toBeNull();
		expect(slot(model, "heading").family).toBe("Inter");
		expect(model.links).toEqual([googleFontCssHref("Inter", [400, 700])]);
	});

	it("emits no links for self-host delivery", () => {
		const model = fontPreviewModel({ delivery: "self-host", families: { sans: "Inter" } }, []);
		expect(model.links).toEqual([]);
	});

	it("ignores blank and out-of-range weights", () => {
		const model = fontPreviewModel(
			{ delivery: "self-host", families: { sans: "Inter" }, weights: [50, 1000, 600] },
			[],
		);
		expect(slot(model, "sans").weights).toEqual([600]);
		const fallback = fontPreviewModel(
			{ delivery: "self-host", families: { sans: "Inter" }, weights: [50] },
			[],
		);
		expect(slot(fallback, "sans").weights).toEqual([400, 500, 600, 700]);
	});

	it("managed googlefonts sources override the family, weights and links", () => {
		const fonts: ThemeFontConfig = {
			delivery: "self-host",
			families: { sans: "Custom Sans" },
			sources: { sans: { providerId: 7, family: "Inter" } },
		};
		const model = fontPreviewModel(fonts, SOURCES);
		const sans = slot(model, "sans");
		expect(sans.family).toBe("Inter");
		expect(sans.fontFamily).toContain('"Inter"');
		expect(sans.fontFamily).not.toContain("Custom Sans");
		expect(sans.weights).toEqual([400, 700]);
		expect(model.links).toEqual([googleFontCssHref("Inter", [400, 700])]);
		// Unbound heading inherits the managed sans family (fontCssVars
		// fallback on the effective config); mono stays unset.
		expect(slot(model, "heading").family).toBe("Inter");
		expect(slot(model, "mono").family).toBeNull();
	});

	it("managed sources with empty catalog weights fall back to theme weights", () => {
		const fonts: ThemeFontConfig = {
			delivery: "self-host",
			weights: [500],
			sources: { mono: { providerId: 7, family: "Inter" } },
		};
		// Point the mono slot at a googlefonts option whose weights are
		// empty by using a catalog row without weights.
		const sources = [{ ...SOURCES[0]!, weights: [] }];
		const model = fontPreviewModel(fonts, sources);
		expect(slot(model, "mono").weights).toEqual([500]);
		expect(model.links).toEqual([googleFontCssHref("Inter", [500])]);
	});

	it("dedupes a managed family also set as a free-form google-fonts family", () => {
		const fonts: ThemeFontConfig = {
			delivery: "google-fonts",
			families: { sans: "Inter", heading: "Inter" },
			sources: { sans: { providerId: 7, family: "Inter" } },
		};
		const model = fontPreviewModel(fonts, SOURCES);
		// Managed link wins; the free-form pass skips the claimed name.
		expect(model.links).toEqual([googleFontCssHref("Inter", [400, 700])]);
	});

	it("managed self-host sources use the family name without links", () => {
		const fonts: ThemeFontConfig = {
			delivery: "self-host",
			sources: { mono: { providerId: 9, family: "Brand Sans" } },
		};
		const model = fontPreviewModel(fonts, SOURCES);
		const mono = slot(model, "mono");
		expect(mono.family).toBe("Brand Sans");
		expect(mono.fontFamily).toContain('"Brand Sans"');
		expect(mono.fontFamily).toContain("monospace");
		expect(mono.weights).toEqual([400, 500, 600, 700]);
		expect(model.links).toEqual([]);
	});

	it("stale sources (no catalog match) fall back to the free-form family", () => {
		const fonts: ThemeFontConfig = {
			delivery: "self-host",
			families: { sans: "Fallback Sans" },
			sources: {
				sans: { providerId: 1, family: "Gone" },
				heading: { providerId: 7, family: "  " },
				mono: { providerId: 7.5, family: "Inter" },
			},
		};
		const model = fontPreviewModel(fonts, SOURCES);
		expect(slot(model, "sans").family).toBe("Fallback Sans");
		expect(slot(model, "sans").fontFamily).toContain('"Fallback Sans"');
		// Heading inherits the sans family; mono has no fallback.
		expect(slot(model, "heading").family).toBe("Fallback Sans");
		expect(slot(model, "mono").family).toBeNull();
		expect(model.links).toEqual([]);
	});

	it("passes the persisted faceCss through and skips stored faces already covered", () => {
		const fonts: ThemeFontConfig = {
			delivery: "self-host",
			families: { sans: "Brand Sans" },
			assets: {
				"Brand Sans": { faces: [{ url: "/api/theme/assets?key=brand.woff2" }] },
			},
		};
		const persisted = {
			faceCss: '@font-face{font-family:"Managed";src:url("/m.woff2");}',
			delivery: "self-host" as const,
		};
		const model = fontPreviewModel(fonts, [], persisted);
		// Persisted self-host already emitted the stored faces — no dup.
		expect(model.faceCss).toBe(persisted.faceCss);
		expect(model.faceCss).not.toContain("brand.woff2");
	});

	it("emits stored faces when the draft switched to self-host after a google-fonts persist", () => {
		const fonts: ThemeFontConfig = {
			delivery: "self-host",
			families: { sans: "Brand Sans", mono: "Code Font" },
			assets: {
				"Brand Sans": { faces: [{ url: "/api/theme/assets?key=brand.woff2" }] },
				"Code Font": { faces: [{ url: "/api/theme/assets?key=code.woff2", weight: 700 }] },
			},
		};
		const model = fontPreviewModel(fonts, [], {
			faceCss: "",
			delivery: "google-fonts",
		});
		expect(model.faceCss).toContain("brand.woff2");
		expect(model.faceCss).toContain("code.woff2");
		expect(model.faceCss).toContain("font-weight:700");
	});

	it("filters asset families claimed by matched self-host sources", () => {
		const fonts: ThemeFontConfig = {
			delivery: "self-host",
			families: { sans: "Other" },
			sources: { mono: { providerId: 9, family: "Brand Sans" } },
			assets: {
				"Brand Sans": { faces: [{ url: "/api/theme/assets?key=brand.woff2" }] },
				Other: { faces: [{ url: "/api/theme/assets?key=other.woff2" }] },
			},
		};
		const model = fontPreviewModel(fonts, SOURCES, {
			faceCss: "",
			delivery: "google-fonts",
		});
		// The managed-owned family is filtered (presentTheme parity);
		// the unmanaged asset still emits.
		expect(model.faceCss).not.toContain("brand.woff2");
		expect(model.faceCss).toContain("other.woff2");
	});

	it("keeps persisted managed faces alongside a draft googlefonts pick", () => {
		const fonts: ThemeFontConfig = {
			delivery: "self-host",
			sources: { mono: { providerId: 7, family: "Inter" } },
		};
		const model = fontPreviewModel(fonts, SOURCES, {
			faceCss: '@font-face{font-family:"Brand Sans";src:url("/local.woff2");}',
			delivery: "self-host",
		});
		expect(model.faceCss).toContain("local.woff2");
		expect(model.links).toEqual([googleFontCssHref("Inter", [400, 700])]);
	});
});

describe("fontVariationSettings", () => {
	it("resolves per-slot axis defaults from stored self-host assets", () => {
		const fonts: ThemeFontConfig = {
			delivery: "self-host",
			families: { sans: "Var Sans", mono: "Var Mono" },
			assets: {
				"Var Sans": {
					faces: [
						{
							url: "/v.woff2",
							axes: [
								{ tag: "slnt", min: -9, default: -2, max: 0 },
								// opsz stays browser-managed — never emitted.
								{ tag: "opsz", min: 6, default: 14, max: 72 },
							],
						},
					],
				},
			},
		};
		const model = fontPreviewModel(fonts, []);
		expect(slot(model, "sans").fontVariationSettings).toBe("'slnt' -2");
		// Heading falls back to the sans family → same settings.
		expect(slot(model, "heading").fontVariationSettings).toBe("'slnt' -2");
		// Mono family has no stored asset → nothing.
		expect(slot(model, "mono").fontVariationSettings).toBe("");
	});

	it("is empty for managed sources and unset slots", () => {
		const model = fontPreviewModel(
			{
				delivery: "self-host",
				sources: { sans: { providerId: 7, family: "Inter" } },
			},
			SOURCES,
		);
		// Managed catalog faces resolve server-side — no client axes.
		expect(slot(model, "sans").fontVariationSettings).toBe("");
		expect(slot(model, "mono").fontVariationSettings).toBe("");
	});
});
