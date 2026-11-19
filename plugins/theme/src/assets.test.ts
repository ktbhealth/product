import { describe, expect, it } from "vitest";

import { makeDb, type DbClient, type SqlDatabase } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import {
	BRAND_FIELD_FOR_KIND,
	IMAGE_UPLOAD_EXTENSIONS,
	FONT_UPLOAD_EXTENSIONS,
	THEME_ASSETS_PREFIX,
	THEME_ASSET_JOB_KIND,
	THEME_FONT_JOB_KIND,
	catalogFontAssetOf,
	catalogFontFamilyOf,
	completeThemeAsset,
	contentTypeForKey,
	decodeThemeAssetJob,
	decodeThemeFontJob,
	dominantColorHex,
	deleteThemeAsset,
	extOfKey,
	fontFormatForExt,
	getThemeAsset,
	googleFontsCssUrl,
	insertCatalogFontAsset,
	insertThemeAsset,
	isBrandAssetKind,
	isImageAssetKind,
	isThemeAssetKind,
	listThemeAssets,
	listUnownedFontAssets,
	parseFontWeightList,
	parseGoogleFontsCss,
	planImageVariants,
	primaryVariantName,
	setThemeBrandRef,
	suggestedSeedsFromColor,
	themeAssetUrl,
	upsertThemeFontAsset,
	weightFromFileName,
} from "./assets.ts";
import type { ThemeFontAsset } from "./types.ts";

const DDL = `
CREATE TABLE theme_assets (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	theme_id integer,
	kind text NOT NULL,
	r2_key text,
	status text DEFAULT 'pending' NOT NULL,
	variants text,
	created_at integer NOT NULL,
	FOREIGN KEY (theme_id) REFERENCES theme_definitions(id) ON UPDATE no action ON DELETE set null
);
CREATE TABLE theme_definitions (
	id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	scope text NOT NULL,
	scope_id text DEFAULT '' NOT NULL,
	app_name text,
	seeds text NOT NULL,
	tokens text NOT NULL,
	fonts text,
	brand text,
	enabled integer DEFAULT true NOT NULL,
	is_main integer DEFAULT false NOT NULL,
	version integer DEFAULT 1 NOT NULL,
	created_at integer NOT NULL,
	updated_at integer
);
`;

interface TestDb {
	readonly db: DbClient;
	readonly d1: SqlDatabase;
}

const makeTestDb = (): TestDb => {
	const d1 = makeD1(DDL);
	return { db: makeDb(d1), d1 };
};

const all = async <T>(d1: SqlDatabase, query: string, params: unknown[] = []) =>
	(
		await d1
			.prepare(query)
			.bind(...params)
			.all<T>()
	).results as T[];

const run = (d1: SqlDatabase, query: string, params: unknown[] = []) =>
	d1
		.prepare(query)
		.bind(...params)
		.run();

const seedTheme = async ({ d1 }: TestDb): Promise<number> => {
	await run(
		d1,
		`INSERT INTO theme_definitions (scope, scope_id, seeds, tokens, created_at)
		 VALUES ('platform', '', '{}', '{}', 0)`,
	);
	const rows = await all<{ id: number }>(d1, `SELECT id FROM theme_definitions`);
	return rows[0]!.id;
};

