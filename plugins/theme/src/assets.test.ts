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
	completeThemeAsset,
	contentTypeForKey,
	decodeThemeAssetJob,
	decodeThemeFontJob,
	dominantColorHex,
	extOfKey,
	fontFormatForExt,
	getThemeAsset,
	googleFontsCssUrl,
	insertThemeAsset,
	isBrandAssetKind,
	isImageAssetKind,
	isThemeAssetKind,
	listThemeAssets,
	parseGoogleFontsCss,
	planImageVariants,
	primaryVariantName,
	setThemeBrandRef,
	suggestedSeedsFromColor,
	themeAssetUrl,
	upsertThemeFontAsset,
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
