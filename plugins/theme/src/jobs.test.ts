import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import * as Effect from "effect/Effect";

import { makeDb, Db, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { themeAssets, themeDefinitions } from "@ktb/db/schema";
import type { JobMessageLike } from "@ktb/jobs-port";
import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";
import { insertThemeAsset } from "./assets.ts";
import { localFontForSlot } from "./font-metrics.ts";

// photon.resize is wrapped so one test can force the dominant-color
// probe to see a pixel buffer too small to read channels from; every
// other call delegates to the real WASM implementation.
const photonProbe = vi.hoisted(() => ({ rawPixels: null as number[] | null }));
vi.mock("@cf-wasm/photon", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cf-wasm/photon")>();
	return {
		...actual,
		resize: (...args: Parameters<typeof actual.resize>) => {
			const px = photonProbe.rawPixels;
			if (px !== null) {
				photonProbe.rawPixels = null;
				return {
					get_raw_pixels: () => new Uint8Array(px),
					free: () => {},
				} as unknown as ReturnType<typeof actual.resize>;
			}
			return actual.resize(...args);
		},
	};
});

// localFontForSlot stays real by default (it wraps the actual impl); a
// test can force an unknown system font to cover the missing-metrics
// fallback path in buildFallback.
vi.mock("./font-metrics.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./font-metrics.ts")>();
	return { ...actual, localFontForSlot: vi.fn(actual.localFontForSlot) };
});

import {
	MAX_THEME_ASSET_BYTES,
	handleThemeQueueBatch,
	makePhotonProcessor,
	processThemeAssetJob,
	processThemeFontJob,
	type RenderedVariant,
	type ThemeFontFetch,
	type ThemeImageProcessor,
	type ThemeJobDeps,
} from "./jobs.ts";

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
CREATE TABLE job_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', payload_ref TEXT, error TEXT, tenant_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO theme_definitions (scope, scope_id, seeds, tokens, created_at)
	VALUES ('platform', '', '{}', '{}', 0);