describe("kind/extension helpers", () => {
	it("recognizes the documented asset kinds", () => {
		expect(isThemeAssetKind("favicon")).toBe(true);
		expect(isThemeAssetKind("font")).toBe(true);
		expect(isThemeAssetKind("banner")).toBe(false);
		expect(isImageAssetKind("font")).toBe(false);
		expect(isImageAssetKind("logo-light")).toBe(true);
		expect(isBrandAssetKind("font")).toBe(false);
		expect(isBrandAssetKind("og-image")).toBe(true);
	});

	it("maps extensions to content types and font formats", () => {
		expect(contentTypeForKey("theme-assets/1/x.PNG")).toBe("image/png");
		expect(contentTypeForKey("theme-assets/1/x.woff2")).toBe("font/woff2");
		expect(contentTypeForKey("theme-assets/1/noext")).toBe("application/octet-stream");
		expect(extOfKey("a/b/c.svg?x=1")).toBe("svg");
		expect(fontFormatForExt("woff2")).toBe("woff2");
		expect(fontFormatForExt("ttf")).toBe("truetype");
		expect(fontFormatForExt("otf")).toBe("opentype");
		expect(fontFormatForExt("png")).toBeUndefined();
	});

	it("builds same-origin serving URLs under the assets route", () => {
		expect(themeAssetUrl("theme-assets/1/f/a b.png")).toBe(
			"/api/theme/assets?key=theme-assets%2F1%2Ff%2Fa%20b.png",
		);
		expect(THEME_ASSETS_PREFIX).toBe("theme-assets/");
	});
});

describe("planImageVariants", () => {
	it("returns nothing for fonts", () => {
		expect(planImageVariants("font", 100, 100, "k.ttf")).toEqual([]);
	});

	it("plans logo variants preserving aspect for non-square", () => {
		const variants = planImageVariants("logo-light", 400, 200, "theme-assets/1/logo/x.png");
		expect(variants.map((v) => `${v.name}.${v.format}`)).toEqual([
			"logo-512.webp",
			"logo-512.png",
			"logo-256.webp",
		]);
		const wide = variants.find((v) => v.name === "logo-512" && v.format === "webp")!;
		expect(wide.width).toBe(512);
		expect(wide.height).toBe(256); // 200/400 * 512
		expect(wide.square).toBe(false);
		expect(wide.key).toBe("theme-assets/1/logo/x-logo-512.webp");
	});

	it("plans favicon 16/32/180 as square crops in png only", () => {
		const variants = planImageVariants("favicon", 64, 64, "theme-assets/1/f.ico.png");
		expect(variants).toHaveLength(3);
		expect(variants.every((v) => v.square && v.format === "png")).toBe(true);
		expect(variants.map((v) => v.name)).toEqual(["favicon-16", "favicon-32", "apple-touch-icon"]);
		expect(variants[2]!.width).toBe(180);
	});

	it("plans the og-image at 1200px webp+png", () => {
		const variants = planImageVariants("og-image", 1200, 630, "k.jpg");
		expect(variants.map((v) => `${v.name}.${v.format}`)).toEqual([
			"og-image-1200.webp",
			"og-image-1200.png",
		]);
		expect(variants[0]!.height).toBe(630);
	});

	it("maps every image kind to its brand field and primary variant", () => {
		expect(Object.keys(BRAND_FIELD_FOR_KIND).sort()).toEqual([
			"favicon",
			"logo-dark",
			"logo-light",
			"og-image",
			"wordmark",
		]);
		expect(primaryVariantName("logo-light")).toBe("logo-512.webp");
		expect(primaryVariantName("favicon")).toBe("favicon-32.png");
		expect(primaryVariantName("og-image")).toBe("og-image-1200.png");
	});
});

describe("dominant color → seed suggestion", () => {
	it("formats #rrggbb and clamps channels", () => {
		expect(dominantColorHex(255, 0, 128)).toBe("#ff0080");
		expect(dominantColorHex(300, -5, 0)).toBe("#ff0000");
		expect(dominantColorHex(1.6, 2.4, 3.5)).toBe("#020204");
	});

	it("suggests the primary seed only — never auto-publishes", () => {
		expect(suggestedSeedsFromColor("#336699")).toEqual({ primary: "#336699" });
	});
});

