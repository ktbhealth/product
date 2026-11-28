import * as photon from "@cf-wasm/photon";

import * as Effect from "effect/Effect";

import { Db } from "@ktb/db";
import type { DbClient } from "@ktb/db";
import { makeJobConsumer, type JobMessageLike, type JobRegistration } from "@ktb/jobs-port";
import { readJobObject, writeJobObject, type MediaBucket } from "@ktb/media";
import { getServerRuntime, run } from "@ktb/server-fns";
import {
	BRAND_FIELD_FOR_KIND,
	THEME_ASSET_JOB_KIND,
	THEME_ASSETS_PREFIX,
	THEME_FONT_JOB_KIND,
	completeThemeAsset,
	decodeThemeAssetJob,
	decodeThemeFontJob,
	dominantColorHex,
	extOfKey,
	fontFormatForExt,
	getThemeAsset,
	googleFontsCssUrl,
	isBrandAssetKind,
	isThemeAssetKind,
	parseGoogleFontsCss,
	parseGoogleFontsCssSubsets,
	planImageVariants,
	primaryVariantName,
	setThemeBrandRef,
	suggestedSeedsFromColor,
	themeAssetUrl,
	upsertThemeFontAsset,
	type GoogleFontFace,
	type PlannedVariant,
	type ThemeAssetJobPayload,
	type ThemeAssetRow,
	type ThemeFontJobPayload,
} from "./assets.ts";
import {
	FALLBACK_FONT_METRICS,
	computeMetricOverrides,
	localFontForSlot,
	parseFontMetrics,
	type FontMetrics,
} from "./font-metrics.ts";
import { parseFontVariations } from "./font-variations.ts";
import type { ThemeFontAsset, ThemeFontFace, ThemeFontSlot } from "./types.ts";

/**
 * Theme asset queue consumer (P-082/PL-006 phase 4): the dedicated
 * ktb-theme-assets queue carries two kinds —
 *
 * - `theme.asset`: validate + decode the uploaded image, derive the
 *   variant set (favicon 16/32/180, resized logo png/webp, og-image),
 *   write derivatives to R2, record them on `theme_assets.variants`,
 *   extract a dominant color as a seed SUGGESTION (never auto-published)
 *   and point the matching `theme_definitions.brand` field at the
 *   canonical variant's serving URL.
 * - `theme.font`: self-host a font family — either the admin-uploaded
 *   file already in R2, or a Google Fonts download (every css2
 *   unicode-range subset woff2 per weight, each face stamped with its
 *   unicode-range, + a TTF metrics probe) — then write
 *   `fonts.assets[family]` with
 *   per-weight @font-face sources and a metric-matched local()
 *   fallback (size-adjust/ascent/descent/line-gap overrides).
 *
 * Image pixels are processed by @cf-wasm/photon — a Rust→WASM build
 * made for workerd (sharp is Node-only). Chosen over the Cloudflare
 * Images binding because it needs no paid add-on and runs inside the
 * existing queue consumer; the 128MB isolate cap is guarded by the
 * upload size limit + decode failure path.
 *
 * Platform bindings arrive through the @ktb/server-fns runtime registry
 * (host-resolved, incl. dev stand-ins) — this module never reads env
 * or cloudflare:* modules itself (P-033).
 */

/** Same ceiling the upload route enforces — re-checked here because
 * queue payloads are untrusted. */
export const MAX_THEME_ASSET_BYTES = 10 * 1024 * 1024;
/** Per-file cap for Google Fonts downloads (woff2 files are ~20-100KB;
 * this only guards against a hostile/garbage response). */
const MAX_FONT_FILE_BYTES = 5 * 1024 * 1024;

/** One decoded variant the processor produced. */
export interface RenderedVariant {
	readonly bytes: Uint8Array;
	readonly width: number;
	readonly height: number;
}

/**
 * Image decode/resize/dominant-color port. The production
 * implementation wraps @cf-wasm/photon (WASM); tests inject a fake.
 */
export interface ThemeImageProcessor {
	/** Pixel dimensions, or null when the bytes are not a decodable
	 * image (permanent failure — the job marks the asset failed). */
	decode(bytes: Uint8Array): Promise<{ width: number; height: number } | null>;
	/** Resize (+ optional center square-crop) and encode. Throws on
	 * processor failure → the message retries. */
	render(bytes: Uint8Array, variant: PlannedVariant): Promise<RenderedVariant>;
	/** Dominant color as "#rrggbb", or null when unavailable. */
	dominantColor(bytes: Uint8Array): Promise<string | null>;
}

