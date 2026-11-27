import { describe, expect, it } from "vitest";

import type { FontCatalogFamily } from "@ktb/fonts/catalog";
import { makeDb, type SqlDatabase } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makeTestD1 } from "@ktb/db-testing";

import {
	GOOGLE_FONTS_PROVIDER_KIND,
	loadManagedFontAssets,
	matchManagedFonts,
} from "./managed-fonts.ts";
import type { ThemeFontConfig, ThemeManagedFont } from "./types.ts";

const entry = (over: Partial<FontCatalogFamily> = {}): FontCatalogFamily => ({
	id: 1,
	providerId: 7,
	providerName: "Google",
	kind: "googlefonts",
	family: "Inter",
	weights: [400, 700],
	status: "ready",
	meta: null,
	...over,
});

const fontsWith = (sources: ThemeFontConfig["sources"]): ThemeFontConfig => ({
	delivery: "self-host",
	sources,
});

describe("matchManagedFonts", () => {
	it("returns [] without sources or entries", () => {
		expect(matchManagedFonts({ delivery: "self-host" }, [entry()])).toEqual([]);
		expect(matchManagedFonts(fontsWith({ sans: { providerId: 7, family: "Inter" } }), [])).toEqual(
			[],
		);
	});

	it("matches ready catalog rows per slot with catalog weights", () => {
		const fonts = fontsWith({
			sans: { providerId: 7, family: "Inter" },
			mono: { providerId: 9, family: "JetBrains Mono" },
		});
		const matched = matchManagedFonts(fonts, [
			entry(),
			entry({
				id: 2,
				providerId: 9,
				kind: "local",
				family: "JetBrains Mono",
				weights: [],
				meta: { assetId: 3 },
			}),
		]);
		expect(matched).toEqual([
			{ providerId: 7, family: "Inter", kind: "googlefonts", weights: [400, 700], assetId: null },
			{
				providerId: 9,
				family: "JetBrains Mono",
				kind: "local",
				weights: [],
				assetId: 3,
			},
		]);
	});

	it("skips pending/failed entries, blank families and bad provider ids", () => {
		const fonts = fontsWith({
			sans: { providerId: 7, family: "Inter" },
			heading: { providerId: 7, family: "  " },
			mono: { providerId: 1.5, family: "Inter" },
		});
		expect(
			matchManagedFonts(fonts, [entry({ status: "pending" }), entry({ status: "failed" })]),
		).toEqual([]);
	});

	it("falls back to fonts.weights when the catalog row lists none", () => {
		const fonts = {
			...fontsWith({ sans: { providerId: 7, family: "Inter" } }),
			weights: [300, 600],
		};
		const matched = matchManagedFonts(fonts, [entry({ weights: [] })]);
		expect(matched[0]?.weights).toEqual([300, 600]);
	});
});

// ---------- loadManagedFontAssets ----------

const makeTestDb = () => {
	const d1 = makeTestD1();
	return { db: makeDb(d1), d1 };
};

const insertTheme = (d1: SqlDatabase, fontsJson: string) =>
	d1
		.prepare(
			`INSERT INTO theme_definitions (scope, scope_id, seeds, tokens, fonts, enabled, created_at)
			 VALUES ('platform', '', '{}', '{}', ?, 1, 0)`,
		)
		.bind(fontsJson)
		.run();

const insertFontAsset = (d1: SqlDatabase, themeId: number) =>
	d1
		.prepare(
			`INSERT INTO theme_assets (theme_id, kind, status, created_at) VALUES (?, 'font', 'ready', 0)`,
		)
		.bind(themeId)
		.run();