describe("job payload contracts", () => {
	it("decodes image asset payloads", () => {
		const p = decodeThemeAssetJob({
			assetId: 1,
			themeId: 2,
			kind: "favicon",
			key: "k",
		});
		expect(p).toEqual({ assetId: 1, themeId: 2, kind: "favicon", key: "k" });
		expect(THEME_ASSET_JOB_KIND).toBe("theme.asset");
		expect(() => decodeThemeAssetJob({ assetId: "x" })).toThrow();
	});

	it("decodes upload and google font payloads", () => {
		const upload = decodeThemeFontJob({
			assetId: 1,
			themeId: 2,
			family: "Inter",
			slot: "sans",
			source: "upload",
			key: "theme-assets/2/font/a.woff2",
			format: "woff2",
		});
		expect(upload.source).toBe("upload");
		const google = decodeThemeFontJob({
			assetId: 1,
			themeId: 2,
			family: "Inter",
			slot: "mono",
			source: "google",
			weights: [400, 700],
		});
		expect(google.source).toBe("google");
		expect(THEME_FONT_JOB_KIND).toBe("theme.font");
		expect(() =>
			decodeThemeFontJob({
				assetId: 1,
				themeId: 2,
				family: "x",
				slot: "bad",
				source: "google",
				weights: [400],
			}),
		).toThrow();
	});
});

describe("google fonts css", () => {
	it("builds the css2 url with deduped sorted weights", () => {
		expect(googleFontsCssUrl("Open Sans", [700, 400, 400, 90, 1000])).toBe(
			"https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap",
		);
		expect(googleFontsCssUrl("Inter", [])).toContain("wght@400");
	});

	it("parses @font-face blocks and prefers the latin subset per weight", () => {
		const css = `
/* cyrillic */
@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/cyr.woff2) format('woff2'); }
/* latin */
@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/lat.woff2) format('woff2'); }
/* latin */
@font-face { font-weight: 700; src: url(https://fonts.gstatic.com/bold.woff2) format('woff2'); }
/* cyrillic-ext — non-latin arriving after the latin pick is ignored */
@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/ext.woff2) format('woff2'); }
`;
		const faces = parseGoogleFontsCss(css);
		expect(faces).toEqual([
			{
				url: "https://fonts.gstatic.com/lat.woff2",
				weight: 400,
				format: "woff2",
			},
			{
				url: "https://fonts.gstatic.com/bold.woff2",
				weight: 700,
				format: "woff2",
			},
		]);
	});

	it("returns empty for css without faces and keeps first non-latin when no latin exists", () => {
		expect(parseGoogleFontsCss("body{}")).toEqual([]);
		// No format() hint → defaults to woff2; blocks without weight/src skip.
		const css = `
@font-face { font-weight: 400; src: url(a.woff) format('woff'); }
@font-face { font-weight: 500; src: url(b.woff2); }
@font-face { src: url(no-weight.woff2) format('woff2'); }
@font-face { font-weight: 600; }
`;
		expect(parseGoogleFontsCss(css)).toEqual([
			{ url: "a.woff", weight: 400, format: "woff" },
			{ url: "b.woff2", weight: 500, format: "woff2" },
		]);
	});
});