`;

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
// 1x1 red PNG — decodable by the real WASM processor.
const PNG_1PX = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);
const WOFF2_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

/**
 * Minimal sfnt fixture (same trick as plugins/theme font-metrics
 * tests): a TTF directory carrying head/hhea/OS/2 with the exact field
 * offsets parseFontMetrics reads, so uploads/downloads yield real
 * FontMetrics and the fallback builder runs its full path.
 */
const f16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const fi16 = (v: number) => f16(v & 0xffff);
const f32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const ftag = (s: string) => [...s].map((c) => c.charCodeAt(0));
const ftable = (name: string, data: number[]) => ({ name: ftag(name), data });
const fhead = ftable(
	"head",
	(() => {
		const d = new Array(20).fill(0);
		d.splice(18, 2, ...f16(2048));
		return d;
	})(),
);
const fhhea = ftable(
	"hhea",
	(() => {
		const d = new Array(10).fill(0);
		d.splice(4, 2, ...fi16(1800));
		d.splice(6, 2, ...fi16(-400));
		d.splice(8, 2, ...fi16(0));
		return d;
	})(),
);
const fos2 = ftable(
	"OS/2",
	(() => {
		const d = new Array(4).fill(0);
		d.splice(2, 2, ...fi16(900));
		return d;
	})(),
);
const buildSfnt = (tables: { name: number[]; data: number[] }[]): Uint8Array => {
	const numTables = tables.length;
	let offset = 12 + numTables * 16;
	const records: number[] = [];
	const body: number[] = [];
	for (const t of tables) {
		records.push(...t.name, ...f32(0), ...f32(offset), ...f32(t.data.length));
		body.push(...t.data);
		offset += t.data.length;
	}
	return new Uint8Array([
		...ftag("true"),
		...f16(numTables),
		...f16(0),
		...f16(0),
		...f16(0),
		...records,
		...body,
	]);
};
const TTF_BYTES = buildSfnt([fhead, fhhea, fos2]);

/** Scripted ThemeFontFetch: respond decides per (url, user-agent);
 * throwing inside respond simulates a transport failure. */
type FetchHit = { text?: string; bytes?: Uint8Array; ok?: boolean };
const scriptedFetch =
	(respond: (url: string, ua: string) => FetchHit | undefined): ThemeFontFetch =>
	async (url, init) => {
		const ua = String((init?.headers as Record<string, string> | undefined)?.["user-agent"] ?? "");
		const hit = respond(url, ua);
		if (hit === undefined) throw new Error(`unscripted fetch: ${url}`);
		const ok = hit.ok ?? true;
		return {
			ok,
			status: ok ? 200 : 500,
			text: async () => hit.text ?? "",
			arrayBuffer: async () => (hit.bytes ?? new Uint8Array([1])).buffer as ArrayBuffer,
		};
	};

/** @font-face block for the google-css parser (latin subset). */
const fontFaceBlock = (weight: number, url: string, format = "woff2") => `
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: ${weight};
  src: url(${url}) format('${format}');
}`;
const cssDoc = (...blocks: string[]) => blocks.join("\n");

const fakeProcessor = (over: Partial<ThemeImageProcessor> = {}): ThemeImageProcessor => ({
	decode: async () => ({ width: 400, height: 200 }),
	render: async (_bytes, variant): Promise<RenderedVariant> => ({
		bytes: new Uint8Array([9, 9, 9]),
		width: variant.width,
		height: variant.height,
	}),
	dominantColor: async () => "#336699",
	...over,
});

const makeBucket = (objects: Record<string, { size?: number; data: Uint8Array }>) => {
	const store = new Map<string, Uint8Array>();
	for (const [k, v] of Object.entries(objects)) store.set(k, v.data);
	return {
		store,
		bucket: {
			get: async (key: string) => {
				const data = store.get(key);
				if (data === undefined) return null;
				const declared = objects[key]?.size ?? data.byteLength;
				const bytes = data.slice();
				return { size: declared, arrayBuffer: async () => bytes.buffer };
			},
			put: async (key: string, value: Uint8Array) => {
				store.set(key, value.slice());
			},
		},
	};
};

const makeDeps = async (over: Partial<ThemeJobDeps> = {}) => {
	const db = makeDb(makeD1(DDL));
	const theme = (await db.select().from(themeDefinitions).limit(1))[0]!;
	const deps: ThemeJobDeps = {
		db,
		bucket: makeBucket({ "theme-assets/1/favicon/u.png": { data: PNG_BYTES } }).bucket,
		processor: fakeProcessor(),
		...over,
	};
	return { db, themeId: theme.id, deps };
};

const seedAsset = async (db: DbClient, themeId: number, kind = "favicon") => {
	const asset = await insertThemeAsset(db, {
		themeId,
		kind: kind as never,
		r2Key: "theme-assets/1/favicon/u.png",
	});
	return asset!;
};

const assetRow = async (db: DbClient, id: number) =>
	(await db.select().from(themeAssets).where(eq(themeAssets.id, id)))[0];

describe("processThemeAssetJob", () => {
	it("derives variants, writes R2 objects, marks ready and links brand", async () => {
		const { db, themeId, deps } = await makeDeps();
		const asset = await seedAsset(db, themeId);
		await processThemeAssetJob(
			{ assetId: asset.id, themeId, kind: "favicon", key: "theme-assets/1/favicon/u.png" },
			deps,
		);
		const row = await assetRow(db, asset.id);
		expect(row?.status).toBe("ready");
		const variants = JSON.parse(row!.variants!) as Record<string, unknown>;
		expect(variants.dominantColor).toBe("#336699");
		expect(variants.suggestedSeeds).toEqual({ primary: "#336699" });
		expect(variants.source).toEqual({ width: 400, height: 200 });
		const files = variants.files as Record<string, { key: string; width: number }>;
		expect(Object.keys(files).sort()).toEqual([
			"apple-touch-icon.png",
			"favicon-16.png",
			"favicon-32.png",
		]);
		// Canonical favicon variant is what the brand field points at.
		const theme = (await db.select().from(themeDefinitions))[0]!;
		expect(JSON.parse(theme.brand!).favicon).toContain("/api/theme/assets?key=");
	});

	it("writes every planned derivative to the bucket", async () => {
		const { db, themeId, deps } = await makeDeps();
		const { bucket, store } = makeBucket({
			"theme-assets/1/logo/u.png": { data: PNG_BYTES },
		});
		const d = { ...deps, bucket };
		const asset = await seedAsset(db, themeId, "logo-light");
		await processThemeAssetJob(
			{ assetId: asset.id, themeId, kind: "logo-light", key: "theme-assets/1/logo/u.png" },
			d,
		);
		expect([...store.keys()].filter((k) => k.includes("logo-512"))).toHaveLength(2);
		expect(store.has("theme-assets/1/logo/u-logo-256.webp")).toBe(true);
	});

	it("is idempotent: an already-ready asset is skipped", async () => {
		const { db, themeId, deps } = await makeDeps();
		const asset = await seedAsset(db, themeId);
		await db.update(themeAssets).set({ status: "ready" }).where(eq(themeAssets.id, asset.id));
		await processThemeAssetJob(
			{ assetId: asset.id, themeId, kind: "favicon", key: "theme-assets/1/favicon/u.png" },
			deps,
		);
		const row = await assetRow(db, asset.id);
		expect(row?.variants).toBeNull(); // untouched — no reprocessing
	});

	it("marks failed on missing object, oversize, undecodable and bad kind", async () => {
		const { db, themeId, deps } = await makeDeps();
		let d = deps;
		const missing = await seedAsset(db, themeId);
		await processThemeAssetJob(
			{ assetId: missing.id, themeId, kind: "favicon", key: "theme-assets/1/nope.png" },
			d,
		);
		expect((await assetRow(db, missing.id))?.status).toBe("failed");

		const big = await seedAsset(db, themeId);
		d = {
			...d,
			bucket: makeBucket({
				"theme-assets/1/favicon/u.png": { size: MAX_THEME_ASSET_BYTES + 1, data: PNG_BYTES },
			}).bucket,
		};
		await processThemeAssetJob(
			{ assetId: big.id, themeId, kind: "favicon", key: "theme-assets/1/favicon/u.png" },
			d,
		);
		expect((await assetRow(db, big.id))?.status).toBe("failed");

		const junk = await seedAsset(db, themeId);
		d = {
			...d,
			bucket: makeBucket({ "theme-assets/1/favicon/u.png": { data: PNG_BYTES } }).bucket,
			processor: fakeProcessor({ decode: async () => null }),
		};
		await processThemeAssetJob(
			{ assetId: junk.id, themeId, kind: "favicon", key: "theme-assets/1/favicon/u.png" },
			d,
		);
		expect((await assetRow(db, junk.id))?.status).toBe("failed");

		const badKind = await seedAsset(db, themeId);
		await processThemeAssetJob(
			{ assetId: badKind.id, themeId, kind: "font" as never, key: "k" },
			d,
		);
		expect((await assetRow(db, badKind.id))?.status).toBe("failed");
	});

	it("marks failed when storage/processor are unconfigured or the row is gone", async () => {
		const { db, themeId, deps } = await makeDeps();
		const asset = await seedAsset(db, themeId);
		await processThemeAssetJob(
			{ assetId: asset.id, themeId, kind: "favicon", key: "k" },
			{ ...deps, bucket: undefined },
		);
		expect((await assetRow(db, asset.id))?.status).toBe("failed");
		// Missing row → silent ack (nothing to mark).
		await processThemeAssetJob({ assetId: 99999, themeId, kind: "favicon", key: "k" }, deps);
	});

	it("omits color suggestions when the dominant probe returns null or throws", async () => {
		const { db, themeId, deps } = await makeDeps();
		const payload = (assetId: number) => ({
			assetId,
			themeId,
			kind: "favicon" as const,
			key: "theme-assets/1/favicon/u.png",
		});

		const none = await seedAsset(db, themeId);
		await processThemeAssetJob(payload(none.id), {
			...deps,
			processor: fakeProcessor({ dominantColor: async () => null }),
		});
		const v1 = JSON.parse((await assetRow(db, none.id))!.variants!) as Record<string, unknown>;
		expect(v1.dominantColor).toBeUndefined();
		expect(v1.suggestedSeeds).toBeUndefined();

		const boom = await seedAsset(db, themeId);
		await processThemeAssetJob(payload(boom.id), {
			...deps,
			processor: fakeProcessor({
				dominantColor: async () => {
					throw new Error("probe failed");
				},
			}),
		});
		expect((await assetRow(db, boom.id))?.status).toBe("ready");
	});

	it("skips the brand ref when the asset row lost its theme", async () => {
		const { db, themeId, deps } = await makeDeps();
		const asset = await seedAsset(db, themeId);
		await db.update(themeAssets).set({ themeId: null }).where(eq(themeAssets.id, asset.id));
		await processThemeAssetJob(
			{ assetId: asset.id, themeId, kind: "favicon", key: "theme-assets/1/favicon/u.png" },
			deps,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("ready");
		// setThemeBrandRef is skipped — the theme row keeps brand = null.
		expect((await db.select().from(themeDefinitions))[0]!.brand).toBeNull();
	});
});

describe("processThemeFontJob — upload source", () => {
	it("stores the face URL, upserts fonts config and marks ready", async () => {
		const { db, themeId, deps } = await makeDeps();
		const d = {
			...deps,
			bucket: makeBucket({
				"theme-assets/1/font/inter.woff2": { data: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1]) },
			}).bucket,
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "upload",
				key: "theme-assets/1/font/inter.woff2",
				format: "woff2",
			},
			d,
		);
		const row = await assetRow(db, asset.id);
		expect(row?.status).toBe("ready");
		const theme = (await db.select().from(themeDefinitions))[0]!;
		const fonts = JSON.parse(theme.fonts!) as {
			delivery: string;
			families: Record<string, string>;
			assets: Record<string, { faces: { url: string; format: string }[] }>;
		};
		expect(fonts.delivery).toBe("self-host");
		expect(fonts.families.sans).toBe("Inter");
		expect(fonts.assets.Inter.faces[0]!.url).toContain("/api/theme/assets?key=");
		expect(fonts.assets.Inter.faces[0]!.format).toBe("woff2");
	});

	it("marks failed on missing font object, oversize and missing theme", async () => {
		const { db, themeId, deps } = await makeDeps();
		let d = { ...deps, bucket: makeBucket({}).bucket };
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "upload",
				key: "theme-assets/1/font/missing.woff2",
				format: "woff2",
			},
			d,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("failed");

		d = {
			...d,
			bucket: makeBucket({
				"theme-assets/1/font/big.ttf": { size: 6 * 1024 * 1024, data: new Uint8Array([1]) },
			}).bucket,
		};
		const big = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: big.id,
				themeId,
				family: "X",
				slot: "mono",
				source: "upload",
				key: "theme-assets/1/font/big.ttf",
				format: "ttf",
			},
			d,
		);
		expect((await assetRow(db, big.id))?.status).toBe("failed");
	});

	it("derives ext/format fallbacks and a metric-matched fallback for parseable uploads", async () => {
		const { db, themeId, deps } = await makeDeps();
		const d = {
			...deps,
			bucket: makeBucket({
				// Extensionless key → payload.format supplies the ext.
				"theme-assets/1/font/inter": { data: TTF_BYTES },
				// Unknown ext → fontFormatForExt misses → payload.format wins.
				"theme-assets/1/font/raw.bin": { data: TTF_BYTES },
			}).bucket,
		};
		const fontJob = (
			assetId: number,
			family: string,
			slot: "sans" | "mono",
			key: string,
			format: string,
		) => processThemeFontJob({ assetId, themeId, family, slot, source: "upload", key, format }, d);

		const ttf = await seedAsset(db, themeId, "font");
		await fontJob(ttf.id, "Inter", "sans", "theme-assets/1/font/inter", "ttf");
		const raw = await seedAsset(db, themeId, "font");
		await fontJob(raw.id, "Raw", "mono", "theme-assets/1/font/raw.bin", "woff2");

		const theme = (await db.select().from(themeDefinitions))[0]!;
		const fonts = JSON.parse(theme.fonts!) as {
			assets: Record<
				string,
				{
					faces: { url: string; format: string }[];
					fallback: { name: string; local: string } | null;
				}
			>;
		};
		expect(fonts.assets.Inter.faces[0]).toMatchObject({ format: "truetype" });
		expect(decodeURIComponent(fonts.assets.Inter.faces[0]!.url)).toContain("font/inter");
		expect(fonts.assets.Inter.fallback?.name).toBe("Inter fallback");
		expect(fonts.assets.Inter.fallback?.local).toBe("Arial");
		expect(fonts.assets.Raw.faces[0]).toMatchObject({ format: "woff2" });
		expect(fonts.assets.Raw.faces[0]!.url).toContain("raw.bin");
	});

	it("stamps weightRange/unicodeRange on variable-font uploads", async () => {
		const { db, themeId, deps } = await makeDeps();
		const fixed = (n: number) => f32(Math.round(n * 65536));
		const ffvar = ftable("fvar", [
			...f16(1),
			...f16(0),
			...f16(16),
			...f16(0),
			...f16(2), // axisCount: wght + wdth
			...f16(20),
			...f16(0),
			...f16(0),
			...ftag("wght"),
			...fixed(100),
			...fixed(400),
			...fixed(900),
			...f16(0),
			...f16(256),
			...ftag("wdth"),
			...fixed(75),
			...fixed(100),
			...fixed(125),
			...f16(0),
			...f16(256),
		]);
		const fcmap = ftable("cmap", [
			...f16(0),
			...f16(1),
			...f16(3),
			...f16(10),
			...f32(12),
			...f16(12),
			...f16(0),
			...f32(28),
			...f32(0),
			...f32(1),
			...f32(0x20),
			...f32(0x7e),
			...f32(0),
		]);
		const varTtf = buildSfnt([fhead, fhhea, fos2, ffvar, fcmap]);
		const d = {
			...deps,
			bucket: makeBucket({
				"theme-assets/1/font/var.ttf": { data: varTtf },
			}).bucket,
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Var",
				slot: "sans",
				source: "upload",
				key: "theme-assets/1/font/var.ttf",
				format: "ttf",
			},
			d,
		);
		const theme = (await db.select().from(themeDefinitions))[0]!;
		const fonts = JSON.parse(theme.fonts!) as {
			assets: Record<
				string,
				{
					faces: {
						weightRange?: number[];
						unicodeRange?: string;
						weight?: number;
						axes?: { tag: string; min: number; default: number; max: number }[];
					}[];
				}
			>;
		};
		expect(fonts.assets.Var.faces[0]).toMatchObject({
			weightRange: [100, 900],
			unicodeRange: "U+0020-007E",
			axes: [{ tag: "wdth", min: 75, default: 100, max: 125 }],
		});
	});

	it("marks failed without storage, on done/missing rows and on a deleted theme", async () => {
		const { db, themeId, deps } = await makeDeps();
		const d = {
			...deps,
			bucket: makeBucket({
				"theme-assets/1/font/f.woff2": { data: WOFF2_BYTES },
			}).bucket,
		};
		const job = (assetId: number) =>
			processThemeFontJob(
				{
					assetId,
					themeId,
					family: "Inter",
					slot: "sans",
					source: "upload",
					key: "theme-assets/1/font/f.woff2",
					format: "woff2",
				},
				d,
			);

		const noBucket = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: noBucket.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "upload",
				key: "theme-assets/1/font/f.woff2",
				format: "woff2",
			},
			{ ...d, bucket: undefined },
		);
		expect((await assetRow(db, noBucket.id))?.status).toBe("failed");

		// Already-ready rows are skipped untouched (idempotent redelivery).
		const done = await seedAsset(db, themeId, "font");
		await db.update(themeAssets).set({ status: "ready" }).where(eq(themeAssets.id, done.id));
		await job(done.id);
		expect((await assetRow(db, done.id))?.variants).toBeNull();

		// Missing row → silent ack.
		await job(99999);

		// Theme row gone → upsert returns null → "theme not found".
		const orphan = await seedAsset(db, themeId, "font");
		await db.delete(themeDefinitions).where(eq(themeDefinitions.id, themeId));
		await job(orphan.id);
		expect((await assetRow(db, orphan.id))?.status).toBe("failed");
	});

	it("returns a null fallback when the slot's system font has no metrics", async () => {
		const { db, themeId, deps } = await makeDeps();
		vi.mocked(localFontForSlot).mockReturnValueOnce("Papyrus");
		const d = {
			...deps,
			bucket: makeBucket({ "theme-assets/1/font/f.ttf": { data: TTF_BYTES } }).bucket,
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "upload",
				key: "theme-assets/1/font/f.ttf",
				format: "ttf",
			},
			d,
		);
		const theme = (await db.select().from(themeDefinitions))[0]!;
		const fonts = JSON.parse(theme.fonts!) as {
			assets: Record<string, { fallback: unknown }>;
		};
		expect(fonts.assets.Inter.fallback).toBeNull();
	});
});

describe("processThemeFontJob — google source", () => {
	const cssFor = (weight: number, url: string) => `
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: ${weight};
  src: url(${url}) format('woff2');
}`;

	const fetchImpl =
		(over: Partial<Record<string, { text?: string; bytes?: Uint8Array }>> = {}): ThemeFontFetch =>
		async (url) => {
			const hit =
				over[url] ??
				(url.includes("fonts.googleapis.com")
					? { text: cssFor(400, "https://fonts.gstatic.com/i-latin.woff2") }
					: { bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32]) });
			return {
				ok: true,
				status: 200,
				text: async () => hit.text ?? "",
				arrayBuffer: async () =>
					new Uint8Array(hit.bytes ?? new Uint8Array([1])).buffer as ArrayBuffer,
			};
		};

	it("downloads woff2 faces into R2 and records the manifest", async () => {
		const { db, themeId, deps } = await makeDeps();
		const { bucket, store } = makeBucket({});
		const d = { ...deps, bucket, fetchImpl: fetchImpl() };
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "google",
				weights: [400],
			},
			d,
		);
		const row = await assetRow(db, asset.id);
		expect(row?.status).toBe("ready");
		expect(store.has("theme-assets/1/fonts/inter-400.woff2")).toBe(true);
		const theme = (await db.select().from(themeDefinitions))[0]!;
		const fonts = JSON.parse(theme.fonts!) as {
			families: Record<string, string>;
			assets: Record<string, { faces: { weight?: number; format: string }[] }>;
		};
		expect(fonts.families.sans).toBe("Inter");
		expect(fonts.assets.Inter.faces[0]).toMatchObject({ weight: 400, format: "woff2" });
	});

	it("fails when the css fetch fails or yields no faces", async () => {
		const { db, themeId, deps } = await makeDeps();
		const d = {
			...deps,
			bucket: makeBucket({}).bucket,
			fetchImpl: (async () => ({
				ok: false,
				status: 500,
				text: async () => "",
				arrayBuffer: async () => new ArrayBuffer(0),
			})) satisfies ThemeFontFetch,
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "google",
				weights: [400],
			},
			d,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("failed");
	});

	it("marks failed when the css request throws", async () => {
		const { db, themeId, deps } = await makeDeps();
		const d = {
			...deps,
			bucket: makeBucket({}).bucket,
			fetchImpl: scriptedFetch(() => {
				throw new Error("socket hangup");
			}),
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "google",
				weights: [400],
			},
			d,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("failed");
	});

	it("marks failed when the stylesheet yields no usable font faces", async () => {
		const { db, themeId, deps } = await makeDeps();
		const d = {
			...deps,
			bucket: makeBucket({}).bucket,
			fetchImpl: scriptedFetch(() => ({ text: "body { color: red }" })),
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "google",
				weights: [400],
			},
			d,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("failed");
	});

	it("fails when every font download fails, whatever the failure mode", async () => {
		const { db, themeId, deps } = await makeDeps();
		const css = cssDoc(
			fontFaceBlock(400, "https://fonts.gstatic.com/s/x/a.woff2"),
			fontFaceBlock(500, "https://fonts.gstatic.com/s/x/b.woff2"),
			fontFaceBlock(700, "https://fonts.gstatic.com/s/x/c.woff2"),
			fontFaceBlock(800, "https://fonts.gstatic.com/s/x/d.woff2"),
		);
		const d = {
			...deps,
			bucket: makeBucket({}).bucket,
			fetchImpl: scriptedFetch((url) => {
				if (url.includes("googleapis")) return { text: css };
				if (url.includes("/a.")) return { ok: false };
				if (url.includes("/b.")) throw new Error("socket reset");
				if (url.includes("/c.")) return { bytes: new Uint8Array(0) };
				if (url.includes("/d.")) return { bytes: new Uint8Array(5 * 1024 * 1024 + 1) };
				return { bytes: WOFF2_BYTES };
			}),
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "google",
				weights: [400, 500, 700, 800],
			},
			d,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("failed");
	});

	it("downloads ttf metrics first and skips the legacy probe", async () => {
		const { db, themeId, deps } = await makeDeps();
		const { bucket, store } = makeBucket({});
		const seen: string[] = [];
		const d = {
			...deps,
			bucket,
			fetchImpl: scriptedFetch((url, ua) => {
				seen.push(ua);
				if (url.includes("googleapis")) {
					return {
						text: cssDoc(
							fontFaceBlock(400, "https://fonts.gstatic.com/s/inter/v40/a.ttf", "truetype"),
							fontFaceBlock(700, "https://fonts.gstatic.com/s/inter/v40/b.woff2"),
						),
					};
				}
				if (url.endsWith(".ttf")) return { bytes: TTF_BYTES };
				return { bytes: WOFF2_BYTES };
			}),
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "google",
				weights: [400, 700],
			},
			d,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("ready");
		expect(store.has("theme-assets/1/fonts/inter-400.ttf")).toBe(true);
		expect(store.has("theme-assets/1/fonts/inter-700.woff2")).toBe(true);
		const theme = (await db.select().from(themeDefinitions))[0]!;
		const fonts = JSON.parse(theme.fonts!) as {
			assets: Record<
				string,
				{
					faces: { weight?: number; format: string }[];
					fallback: { name: string; local: string } | null;
				}
			>;
		};
		expect(fonts.assets.Inter.faces.map((f) => f.format)).toEqual(["truetype", "woff2"]);
		expect(fonts.assets.Inter.fallback?.name).toBe("Inter fallback");
		// Metrics were parseable → the legacy-UA probe never ran.
		expect(seen.every((ua) => ua.includes("Chrome"))).toBe(true);
	});

	it("handles extensionless urls and unknown font formats", async () => {
		const { db, themeId, deps } = await makeDeps();
		const { bucket, store } = makeBucket({});
		const d = {
			...deps,
			bucket,
			fetchImpl: scriptedFetch((url) => {
				if (url.includes("googleapis")) {
					return {
						text: cssDoc(
							fontFaceBlock(400, "https://fonts.gstatic.com/s/x/naked", "truetype"),
							fontFaceBlock(500, "https://fonts.gstatic.com/s/x/naked2"),
							fontFaceBlock(700, "https://fonts.gstatic.com/s/x/blob.bin"),
						),
					};
				}
				if (url.endsWith("/naked")) return { bytes: TTF_BYTES };
				return { bytes: WOFF2_BYTES };
			}),
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "google",
				weights: [400, 500, 700],
			},
			d,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("ready");
		// Key ext falls back to "woff2" for extensionless urls, keeps ".bin".
		expect(store.has("theme-assets/1/fonts/inter-400.woff2")).toBe(true);
		expect(store.has("theme-assets/1/fonts/inter-500.woff2")).toBe(true);
		expect(store.has("theme-assets/1/fonts/inter-700.bin")).toBe(true);
		const theme = (await db.select().from(themeDefinitions))[0]!;
		const fonts = JSON.parse(theme.fonts!) as {
			assets: Record<string, { faces: { format: string }[] }>;
		};
		// probeFont: ext "" + format truetype → "ttf" → "truetype";
		// ext "" + woff2 → "woff2"; ext "bin" unknown → css format wins.
		expect(fonts.assets.Inter.faces.map((f) => f.format)).toEqual(["truetype", "woff2", "woff2"]);
	});

	it("treats an unreachable legacy css as missing metrics", async () => {
		const { db, themeId, deps } = await makeDeps();
		const { bucket } = makeBucket({});
		const d = {
			...deps,
			bucket,
			fetchImpl: scriptedFetch((url, ua) => {
				if (url.includes("googleapis")) {
					// Legacy-UA css request fails → no metrics probe at all.
					if (ua.includes("MSIE")) return { ok: false };
					return { text: cssFor(400, "https://fonts.gstatic.com/s/x/mod.woff2") };
				}
				return { bytes: WOFF2_BYTES };
			}),
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "google",
				weights: [400],
			},
			d,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("ready");
		const theme = (await db.select().from(themeDefinitions))[0]!;
		const fonts = JSON.parse(theme.fonts!) as {
			assets: Record<string, { fallback: unknown }>;
		};
		expect(fonts.assets.Inter.fallback).toBeNull();
	});

	it("treats an undownloadable legacy probe as missing metrics", async () => {
		const { db, themeId, deps } = await makeDeps();
		const { bucket } = makeBucket({});
		const d = {
			...deps,
			bucket,
			fetchImpl: scriptedFetch((url, ua) => {
				if (url.includes("googleapis")) {
					if (ua.includes("MSIE")) {
						return {
							text: cssFor(400, "https://fonts.gstatic.com/s/x/legacy.ttf"),
						};
					}
					return { text: cssFor(400, "https://fonts.gstatic.com/s/x/mod.woff2") };
				}
				if (url.endsWith("legacy.ttf")) return { ok: false };
				return { bytes: WOFF2_BYTES };
			}),
		};
		const asset = await seedAsset(db, themeId, "font");
		await processThemeFontJob(
			{
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "google",
				weights: [400],
			},
			d,
		);
		expect((await assetRow(db, asset.id))?.status).toBe("ready");
		const theme = (await db.select().from(themeDefinitions))[0]!;
		const fonts = JSON.parse(theme.fonts!) as {
			assets: Record<string, { fallback: unknown }>;
		};
		expect(fonts.assets.Inter.fallback).toBeNull();
	});
});

describe("handleThemeQueueBatch", () => {
	const envelope = (kind: string, payload: unknown, id = "env-1") => ({
		id,
		kind,
		payload,
		tenantId: null,
	});
	const msg = (body: unknown): JobMessageLike & { log: string[] } => {
		const log: string[] = [];
		return {
			body,
			log,
			ack: () => log.push("ack"),
			retry: () => log.push("retry"),
		};
	};

	it("acks + marks done for a valid theme.asset envelope", async () => {
		const { db, themeId, deps } = await makeDeps();
		const asset = await seedAsset(db, themeId);
		const m = msg(
			envelope("theme.asset", {
				assetId: asset.id,
				themeId,
				kind: "favicon",
				key: "theme-assets/1/favicon/u.png",
			}),
		);
		await handleThemeQueueBatch([m], deps);
		expect(m.log).toEqual(["ack"]);
		expect((await assetRow(db, asset.id))?.status).toBe("ready");
	});

	it("acks invalid payloads and unknown kinds without retrying", async () => {
		const { db, deps } = await makeDeps();
		const bad = msg(envelope("theme.asset", { nope: true }));
		const unknown = msg(envelope("other.kind", {}));
		await handleThemeQueueBatch([bad, unknown], deps);
		expect(bad.log).toEqual(["ack"]);
		expect(unknown.log).toEqual(["ack"]);
		expect(db).toBeDefined();
	});

	it("acks + marks done for a valid theme.font envelope", async () => {
		const { db, themeId, deps } = await makeDeps();
		const d = {
			...deps,
			bucket: makeBucket({
				"theme-assets/1/font/inter.woff2": { data: WOFF2_BYTES },
			}).bucket,
		};
		const asset = await seedAsset(db, themeId, "font");
		const m = msg(
			envelope("theme.font", {
				assetId: asset.id,
				themeId,
				family: "Inter",
				slot: "sans",
				source: "upload",
				key: "theme-assets/1/font/inter.woff2",
				format: "woff2",
			}),
		);
		await handleThemeQueueBatch([m], d);
		expect(m.log).toEqual(["ack"]);
		expect((await assetRow(db, asset.id))?.status).toBe("ready");
	});

	it("resolves the platform deps when none are injected", async () => {
		// Covers defaultThemeJobDeps() + the optional deps parameter: the
		// consumer binds the Db service and theme-assets bucket through
		// the server runtime registry. An unknown kind acks without
		// touching the asset pipeline.
		const db = makeDb(makeD1(DDL));
		setServerRuntime({
			run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
				Effect.runPromise(
					(effect as Effect.Effect<A, E, never>).pipe(Effect.provideService(Db, db)),
				),
			runAs: () => Promise.reject(new Error("unused")),
			themeAssets: makeBucket({}).bucket,
			audioTranscribeModel: "test-model",
			getLocale: () => "en",
		} as unknown as ServerRuntime);
		try {
			const m = msg(envelope("bogus.kind", {}));
			await handleThemeQueueBatch([m]);
			expect(m.log).toEqual(["ack"]);
		} finally {
			resetServerRuntime();
		}
	});

	it("retries when the handler throws", async () => {
		const { db, themeId, deps } = await makeDeps();
		const asset = await seedAsset(db, themeId);
		const d = {
			...deps,
			processor: fakeProcessor({
				render: async () => {
					throw new Error("wasm boom");
				},
			}),
		};
		const m = msg(
			envelope("theme.asset", {
				assetId: asset.id,
				themeId,
				kind: "favicon",
				key: "theme-assets/1/favicon/u.png",
			}),
		);
		await handleThemeQueueBatch([m], d);
		expect(m.log).toEqual(["retry"]);
	});
});

describe("makePhotonProcessor", () => {
	it("decodes real PNG bytes through the WASM processor", async () => {
		// 1x1 red PNG — proves the WASM decoder runs under vitest's node
		// runtime too (same module workerd loads via the workerd entry).
		const png = Uint8Array.from(
			atob(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			),
			(c) => c.charCodeAt(0),
		);
		const processor = makePhotonProcessor();
		const dims = await processor.decode(png);
		expect(dims).toEqual({ width: 1, height: 1 });
		const rendered = await processor.render(png, {
			name: "t",
			width: 4,
			height: 4,
			format: "png",
			square: false,
			key: "k.png",
		});
		expect(rendered.width).toBe(4);
		expect(rendered.bytes.length).toBeGreaterThan(0);
		const webp = await processor.render(png, {
			name: "t",
			width: 4,
			height: 4,
			format: "webp",
			square: false,
			key: "k.webp",
		});
		expect(webp.bytes.length).toBeGreaterThan(0);
		const color = await processor.dominantColor(png);
		expect(color).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("center-crops square variants before resizing", async () => {
		const png = PNG_1PX;
		const processor = makePhotonProcessor();
		const rendered = await processor.render(png, {
			name: "s",
			width: 8,
			height: 8,
			format: "png",
			square: true,
			key: "s.png",
		});
		expect(rendered.width).toBe(8);
		expect(rendered.bytes.length).toBeGreaterThan(0);
	});

	it("returns null dominant color when the probe yields too few pixels", async () => {
		// Force photon.resize to hand back an empty pixel buffer — the
		// px.length < 3 guard path (real WASM always returns ≥4 bytes).
		photonProbe.rawPixels = [];
		const processor = makePhotonProcessor();
		expect(await processor.dominantColor(PNG_1PX)).toBeNull();
	});

	it("returns null for undecodable bytes and null dominant on failure", async () => {
		const processor = makePhotonProcessor();
		expect(await processor.decode(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(await processor.dominantColor(new Uint8Array([1, 2, 3]))).toBeNull();
	});
});
