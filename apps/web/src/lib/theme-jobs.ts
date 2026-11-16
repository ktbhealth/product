import * as photon from "@cf-wasm/photon";

import type { DbClient } from "@ktb/db";
import { makeJobConsumer, type JobMessageLike, type JobRegistration } from "@ktb/jobs-port";
import {
	BRAND_FIELD_FOR_KIND,
	THEME_ASSET_JOB_KIND,
	THEME_ASSETS_PREFIX,
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
	isBrandAssetKind,
	isThemeAssetKind,
	parseGoogleFontsCss,
	planImageVariants,
	primaryVariantName,
	setThemeBrandRef,
	suggestedSeedsFromColor,
	themeAssetUrl,
	upsertThemeFontAsset,
	type PlannedVariant,
	type ThemeAssetJobPayload,
	type ThemeAssetRow,
	type ThemeFontJobPayload,
} from "@ktb/theme/assets";
import {
	FALLBACK_FONT_METRICS,
	computeMetricOverrides,
	localFontForSlot,
	parseFontMetrics,
	type FontMetrics,
} from "@ktb/theme/font-metrics";
import type { ThemeFontAsset, ThemeFontFace, ThemeFontSlot } from "@ktb/theme/types";

import { db, themeAssetsBucket } from "#/lib/platform.ts";

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
 *   file already in R2, or a Google Fonts download (woff2 per weight +
 *   a TTF metrics probe) — then write `fonts.assets[family]` with
 *   per-weight @font-face sources and a metric-matched local()
 *   fallback (size-adjust/ascent/descent/line-gap overrides).
 *
 * Image pixels are processed by @cf-wasm/photon — a Rust→WASM build
 * made for workerd (sharp is Node-only). Chosen over the Cloudflare
 * Images binding because it needs no paid add-on and runs inside the
 * existing queue consumer; the 128MB isolate cap is guarded by the
 * upload size limit + decode failure path.
 */

/** Same ceiling the upload route enforces — re-checked here because
 * queue payloads are untrusted. */
export const MAX_THEME_ASSET_BYTES = 10 * 1024 * 1024;
/** Per-file cap for Google Fonts downloads (woff2 files are ~20-100KB;
 * this only guards against a hostile/garbage response). */
const MAX_FONT_FILE_BYTES = 5 * 1024 * 1024;

/** Minimal R2 surface the consumer needs. */
interface ThemeAssetBucketLike {
	get(key: string): Promise<{
		readonly size: number;
		arrayBuffer(): Promise<ArrayBuffer>;
	} | null>;
	put(
		key: string,
		value: Uint8Array,
		options?: { readonly httpMetadata?: { readonly contentType?: string } },
	): Promise<unknown>;
}

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
	readonly bucket: ThemeAssetBucketLike | undefined;
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
	const object = await deps.bucket.get(payload.key);
	if (object === null) {
		await markFailed(deps, payload.assetId, "asset object missing from storage");
		return;
	}
	if (object.size > MAX_THEME_ASSET_BYTES) {
		await markFailed(
			deps,
			payload.assetId,
			`asset too large (${object.size} bytes > ${MAX_THEME_ASSET_BYTES})`,
		);
		return;
	}
	const bytes = new Uint8Array(await object.arrayBuffer());
	const dims = await deps.processor.decode(bytes);
	if (dims === null) {
		await markFailed(deps, payload.assetId, "undecodable image");
		return;
	}

	const planned = planImageVariants(kind, dims.width, dims.height, payload.key);
	const files: Record<string, { key: string; width: number; height: number; format: string }> = {};
	for (const variant of planned) {
		const rendered = await deps.processor.render(bytes, variant);
		await deps.bucket.put(variant.key, rendered.bytes, {
			httpMetadata: { contentType: contentTypeForKey(variant.key) },
		});
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
 * truetype — used once per job as the metrics probe (woff2 is brotli
 * and cannot be parsed for hhea/OS-2 metrics in workerd). */
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

/** Downloaded font file + its parsed metrics (null for woff2 — brotli
 * metrics extraction is a documented TODO). */
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
 * when metrics/fallback-font data is unavailable (woff2 uploads, unknown
 * system fonts) — the @font-face still emits, just without overrides. */
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
		const object = await deps.bucket.get(payload.key);
		if (object === null) {
			await markFailed(deps, payload.assetId, "font object missing from storage");
			return;
		}
		if (object.size > MAX_FONT_FILE_BYTES) {
			await markFailed(deps, payload.assetId, `font file too large (${object.size} bytes)`);
			return;
		}
		const bytes = new Uint8Array(await object.arrayBuffer());
		const ext = extOfKey(payload.key) || payload.format;
		metrics = await parseFontMetrics(bytes, ext);
		faces.push({
			url: themeAssetUrl(payload.key),
			format: fontFormatForExt(ext) ?? payload.format,
		});
	} else {
		// Google Fonts: woff2 per configured weight (latin subset) + one
		// TTF probe for metric-matched fallback computation.
		const css = await fetchText(
			fetchImpl,
			googleFontsCssUrl(payload.family, payload.weights),
			MODERN_UA,
		);
		if (css === null) {
			await markFailed(deps, payload.assetId, "google fonts css fetch failed");
			return;
		}
		const fontFaces = parseGoogleFontsCss(css);
		if (fontFaces.length === 0) {
			await markFailed(deps, payload.assetId, "no usable font faces in google fonts css");
			return;
		}
		const slug = fontSlug(payload.family);
		for (const face of fontFaces) {
			const downloaded = await probeFont(fetchImpl, face, MODERN_UA);
			if (downloaded === null) continue;
			const ext = extOfKey(face.url) || "woff2";
			const key = `${THEME_ASSETS_PREFIX}${payload.themeId}/fonts/${slug}-${face.weight}.${ext}`;
			await deps.bucket.put(key, downloaded.bytes, {
				httpMetadata: { contentType: contentTypeForKey(key) },
			});
			faces.push({
				url: themeAssetUrl(key),
				weight: face.weight,
				format: downloaded.format,
			});
			// woff2 metrics are unparseable (brotli) — keep the first
			// parseable probe; the TTF fallback below covers the rest.
			if (metrics === null) metrics = downloaded.metrics;
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

const platformDeps = (): ThemeJobDeps => ({
	db,
	bucket: themeAssetsBucket as unknown as ThemeAssetBucketLike | undefined,
	processor: makePhotonProcessor(),
});

/** Queue batch handler for the dedicated ktb-theme-assets consumer —
 * invoked from the worker's `queue` export (server.ts dispatches on
 * batch.queue) and from the dev:node local queue. */
export async function handleThemeQueueBatch(
	messages: readonly JobMessageLike[],
	deps: ThemeJobDeps = platformDeps(),
): Promise<void> {
	const consumer = makeJobConsumer({
		handlers: {
			[THEME_ASSET_JOB_KIND]: themeAssetRegistration(deps),
			[THEME_FONT_JOB_KIND]: themeFontRegistration(deps),
		},
		db: deps.db,
	});
	await consumer(messages);
}