describe("theme_assets repo helpers", () => {
	it("inserts, reads, completes and brand-links assets", async () => {
		const { db, d1 } = makeTestDb();
		const themeId = await seedTheme({ db, d1 });
		const asset = await insertThemeAsset(db, {
			themeId,
			kind: "favicon",
			r2Key: `${THEME_ASSETS_PREFIX}${themeId}/favicon/u.png`,
		});
		expect(asset).toMatchObject({
			themeId,
			kind: "favicon",
			status: "pending",
		});

		await completeThemeAsset(db, asset!.id, {
			status: "ready",
			variants: {
				files: { "favicon-32.png": { key: "k" } },
				dominantColor: "#112233",
			},
		});
		const row = await getThemeAsset(db, asset!.id);
		expect(row?.status).toBe("ready");
		expect(JSON.parse(row!.variants!)).toMatchObject({
			dominantColor: "#112233",
		});

		await setThemeBrandRef(db, themeId, "favicon", "/api/theme/assets?key=k");
		const themes = await all<{ brand: string }>(
			d1,
			`SELECT brand FROM theme_definitions WHERE id = ?`,
			[themeId],
		);
		expect(JSON.parse(themes[0]!.brand)).toEqual({
			favicon: "/api/theme/assets?key=k",
		});
	});

	it("upsertThemeFontAsset forces self-host and preserves other slots/families", async () => {
		const { db, d1 } = makeTestDb();
		const themeId = await seedTheme({ db, d1 });
		await run(d1, `UPDATE theme_definitions SET fonts = ? WHERE id = ?`, [
			JSON.stringify({
				delivery: "google-fonts",
				families: { mono: "JetBrains Mono" },
				assets: {
					"JetBrains Mono": { faces: [{ url: "u", format: "woff2" }] },
				},
			}),
			themeId,
		]);
		const fontAsset: ThemeFontAsset = {
			faces: [{ url: "/api/theme/assets?key=k", weight: 400, format: "woff2" }],
			fallback: {
				name: "Inter fallback",
				local: "Arial",
				metrics: {
					sizeAdjust: 100,
					ascentOverride: 90,
					descentOverride: 20,
					lineGapOverride: 0,
				},
			},
		};
		const next = await upsertThemeFontAsset(db, themeId, {
			family: "Inter",
			slot: "sans",
			asset: fontAsset,
		});
		expect(next?.delivery).toBe("self-host");
		expect(next?.families).toEqual({ mono: "JetBrains Mono", sans: "Inter" });
		expect(next?.assets?.["Inter"]).toEqual(fontAsset);
		expect(next?.assets?.["JetBrains Mono"]).toBeDefined();

		const stored = await all<{ fonts: string }>(
			d1,
			`SELECT fonts FROM theme_definitions WHERE id = ?`,
			[themeId],
		);
		expect(JSON.parse(stored[0]!.fonts).families.sans).toBe("Inter");
	});

	it("listThemeAssets returns one theme's rows newest first", async () => {
		const { db, d1 } = makeTestDb();
		const themeId = await seedTheme({ db, d1 });
		await seedTheme({ db, d1 });
		const otherId = (
			await all<{ id: number }>(d1, `SELECT id FROM theme_definitions ORDER BY id DESC LIMIT 1`)
		)[0]!.id;
		const a = await insertThemeAsset(db, {
			themeId,
			kind: "favicon",
			r2Key: `${THEME_ASSETS_PREFIX}${themeId}/favicon/a.png`,
		});
		const b = await insertThemeAsset(db, { themeId, kind: "font", r2Key: null });
		await insertThemeAsset(db, { themeId: otherId, kind: "favicon", r2Key: "k3" });
		const rows = await listThemeAssets(db, themeId);
		expect(rows.map((r) => r.id)).toEqual([b!.id, a!.id]);
		expect(rows.every((r) => r.themeId === themeId)).toBe(true);
	});

	it("returns null when the theme row is gone", async () => {
		const { db } = makeTestDb();
		expect(
			await upsertThemeFontAsset(db, 999, {
				family: "X",
				slot: "sans",
				asset: { faces: [], fallback: null },
			}),
		).toBeNull();
	});
});