export interface ThemeFontFetch {
	(
		url: string,
		init?: { headers?: Record<string, string> },
	): Promise<{
		ok: boolean;
		status: number;
		text(): Promise<string>;
		arrayBuffer(): Promise<ArrayBuffer>;
	}>;
}

export interface ThemeJobDeps {
	readonly db: DbClient;
	readonly bucket: MediaBucket | undefined;
	readonly processor: ThemeImageProcessor | undefined;
	readonly fetchImpl?: ThemeFontFetch;
}

// ---------- image processor (photon WASM) ----------

const PHOTON_FILTER = photon.SamplingFilter.Lanczos3;

const freeImage = (img: photon.PhotonImage | null | undefined): void => {
	try {
		img?.free();
	} catch {
		// wasm object already freed — ignore.
	}
};

/** Production processor backed by @cf-wasm/photon (workerd WASM). */
export const makePhotonProcessor = (): ThemeImageProcessor => ({
	decode: async (bytes) => {
		let img: photon.PhotonImage | null = null;
		try {
			img = photon.PhotonImage.new_from_byteslice(bytes);
			return { width: img.get_width(), height: img.get_height() };
		} catch {
			return null;
		} finally {
			freeImage(img);
		}
	},
	render: async (bytes, variant) => {
		let img: photon.PhotonImage | null = null;
		let cropped: photon.PhotonImage | null = null;
		try {
			img = photon.PhotonImage.new_from_byteslice(bytes);
			let source = img;
			img = null;
			if (variant.square) {
				const w = source.get_width();
				const h = source.get_height();
				const side = Math.min(w, h);
				const x = Math.floor((w - side) / 2);
				const y = Math.floor((h - side) / 2);
				cropped = photon.crop(source, x, y, x + side, y + side);
				source.free();
				source = cropped;
				cropped = null;
			}
			const resized = photon.resize(source, variant.width, variant.height, PHOTON_FILTER);
			source.free();
			const encoded = variant.format === "webp" ? resized.get_bytes_webp() : resized.get_bytes();
			resized.free();
			return { bytes: encoded, width: variant.width, height: variant.height };
		} finally {
			freeImage(img);
			freeImage(cropped);
		}
	},
	dominantColor: async (bytes) => {
		let img: photon.PhotonImage | null = null;
		let tiny: photon.PhotonImage | null = null;
		try {
			img = photon.PhotonImage.new_from_byteslice(bytes);
			tiny = photon.resize(img, 1, 1, PHOTON_FILTER);
			const px = tiny.get_raw_pixels();
			if (px.length < 3) return null;
			return dominantColorHex(px[0]!, px[1]!, px[2]!);
		} catch {
			return null;
		} finally {
			freeImage(img);
			freeImage(tiny);
		}
	},
});

// ---------- shared helpers ----------

const markFailed = async (deps: ThemeJobDeps, assetId: number, error: string): Promise<void> => {
	await completeThemeAsset(deps.db, assetId, { status: "failed", variants: { error } });
};

/** Load the asset row; "skip" = already ready (idempotent redelivery),
 * "missing" = row gone (nothing to mark — ack). */
const loadAsset = async (
	deps: ThemeJobDeps,
	assetId: number,
): Promise<ThemeAssetRow | "skip" | "missing"> => {
	const asset = await getThemeAsset(deps.db, assetId);
	if (asset === null) return "missing";
	if (asset.status === "ready") return "skip";
	return asset;
};

// ---------- theme.asset ----------

