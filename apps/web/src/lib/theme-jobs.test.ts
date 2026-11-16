import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { themeAssets, themeDefinitions } from "@ktb/db/schema";
import type { JobMessageLike } from "@ktb/jobs-port";
import { insertThemeAsset } from "@ktb/theme/assets";

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
} from "./theme-jobs.ts";

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
	version integer DEFAULT 1 NOT NULL,
	created_at integer NOT NULL,
	updated_at integer
);
CREATE TABLE job_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', payload_ref TEXT, error TEXT, tenant_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO theme_definitions (scope, scope_id, seeds, tokens, created_at)
	VALUES ('platform', '', '{}', '{}', 0);
`;

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

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

	it("returns null for undecodable bytes and null dominant on failure", async () => {
		const processor = makePhotonProcessor();
		expect(await processor.decode(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(await processor.dominantColor(new Uint8Array([1, 2, 3]))).toBeNull();
	});
});