describe("catalog font weight parsing", () => {
	it("parseFontWeightList handles singles, lists, ranges and separators", () => {
		expect(parseFontWeightList("700")).toEqual([700]);
		expect(parseFontWeightList("400,700")).toEqual([400, 700]);
		expect(parseFontWeightList("700, 400,700")).toEqual([400, 700]);
		expect(parseFontWeightList("400 700")).toEqual([400, 700]);
		expect(parseFontWeightList("400;500;600")).toEqual([400, 500, 600]);
		expect(parseFontWeightList("400-700")).toEqual([400, 500, 600, 700]);
		expect(parseFontWeightList("100–400")).toEqual([100, 200, 300, 400]); // en dash
		expect(parseFontWeightList("400-750")).toEqual([400, 500, 600, 700]); // steps of 100
		expect(parseFontWeightList("450-650")).toEqual([450, 550, 650]);
		expect(parseFontWeightList("400 - 700")).toEqual([400, 500, 600, 700]); // spaces ok
	});

	it("parseFontWeightList rejects malformed and out-of-range input", () => {
		expect(parseFontWeightList("")).toBeNull();
		expect(parseFontWeightList("   ")).toBeNull();
		expect(parseFontWeightList("abc")).toBeNull();
		expect(parseFontWeightList("50")).toBeNull();
		expect(parseFontWeightList("1000")).toBeNull();
		expect(parseFontWeightList("700-400")).toBeNull(); // descending range
		expect(parseFontWeightList("400-abc")).toBeNull();
		expect(parseFontWeightList("-400")).toBeNull();
		expect(parseFontWeightList("400x")).toBeNull();
		expect(parseFontWeightList("400,,700")).toEqual([400, 700]); // empty segments skip
		expect(parseFontWeightList(" , ; ")).toBeNull(); // separators only
	});

	it("weightFromFileName reads numeric and style-word hints", () => {
		expect(weightFromFileName("Inter-Bold.woff2")).toBe(700);
		expect(weightFromFileName("Inter_700.ttf")).toBe(700);
		expect(weightFromFileName("roboto-medium.woff")).toBe(500);
		expect(weightFromFileName("Family-SemiBold.otf")).toBe(600);
		expect(weightFromFileName("Family-ExtraLight.woff2")).toBe(200);
		expect(weightFromFileName("Family-Black")).toBe(900);
		expect(weightFromFileName("Family-Thin")).toBe(100);
		// Numeric token wins over a contradictory style word.
		expect(weightFromFileName("Odd-300-Bold.woff2")).toBe(300);
		// Out-of-range digits are not weights; falls through to style.
		expect(weightFromFileName("Font-50-Bold.woff2")).toBe(700);
	});

	it("weightFromFileName returns undefined for ambiguous names", () => {
		expect(weightFromFileName("Inter.woff2")).toBeUndefined();
		expect(weightFromFileName("Inter-VariableFont_wdth,wght.woff2")).toBeUndefined();
		expect(weightFromFileName("Font400")).toBeUndefined(); // digits fused to letters
		expect(weightFromFileName("noext")).toBeUndefined();
	});
});