describe("loadManagedFontAssets", () => {
	it("passes googlefonts entries through untouched", async () => {
		const { db } = makeTestDb();
		const managed: ThemeManagedFont[] = [
			{ providerId: 1, family: "Inter", kind: GOOGLE_FONTS_PROVIDER_KIND, weights: [400] },
		];
		expect(await loadManagedFontAssets(db, managed)).toEqual(managed);
	});

	it("resolves self-host faces via assetId → theme fonts.assets", async () => {
		const { db, d1 } = makeTestDb();
		const fontAsset = {
			faces: [{ url: "/api/theme/assets?key=k.woff2", weight: 400, format: "woff2" }],
			fallback: null,
		};
		await insertTheme(
			d1,
			JSON.stringify({ delivery: "self-host", assets: { "Brand Sans": fontAsset } }),
		);
		await insertFontAsset(d1, 1);
		const managed: ThemeManagedFont[] = [
			{
				providerId: 2,
				family: "Brand Sans",
				kind: "local",
				weights: [],
				assetId: 1,
			},
		];
		const out = await loadManagedFontAssets(db, managed);
		expect(out[0]?.asset).toEqual(fontAsset);
	});

	it("degrades to the bare family when links are missing", async () => {
		const { db, d1 } = makeTestDb();
		const managed: ThemeManagedFont[] = [
			{ providerId: 2, family: "Brand Sans", kind: "local", weights: [], assetId: 99 },
			{ providerId: 2, family: "NoMeta", kind: "local", weights: [] },
		];
		// assetId 99 → no theme_assets row; missing assetId → skipped early.
		expect(await loadManagedFontAssets(db, managed)).toEqual(managed);
		// A font asset whose owning theme lacks the family also degrades.
		await insertTheme(d1, "{}");
		await insertFontAsset(d1, 1);
		const withAsset: ThemeManagedFont[] = [
			{ providerId: 2, family: "Brand Sans", kind: "local", weights: [], assetId: 1 },
		];
		expect(await loadManagedFontAssets(db, withAsset)).toEqual(withAsset);
	});

	it("degrades per family when the asset lookup throws", async () => {
		// theme_assets exists but theme_definitions does not: the asset
		// row resolves, then the owner-theme select throws — the
		// per-family catch must pass the font through untouched.
		const d1 = makeD1(`
			CREATE TABLE theme_assets (
				id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
				theme_id integer,
				kind text NOT NULL,
				r2_key text,
				status text DEFAULT 'pending' NOT NULL,
				variants text,
				created_at integer NOT NULL
			);
		`);
		const db = makeDb(d1);
		await d1
			.prepare(
				`INSERT INTO theme_assets (theme_id, kind, status, created_at) VALUES (1, 'font', 'ready', 0)`,
			)
			.run();
		const managed: ThemeManagedFont[] = [
			{ providerId: 2, family: "Brand Sans", kind: "local", weights: [], assetId: 1 },
		];
		expect(await loadManagedFontAssets(db, managed)).toEqual(managed);
	});

	it("resolves catalog assets (theme_id NULL) from variants.fontAsset", async () => {
		const { db, d1 } = makeTestDb();
		const fontAsset = {
			faces: [{ url: "/api/theme/assets?key=catalog.woff2", weight: 700, format: "woff2" }],
			fallback: null,
		};
		await d1
			.prepare(
				`INSERT INTO theme_assets (theme_id, kind, status, variants, created_at)
				 VALUES (NULL, 'font', 'ready', ?, 0)`,
			)
			.bind(JSON.stringify({ family: "Catalog Sans", fontAsset }))
			.run();
		// A second unowned row WITHOUT the manifest degrades to bare.
		await d1
			.prepare(
				`INSERT INTO theme_assets (theme_id, kind, status, created_at)
				 VALUES (NULL, 'font', 'ready', 0)`,
			)
			.run();
		const managed: ThemeManagedFont[] = [
			{ providerId: 2, family: "Catalog Sans", kind: "local", weights: [], assetId: 1 },
			{ providerId: 2, family: "Orphan", kind: "local", weights: [], assetId: 2 },
		];
		const out = await loadManagedFontAssets(db, managed);
		expect(out[0]?.asset).toEqual(fontAsset);
		expect(out[1]).toEqual(managed[1]);
	});

	it("degrades when the asset's owning theme row is gone", async () => {
		const { db, d1 } = makeTestDb();
		// theme_id 999 has no theme_definitions row — the owner select
		// returns empty and the font passes through without an asset.
		await insertFontAsset(d1, 999);
		const managed: ThemeManagedFont[] = [
			{ providerId: 2, family: "Brand Sans", kind: "local", weights: [], assetId: 1 },
		];
		expect(await loadManagedFontAssets(db, managed)).toEqual(managed);
	});
});