export async function processThemeAssetJob(
	payload: ThemeAssetJobPayload,
	deps: ThemeJobDeps,
): Promise<void> {
	const asset = await loadAsset(deps, payload.assetId);
	if (asset === "skip" || asset === "missing") return;
	if (!isThemeAssetKind(payload.kind) || !isBrandAssetKind(payload.kind)) {
		await markFailed(deps, payload.assetId, `kind ${payload.kind} is not an image asset`);
		return;
	}
	const kind = payload.kind;
	if (deps.bucket === undefined || deps.processor === undefined) {
		await markFailed(deps, payload.assetId, "theme asset pipeline not configured");
		return;
	}
	const read = await readJobObject(deps.bucket, payload.key, MAX_THEME_ASSET_BYTES);
	if (!read.ok) {
		await markFailed(
			deps,
			payload.assetId,
			read.reason === "missing"
				? "asset object missing from storage"
				: `asset too large (${read.size} bytes > ${MAX_THEME_ASSET_BYTES})`,
		);
		return;
	}
	const bytes = read.bytes;
	const dims = await deps.processor.decode(bytes);
	if (dims === null) {
		await markFailed(deps, payload.assetId, "undecodable image");
		return;
	}

	const planned = planImageVariants(kind, dims.width, dims.height, payload.key);
	const files: Record<string, { key: string; width: number; height: number; format: string }> = {};
	for (const variant of planned) {
		const rendered = await deps.processor.render(bytes, variant);
		await writeJobObject(deps.bucket, variant.key, rendered.bytes);
		files[`${variant.name}.${variant.format}`] = {
			key: variant.key,
			width: rendered.width,
			height: rendered.height,
			format: variant.format,
		};
	}

	// Dominant color → suggested primary seed. Stored on the asset row
	// for the admin to apply — never auto-published into theme seeds.
	const dominant = await deps.processor.dominantColor(bytes).catch(() => null);
	const variants: Record<string, unknown> = {
		files,
		source: { width: dims.width, height: dims.height },
	};
	if (dominant !== null) {
		variants.dominantColor = dominant;
		variants.suggestedSeeds = suggestedSeedsFromColor(dominant);
	}
	await completeThemeAsset(deps.db, payload.assetId, { status: "ready", variants });

	// Point the brand field at the canonical variant's serving URL.
	const primaryName = primaryVariantName(kind);
	const primary = planned.find((v) => `${v.name}.${v.format}` === primaryName);
	if (primary !== undefined && asset.themeId !== null) {
		await setThemeBrandRef(
			deps.db,
			asset.themeId,
			BRAND_FIELD_FOR_KIND[kind],
			themeAssetUrl(primary.key),
		);
	}
}

// ---------- theme.font ----------

/** Google Fonts css2: a modern UA yields woff2 URLs; an old UA yields
 * truetype — kept as a metrics fallback for fonts whose woff2 tables
 * cannot be parsed (parseFontMetrics handles woff2 via a WASM brotli
 * decoder, but returns null on unusual/corrupt containers). */
const MODERN_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LEGACY_UA = "Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1)";

const fontSlug = (family: string): string =>
	family
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "");