describe("catalog font assets (theme_id NULL)", () => {
	it("catalogFontFamilyOf/catalogFontAssetOf parse the variants contract", () => {
		expect(catalogFontFamilyOf(null)).toBeNull();
		expect(catalogFontFamilyOf("not json")).toBeNull();
		expect(catalogFontFamilyOf("[1,2]")).toBeNull();
		expect(catalogFontFamilyOf("{}")).toBeNull();
		expect(catalogFontFamilyOf('{"family":"  "}')).toBeNull();
		expect(catalogFontFamilyOf('{"family":" Inter "}')).toBe("Inter");
		expect(catalogFontAssetOf(null)).toBeNull();
		expect(catalogFontAssetOf("not json")).toBeNull();
		expect(catalogFontAssetOf("5")).toBeNull();
		expect(catalogFontAssetOf("[1,2]")).toBeNull();
		expect(catalogFontAssetOf("{}")).toBeNull();
		expect(catalogFontAssetOf('{"fontAsset":{}}')).toBeNull();
		expect(catalogFontAssetOf('{"fontAsset":{"faces":"x"}}')).toBeNull();
		expect(
			catalogFontAssetOf(
				JSON.stringify({
					family: "Inter",
					fontAsset: { faces: [{ url: "u", weight: 400 }], fallback: null },
				}),
			),
		).toEqual({ faces: [{ url: "u", weight: 400 }], fallback: null });
	});

	it("insertCatalogFontAsset writes a ready unowned row with the manifest", async () => {
		const { db } = makeTestDb();
		const asset = await insertCatalogFontAsset(db, {
			family: "Brand Sans",
			weights: [600],
			r2Key: `${THEME_ASSETS_PREFIX}catalog/font/u.woff2`,
			format: "woff2",
		});
		expect(asset).toMatchObject({ themeId: null, kind: "font", status: "ready" });
		const variants = JSON.parse(asset!.variants!);
		expect(variants.family).toBe("Brand Sans");
		expect(variants.weights).toEqual([600]);
		expect(variants.fontAsset.faces).toEqual([
			{
				url: "/api/theme/assets?key=theme-assets%2Fcatalog%2Ffont%2Fu.woff2",
				weight: 600,
				format: "woff2",
			},
		]);
		expect(catalogFontFamilyOf(asset!.variants)).toBe("Brand Sans");
		expect(catalogFontAssetOf(asset!.variants)?.faces).toHaveLength(1);
	});

	it("insertCatalogFontAsset emits one face per weight, sorted and deduped", async () => {
		const { db } = makeTestDb();
		const asset = await insertCatalogFontAsset(db, {
			family: "Var",
			weights: [700, 400, 700, 50],
			r2Key: "v.woff2",
			format: "woff2",
		});
		const variants = JSON.parse(asset!.variants!);
		// Out-of-range weights are filtered; the rest sort + dedupe.
		expect(variants.weights).toEqual([400, 700]);
		expect(variants.fontAsset.faces).toEqual([
			{
				url: "/api/theme/assets?key=v.woff2",
				weight: 400,
				format: "woff2",
			},
			{
				url: "/api/theme/assets?key=v.woff2",
				weight: 700,
				format: "woff2",
			},
		]);
	});

	it("omits weights/weight/format when not provided", async () => {
		const { db } = makeTestDb();
		const asset = await insertCatalogFontAsset(db, {
			family: "Plain",
			weights: undefined,
			r2Key: "k.ttf",
			format: undefined,
		});
		const variants = JSON.parse(asset!.variants!);
		expect(variants.weights).toBeUndefined();
		const face = catalogFontAssetOf(asset!.variants)!.faces[0]!;
		expect(face).toEqual({ url: "/api/theme/assets?key=k.ttf" });
	});

	it("omits format on weighted faces when not provided", async () => {
		const { db } = makeTestDb();
		const asset = await insertCatalogFontAsset(db, {
			family: "NoFormat",
			weights: [400],
			r2Key: "k.bin",
			format: undefined,
		});
		expect(catalogFontAssetOf(asset!.variants)!.faces).toEqual([
			{ url: "/api/theme/assets?key=k.bin", weight: 400 },
		]);
	});

	it("insertCatalogFontAsset returns null when the insert yields no row", async () => {
		const emptyInsert = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as DbClient;
		expect(
			await insertCatalogFontAsset(emptyInsert, {
				family: "X",
				weights: undefined,
				r2Key: "k",
				format: undefined,
			}),
		).toBeNull();
	});

	it("listUnownedFontAssets returns only theme_id NULL font rows, newest first", async () => {
		const { db, d1 } = makeTestDb();
		const themeId = await seedTheme({ db, d1 });
		await insertThemeAsset(db, { themeId, kind: "font", r2Key: "owned.woff2" });
		await insertThemeAsset(db, { themeId, kind: "favicon", r2Key: null });
		const cat = await insertCatalogFontAsset(db, {
			family: "A",
			weights: undefined,
			r2Key: "a.woff2",
			format: "woff2",
		});
		// Orphaned theme font row (theme deleted → theme_id NULL, no
		// family stamp) — listed but never family-matched.
		await run(
			d1,
			`INSERT INTO theme_assets (theme_id, kind, status, created_at) VALUES (NULL, 'font', 'ready', 0)`,
		);
		const rows = await listUnownedFontAssets(db);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.themeId === null && r.kind === "font")).toBe(true);
		expect(rows.map((r) => r.id)).toContain(cat!.id);
		// Newest first — the raw orphan insert lands after the catalog row.
		expect(rows[0]!.id).toBeGreaterThan(rows[1]!.id);
	});

	it("deleteThemeAsset removes the row", async () => {
		const { db } = makeTestDb();
		const asset = await insertCatalogFontAsset(db, {
			family: "Doomed",
			weights: undefined,
			r2Key: "d.woff2",
			format: "woff2",
		});
		await deleteThemeAsset(db, asset!.id);
		expect(await getThemeAsset(db, asset!.id)).toBeNull();
	});
});