const fetchText = async (
	fetchImpl: ThemeFontFetch,
	url: string,
	userAgent: string,
): Promise<string | null> => {
	try {
		const res = await fetchImpl(url, { headers: { "user-agent": userAgent } });
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
};

const fetchBytes = async (
	fetchImpl: ThemeFontFetch,
	url: string,
	userAgent: string,
): Promise<Uint8Array | null> => {
	try {
		const res = await fetchImpl(url, { headers: { "user-agent": userAgent } });
		if (!res.ok) return null;
		const buf = await res.arrayBuffer();
		if (buf.byteLength === 0 || buf.byteLength > MAX_FONT_FILE_BYTES) return null;
		return new Uint8Array(buf);
	} catch {
		return null;
	}
};

/** Downloaded font file + its parsed metrics (null when the container
 * cannot be parsed — parseFontMetrics returns null for corrupt input). */
interface FontProbe {
	readonly bytes: Uint8Array;
	readonly format: string;
	readonly metrics: FontMetrics | null;
}

const probeFont = async (
	fetchImpl: ThemeFontFetch,
	face: { url: string; format: string },
	userAgent: string,
): Promise<FontProbe | null> => {
	const bytes = await fetchBytes(fetchImpl, face.url, userAgent);
	if (bytes === null) return null;
	const ext = extOfKey(face.url) || (face.format === "truetype" ? "ttf" : face.format);
	const metrics = await parseFontMetrics(bytes, ext);
	return { bytes, format: fontFormatForExt(ext) ?? face.format, metrics };
};

/** Metric-matched fallback descriptors for a probed font, or null
 * when metrics/fallback-font data is unavailable (unparseable font
 * containers, unknown system fonts) — the @font-face still emits, just
 * without overrides. */
const buildFallback = (
	family: string,
	slot: ThemeFontSlot,
	metrics: FontMetrics | null,
): ThemeFontAsset["fallback"] => {
	if (metrics === null) return null;
	const local = localFontForSlot(slot);
	const fallbackMetrics = FALLBACK_FONT_METRICS[local.toLowerCase()];
	if (fallbackMetrics === undefined) return null;
	return {
		name: `${family} fallback`,
		local,
		metrics: computeMetricOverrides(metrics, fallbackMetrics),
	};
};

export async function processThemeFontJob(
	payload: ThemeFontJobPayload,
	deps: ThemeJobDeps,
): Promise<void> {
	const asset = await loadAsset(deps, payload.assetId);
	if (asset === "skip" || asset === "missing") return;
	if (deps.bucket === undefined) {
		await markFailed(deps, payload.assetId, "theme asset storage not configured");
		return;
	}
	const fetchImpl = deps.fetchImpl ?? (fetch as unknown as ThemeFontFetch);
	const faces: ThemeFontFace[] = [];
	let metrics: FontMetrics | null = null;

	if (payload.source === "upload") {
		const read = await readJobObject(deps.bucket, payload.key, MAX_FONT_FILE_BYTES);
		if (!read.ok) {
			await markFailed(
				deps,
				payload.assetId,
				read.reason === "missing"
					? "font object missing from storage"
					: `font file too large (${read.size} bytes)`,
			);
			return;
		}
		const bytes = read.bytes;
		const ext = extOfKey(payload.key) || payload.format;
		metrics = await parseFontMetrics(bytes, ext);
		// Same probe as the catalog upload: fvar wght → ranged face,
		// other fvar axes → face.axes (present.ts turns wdth into
		// font-stretch), cmap → unicode-range download hint.
		const variation = await parseFontVariations(bytes, ext);
		faces.push({
			url: themeAssetUrl(payload.key),
			format: fontFormatForExt(ext) ?? payload.format,
			...(variation?.weightAxis === undefined
				? {}
				: { weightRange: [variation.weightAxis.min, variation.weightAxis.max] as const }),
			...(variation?.axes === undefined ? {} : { axes: variation.axes }),
			...(variation?.unicodeRange === undefined ? {} : { unicodeRange: variation.unicodeRange }),
		});
	} else {
		// Google Fonts: the modern css2 response carries one @font-face
		// per unicode-range subset per weight (latin, latin-ext,
		// cyrillic, …) — self-host EVERY subset file so non-latin
		// scripts keep coverage, stamping each face's unicode-range so
		// browsers fetch only the subsets a page uses (same delivery
		// the css2 <link> path gets). Plus one TTF probe for
		// metric-matched fallback computation.
		const css = await fetchText(
			fetchImpl,
			googleFontsCssUrl(payload.family, payload.weights),
			MODERN_UA,
		);
		if (css === null) {
			await markFailed(deps, payload.assetId, "google fonts css fetch failed");
			return;
		}
		const fontFaces = parseGoogleFontsCssSubsets(css);
		if (fontFaces.length === 0) {
			await markFailed(deps, payload.assetId, "no usable font faces in google fonts css");
			return;
		}
		const slug = fontSlug(payload.family);
		// Group by weight preserving stylesheet order (css2 emits the
		// subsets of one weight contiguously).
		const byWeight = new Map<number, GoogleFontFace[]>();
		for (const face of fontFaces) {
			const group = byWeight.get(face.weight);
			if (group === undefined) byWeight.set(face.weight, [face]);
			else group.push(face);
		}
		const usedKeys = new Set<string>();
		for (const [weight, group] of byWeight) {
			// When the stylesheet carries unicode-range descriptors,
			// ranged faces are disjoint by construction — download them
			// all and drop any unranged duplicate (it would claim full
			// coverage and shadow the subsets). Without descriptors
			// (legacy-UA shape) keep the first face per weight only.
			const ranged = group.filter((f) => f.unicodeRange !== undefined);
			const candidates = ranged.length > 0 ? ranged : group.slice(0, 1);
			const seenUrls = new Set<string>();
			for (const face of candidates) {
				if (seenUrls.has(face.url)) continue;
				seenUrls.add(face.url);
				const downloaded = await probeFont(fetchImpl, face, MODERN_UA);
				if (downloaded === null) continue;
				const ext = extOfKey(face.url) || "woff2";
				// Latin keeps the historical unsuffixed key
				// (`inter-400.woff2`); other subsets suffix the css2
				// label (`inter-400-cyrillic.woff2`). A used-key
				// collision (two faces mapping to one name) gets a
				// numeric suffix rather than overwriting.
				const subsetTag =
					face.subset === undefined || face.subset === "latin" ? "" : `-${face.subset}`;
				let key = `${THEME_ASSETS_PREFIX}${payload.themeId}/fonts/${slug}-${weight}${subsetTag}.${ext}`;
				for (let n = 2; usedKeys.has(key); n++) {
					key = `${THEME_ASSETS_PREFIX}${payload.themeId}/fonts/${slug}-${weight}${subsetTag}-${n}.${ext}`;
				}
				usedKeys.add(key);
				await writeJobObject(deps.bucket, key, downloaded.bytes);
				faces.push({
					url: themeAssetUrl(key),
					weight: face.weight,
					format: downloaded.format,
					...(face.unicodeRange === undefined ? {} : { unicodeRange: face.unicodeRange }),
				});
				// Keep the first parseable probe; the TTF fallback below
				// covers fonts whose woff2 metrics could not be extracted.
				if (metrics === null) metrics = downloaded.metrics;
			}
		}
		if (faces.length === 0) {
			await markFailed(deps, payload.assetId, "all google font downloads failed");
			return;
		}
		// Metrics probe: legacy UA → truetype URLs → parse hhea/OS-2.
		if (metrics === null) {
			const legacyCss = await fetchText(
				fetchImpl,
				googleFontsCssUrl(payload.family, [400]),
				LEGACY_UA,
			);
			const ttfFace = legacyCss === null ? undefined : parseGoogleFontsCss(legacyCss)[0];
			if (ttfFace !== undefined) {
				const ttf = await probeFont(fetchImpl, ttfFace, LEGACY_UA);
				if (ttf !== null) metrics = ttf.metrics;
			}
		}
	}

	const fontAsset: ThemeFontAsset = {
		faces,
		fallback: buildFallback(payload.family, payload.slot, metrics),
	};
	const updated = await upsertThemeFontAsset(deps.db, payload.themeId, {
		family: payload.family,
		slot: payload.slot,
		asset: fontAsset,
	});
	if (updated === null) {
		await markFailed(deps, payload.assetId, "theme not found");
		return;
	}
	await completeThemeAsset(deps.db, payload.assetId, {
		status: "ready",
		variants: {
			faces: faces.length,
			fallback: fontAsset.fallback?.name ?? null,
			metrics,
		},
	});
}

// ---------- consumer ----------

const themeAssetRegistration = (deps: ThemeJobDeps): JobRegistration => ({
	decodePayload: (payload) => decodeThemeAssetJob(payload),
	handle: (payload) => processThemeAssetJob(payload as ThemeAssetJobPayload, deps),
});

const themeFontRegistration = (deps: ThemeJobDeps): JobRegistration => ({
	decodePayload: (payload) => decodeThemeFontJob(payload),
	handle: (payload) => processThemeFontJob(payload as ThemeFontJobPayload, deps),
});

/**
 * Production deps for the consumer: the Db service inside the app
 * runtime plus the theme-assets bucket resolved through the
 * @ktb/server-fns runtime registry. Only valid inside the composed app
 * (queue consumer path).
 */
export const defaultThemeJobDeps = async (): Promise<ThemeJobDeps> => {
	const runtime = getServerRuntime();
	const db = await run(
		Effect.gen(function* () {
			return yield* Db;
		}),
	);
	return {
		db,
		bucket: runtime.themeAssets as unknown as MediaBucket | undefined,
		processor: makePhotonProcessor(),
	};
};

/** Queue batch handler for the theme-asset consumer — invoked from the
 * worker's `queue` export (server.ts partitions batches by envelope
 * kind, not queue name) and from the dev:node local queue. Malformed messages
 * are acked (poison), valid jobs that throw unexpectedly are retried,
 * and every delivery updates the `job_runs` projection when a DbClient
 * is bound. */
export async function handleThemeQueueBatch(
	messages: readonly JobMessageLike[],
	deps?: ThemeJobDeps,
): Promise<void> {
	const resolved = deps ?? (await defaultThemeJobDeps());
	const consumer = makeJobConsumer({
		handlers: {
			[THEME_ASSET_JOB_KIND]: themeAssetRegistration(resolved),
			[THEME_FONT_JOB_KIND]: themeFontRegistration(resolved),
		},
		db: resolved.db,
	});
	await consumer(messages);
}