describe("edge branches", () => {
	it("planImageVariants handles keys without an extension", () => {
		const variants = planImageVariants("favicon", 10, 10, "nodot");
		expect(variants[0]!.key).toBe("nodot-favicon-16.png");
	});

	it("insertThemeAsset returns null when the insert yields no row", async () => {
		const emptyInsert = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as DbClient;
		expect(
			await insertThemeAsset(emptyInsert, {
				themeId: 1,
				kind: "favicon",
				r2Key: "k",
			}),
		).toBeNull();
	});

	it("getThemeAsset returns null for a missing id", async () => {
		const { db } = makeTestDb();
		expect(await getThemeAsset(db, 999)).toBeNull();
	});

	it("setThemeBrandRef merges into existing brand JSON and tolerates bad payloads", async () => {
		const { db, d1 } = makeTestDb();
		const themeId = await seedTheme({ db, d1 });
		// Missing theme → no-op.
		await setThemeBrandRef(db, 999, "favicon", "/x");
		// Valid object brand merges.
		await run(d1, `UPDATE theme_definitions SET brand = ? WHERE id = ?`, [
			JSON.stringify({ appName: "Acme" }),
			themeId,
		]);
		await setThemeBrandRef(db, themeId, "favicon", "/fav.ico");
		let rows = await all<{ brand: string }>(
			d1,
			`SELECT brand FROM theme_definitions WHERE id = ?`,
			[themeId],
		);
		expect(JSON.parse(rows[0]!.brand)).toEqual({
			appName: "Acme",
			favicon: "/fav.ico",
		});
		// Invalid JSON and non-object JSON both degrade to {}.
		for (const bad of ["{oops", "[1,2,3]", "42"]) {
			await run(d1, `UPDATE theme_definitions SET brand = ? WHERE id = ?`, [bad, themeId]);
			await setThemeBrandRef(db, themeId, "wordmark", "/w.svg");
			rows = await all<{ brand: string }>(d1, `SELECT brand FROM theme_definitions WHERE id = ?`, [
				themeId,
			]);
			expect(JSON.parse(rows[0]!.brand)).toEqual({ wordmark: "/w.svg" });
		}
	});

	it("upsertThemeFontAsset tolerates null/invalid/empty fonts columns", async () => {
		const { db, d1 } = makeTestDb();
		const themeId = await seedTheme({ db, d1 });
		const asset: ThemeFontAsset = {
			faces: [{ url: "/f.woff2" }],
			fallback: null,
		};
		for (const fonts of [null, "{oops", "[1]", "{}", "42"]) {
			await run(d1, `UPDATE theme_definitions SET fonts = ? WHERE id = ?`, [fonts, themeId]);
			const next = await upsertThemeFontAsset(db, themeId, {
				family: "Inter",
				slot: "sans",
				asset,
			});
			expect(next).not.toBeNull();
			expect(next!.delivery).toBe("self-host");
			expect(next!.families?.sans).toBe("Inter");
			expect(next!.assets?.Inter).toEqual(asset);
		}
	});
});

describe("parseGoogleFontsCss edges", () => {
	it("skips blocks without weight/src and defaults missing format to woff2", () => {
		const css = `
@font-face { font-weight: 400; src: url(a.woff2); }
@font-face { color: red; }
@font-face { font-weight: 700; }
/* latin */
@font-face { font-weight: 400; src: url(lat.woff2); }
`;
		expect(parseGoogleFontsCss(css)).toEqual([{ url: "lat.woff2", weight: 400, format: "woff2" }]);
	});
});
