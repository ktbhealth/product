import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
	bestEffortDelete,
	CatalogFontVariantsSchema,
	catalogFontAssetOf,
	catalogFontFamilyOf,
	catalogFontInfoOf,
	catalogFontSubsetKeysOf,
	checkUpload,
	contentTypeForKey,
	extOfKey,
	fileExtension,
	fontAxisRangeOf,
	fontWeightListOf,
	mimeBase,
	mimeForExtension,
	multipartFile,
	normalizeFontAxes,
	objectBytes,
	putStoredObject,
	readJobObject,
	serveStoredObject,
	storedObjectKey,
	writeJobObject,
	type MediaBucket,
	type StoredObject,
} from "./index.ts";

const bytes = (n: number): Uint8Array => new Uint8Array(n);

const stored = (over: Partial<StoredObject> = {}): StoredObject => ({
	body: new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(3));
			controller.close();
		},
	}),
	size: 3,
	...over,
});

describe("checkUpload", () => {
	const policy = {
		maxBytes: 2 * 1024 * 1024,
		extensions: ["png", "woff2"],
		mimePrefixes: ["image/", "font/"],
	};

	it("accepts a valid file and normalizes mime/ext", () => {
		const result = checkUpload(
			{ bytes: bytes(4), fileName: "Logo.PNG", mime: "Image/PNG; charset=binary" },
			policy,
		);
		expect(result).toEqual({ ok: true, bytes: bytes(4), ext: "png", mime: "image/png" });
	});

	it("rejects empty, oversize, bad ext and bad mime in order", () => {
		expect(checkUpload({ bytes: bytes(0), fileName: "a.png", mime: "image/png" }, policy)).toEqual({
			ok: false,
			status: 400,
			error: "empty file",
		});
		expect(
			checkUpload(
				{ bytes: bytes(2 * 1024 * 1024 + 1), fileName: "a.png", mime: "image/png" },
				policy,
			),
		).toEqual({ ok: false, status: 413, error: "file too large (max 2MB)" });
		// Fractional MB limit renders one decimal.
		expect(
			checkUpload(
				{ bytes: bytes(1024 * 1024 * 2), fileName: "a.png", mime: "image/png" },
				{ ...policy, maxBytes: 1024 * 1024 * 1.5 },
			),
		).toEqual({ ok: false, status: 413, error: "file too large (max 1.5MB)" });
		expect(checkUpload({ bytes: bytes(4), fileName: "a.svg", mime: "image/png" }, policy)).toEqual({
			ok: false,
			status: 415,
			error: "unsupported file type",
		});
		// fileName "" falls back to the "upload" placeholder → unknown ext.
		expect(
			checkUpload({ bytes: bytes(4), fileName: "", mime: "image/png" }, policy),
		).toEqual({ ok: false, status: 415, error: "unsupported file type" });
		expect(checkUpload({ bytes: bytes(4), fileName: "a.png", mime: "text/html" }, policy)).toEqual({
			ok: false,
			status: 415,
			error: "unsupported content type",
		});
	});

	it("passes octet-stream/empty mime through the extension gate", () => {
		for (const mime of ["application/octet-stream", ""]) {
			const result = checkUpload({ bytes: bytes(4), fileName: "a.png", mime }, policy);
			expect(result.ok).toBe(true);
		}
	});

	it("checkUpload without mimePrefixes skips the mime gate; ArrayBuffer bytes normalize", () => {
		const noMimePolicy = { maxBytes: 1024, extensions: ["png"] };
		const result = checkUpload(
			{ bytes: bytes(4).buffer as ArrayBuffer, fileName: "a.png", mime: "text/html" },
			noMimePolicy,
		);
		expect(result).toEqual({ ok: true, bytes: bytes(4), ext: "png", mime: "text/html" });
	});

	it("checkUpload deny rules match on extensions alone", () => {
		const extPolicy = {
			...policy,
			deny: [{ extensions: ["png"], error: "png denied" }],
		};
		expect(
			checkUpload({ bytes: bytes(4), fileName: "a.png", mime: "image/png" }, extPolicy),
		).toEqual({ ok: false, status: 415, error: "png denied" });
		expect(
			checkUpload({ bytes: bytes(4), fileName: "a.woff2", mime: "font/woff2" }, extPolicy).ok,
		).toBe(true);
	});

	it("applies deny rules after the allowlist", () => {
		const svgPolicy = {
			...policy,
			deny: [{ mimes: ["image/svg+xml"], error: "svg uploads are not supported" }],
		};
		expect(
			checkUpload({ bytes: bytes(4), fileName: "a.png", mime: "image/svg+xml" }, svgPolicy),
		).toEqual({ ok: false, status: 415, error: "svg uploads are not supported" });
		expect(
			checkUpload({ bytes: bytes(4), fileName: "a.png", mime: "image/png" }, svgPolicy).ok,
		).toBe(true);
	});
});

describe("form/file helpers", () => {
	it("fileExtension/mimeBase/multipartFile", () => {
		expect(fileExtension("a.tar.GZ")).toBe("gz");
		expect(fileExtension("noext")).toBe("");
		expect(mimeBase(" Text/HTML ; charset=utf-8 ")).toBe("text/html");
		const form = new FormData();
		form.set("file", new File(["ab"], "a.png", { type: "image/png" }));
		form.set("text", "plain");
		expect(multipartFile(form, "file")?.name).toBe("a.png");
		expect(multipartFile(form, "text")).toBeNull();
		expect(multipartFile(form, "missing")).toBeNull();
	});
});

describe("store helpers", () => {
	it("storedObjectKey joins prefix/parts/uuid/ext", () => {
		const key = storedObjectKey("theme-assets/", [12, "logo-light"], "png");
		expect(key).toMatch(/^theme-assets\/12\/logo-light\/[0-9a-f-]{36}\.png$/);
		expect(storedObjectKey("images", [], "webp")).toMatch(/^images\/[0-9a-f-]{36}\.webp$/);
	});

	it("extOfKey/contentTypeForKey/mimeForExtension", () => {
		expect(extOfKey("a/b/c.WEBP?x=1")).toBe("webp");
		expect(extOfKey("noext")).toBe("");
		expect(contentTypeForKey("x/font.woff2")).toBe("font/woff2");
		expect(contentTypeForKey("x/nope.bin")).toBe("application/octet-stream");
		expect(contentTypeForKey("x/a.png", { png: "image/x-png" })).toBe("image/x-png");
		expect(mimeForExtension("avif")).toBe("image/avif");
		expect(mimeForExtension("zzz")).toBe("application/octet-stream");
	});

	it("objectBytes prefers arrayBuffer, falls back to the stream", async () => {
		const withBuffer = stored({ arrayBuffer: async () => bytes(5).buffer as ArrayBuffer });
		expect(await objectBytes(withBuffer)).toEqual(bytes(5));
		expect(await objectBytes(stored())).toEqual(bytes(3));
	});

	it("objectBytes skips undefined stream chunks", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(undefined as unknown as Uint8Array);
				controller.enqueue(new Uint8Array(3));
				controller.close();
			},
		});
		expect(await objectBytes(stored({ body: stream }))).toEqual(bytes(3));
	});

	it("putStoredObject writes with the key-derived content type", async () => {
		const calls: { key: string; options?: unknown }[] = [];
		const bucket: MediaBucket = {
			get: async () => null,
			put: async (key, _value, options) => {
				calls.push({ key, options });
			},
			delete: async () => {},
		};
		await putStoredObject(bucket, "a/b.woff2", bytes(1));
		await putStoredObject(bucket, "a/b.png", bytes(1), "image/x-custom");
		expect(calls[0]).toEqual({
			key: "a/b.woff2",
			options: { httpMetadata: { contentType: "font/woff2" } },
		});
		expect(calls[1]).toEqual({
			key: "a/b.png",
			options: { httpMetadata: { contentType: "image/x-custom" } },
		});
	});

	it("bestEffortDelete swallows failures and skips empty lists", async () => {
		let deleted: string[] = [];
		const ok: MediaBucket = {
			get: async () => null,
			put: async () => {},
			delete: async (keys) => {
				deleted = [...keys];
			},
		};
		await bestEffortDelete(ok, ["a", "b"]);
		expect(deleted).toEqual(["a", "b"]);
		const bad: MediaBucket = {
			get: async () => null,
			put: async () => {},
			delete: async () => {
				throw new Error("boom");
			},
		};
		let seen: unknown;
		await bestEffortDelete(bad, ["a"], (e) => {
			seen = e;
		});
		expect(seen).toBeInstanceOf(Error);
		await bestEffortDelete(ok, []);
	});

	it("serveStoredObject streams with stored/fallback content type", async () => {
		const object = stored({
			httpMetadata: { contentType: "image/webp" },
		});
		const res = serveStoredObject(object, {
			contentType: "image/png",
			cacheControl: "public, max-age=31536000, immutable",
			headers: { "content-disposition": "inline" },
		});
		expect(res.headers.get("content-type")).toBe("image/webp");
		expect(res.headers.get("content-length")).toBe("3");
		expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(res.headers.get("content-disposition")).toBe("inline");
		const fallback = serveStoredObject(stored(), { contentType: "image/png" });
		expect(fallback.headers.get("content-type")).toBe("image/png");
		const bare = serveStoredObject(stored());
		expect(bare.headers.get("content-type")).toBe("application/octet-stream");
		expect(bare.headers.get("cache-control")).toBeNull();
	});
});

describe("job object IO", () => {
	const bucketWith = (object: StoredObject | null): MediaBucket => ({
		get: async () => object,
		put: async () => {},
		delete: async () => {},
	});

	it("readJobObject returns missing/too-large/ok", async () => {
		const missing = await readJobObject(bucketWith(null), "k", 10);
		expect(missing).toEqual({ ok: false, reason: "missing" });
		const big = stored({ size: 11, arrayBuffer: async () => bytes(11).buffer as ArrayBuffer });
		expect(await readJobObject(bucketWith(big), "k", 10)).toEqual({
			ok: false,
			reason: "too-large",
			size: 11,
		});
		const ok = stored({ size: 4, arrayBuffer: async () => bytes(4).buffer as ArrayBuffer });
		expect(await readJobObject(bucketWith(ok), "k", 10)).toEqual({
			ok: true,
			bytes: bytes(4),
			size: 4,
		});
	});

	it("writeJobObject puts bytes with the derived content type", async () => {
		let putArgs: unknown[] = [];
		const bucket: MediaBucket = {
			get: async () => null,
			put: async (...args) => {
				putArgs = args;
			},
			delete: async () => {},
		};
		await writeJobObject(bucket, "d/logo.webp", bytes(2));
		expect(putArgs[0]).toBe("d/logo.webp");
		expect(putArgs[2]).toEqual({ httpMetadata: { contentType: "image/webp" } });
	});
});

describe("normalizeFontAxes", () => {
	it("validates, dedupes, drops wght and caps", () => {
		const axes = normalizeFontAxes([
			{ tag: "wdth", min: 50, default: 100, max: 200 },
			{ tag: "wght", min: 1, default: 2, max: 3 },
			{ tag: "wdth", min: 1, default: 1, max: 2 }, // dup tag — first wins
			{ tag: "bad", min: 5, default: 1, max: 2 }, // min > default
			{ tag: "opsz", min: Number.NaN, default: 1, max: 2 },
			"junk",
		]);
		expect(axes).toEqual([{ tag: "wdth", min: 50, default: 100, max: 200 }]);
		expect(normalizeFontAxes("nope")).toEqual([]);
		const many = Array.from({ length: 40 }, (_, i) => ({
			tag: `a${String(i).padStart(3, "0")}`,
			min: 0,
			default: 0,
			max: 1,
		}));
		expect(normalizeFontAxes(many)).toHaveLength(32);
	});
});

describe("catalog font variants contract", () => {
	const variantsJson = JSON.stringify({
		family: "Inter",
		weights: [400, 700],
		variable: true,
		weightAxis: { min: 100, default: 400, max: 900 },
		axes: [{ tag: "wdth", min: 50, default: 100, max: 200 }],
		unicodeRange: "U+0020-007E",
		subsetKeys: ["k1", "k2"],
		fontAsset: {
			faces: [
				{ url: "/u", weight: 400, unicodeRange: "U+0020-007E" },
				{ url: "/v", weightRange: [100, 900] },
				{ noUrl: true },
			],
			fallback: null,
		},
	});

	it("catalogFontFamilyOf reads the family", () => {
		expect(catalogFontFamilyOf(variantsJson)).toBe("Inter");
		expect(catalogFontFamilyOf("{bad")).toBeNull();
		expect(catalogFontFamilyOf(null)).toBeNull();
		expect(catalogFontFamilyOf(JSON.stringify({ family: "  " }))).toBeNull();
	});

	it("catalogFontSubsetKeysOf reads subsetKeys + legacy subsetKey", () => {
		expect(catalogFontSubsetKeysOf(variantsJson)).toEqual(["k1", "k2"]);
		expect(
			catalogFontSubsetKeysOf(JSON.stringify({ subsetKey: "old", subsetKeys: ["new", "old"] })),
		).toEqual(["new", "old"]);
		// Legacy subsetKey duplicating a subsetKeys entry dedupes too.
		expect(
			catalogFontSubsetKeysOf(JSON.stringify({ subsetKey: "k1", subsetKeys: ["k1", 7, ""] })),
		).toEqual(["k1"]);
		// subsetKey alone (no subsetKeys array) still surfaces.
		expect(catalogFontSubsetKeysOf(JSON.stringify({ subsetKey: "solo" }))).toEqual(["solo"]);
		expect(catalogFontSubsetKeysOf("{bad")).toEqual([]);
		expect(catalogFontSubsetKeysOf(null)).toEqual([]);
	});

	it("catalogFontAssetOf returns a normalized manifest", () => {
		const asset = catalogFontAssetOf(variantsJson);
		expect(asset?.faces).toHaveLength(2);
		expect(asset?.faces[0]).toMatchObject({ url: "/u", weight: 400 });
		expect(asset?.faces[1]?.weightRange).toEqual([100, 900]);
		expect(asset?.fallback).toBeNull();
		// Face-level tolerant reads: non-finite weight/weightRange parts
		// and empty format are dropped field-by-field.
		const edge = catalogFontAssetOf(
			JSON.stringify({
				fontAsset: {
					faces: [
						{ url: "/w", weight: Number.NaN },
						{ url: "/r", weightRange: [100, "x"] },
						{ url: "/f", format: "", axes: [] },
						{ url: "" },
						{ url: "/s", weight: "700", weightRange: "bad" },
						{ url: "/t", weightRange: [100] },
						{ url: "/a", format: "woff2", axes: [{ tag: "wdth", min: 50, default: 100, max: 200 }] },
						null,
						"junk",
					],
				},
			}),
		);
		expect(edge?.faces).toHaveLength(6);
		expect(edge?.faces[0]).toEqual({ url: "/w" });
		expect(edge?.faces[1]).toEqual({ url: "/r" });
		expect(edge?.faces[2]).toEqual({ url: "/f" });
		expect(edge?.faces[3]).toEqual({ url: "/s" });
		expect(edge?.faces[4]).toEqual({ url: "/t" });
		expect(edge?.faces[5]).toMatchObject({
			url: "/a",
			format: "woff2",
			axes: [{ tag: "wdth", min: 50, default: 100, max: 200 }],
		});
		expect(catalogFontAssetOf(JSON.stringify({ fontAsset: { faces: "x" } }))).toBeNull();
		expect(catalogFontAssetOf(JSON.stringify({ fontAsset: null }))).toBeNull();
		expect(catalogFontAssetOf("{bad")).toBeNull();
	});

	it("catalogFontInfoOf falls back to per-face weights and tolerates minimal variants", () => {
		// faces carry weights, no explicit weights/axis → faceWeightsOf path.
		const faceWeighted = catalogFontInfoOf(
			JSON.stringify({
				family: "F",
				fontAsset: { faces: [{ url: "/a", weight: 300 }, { url: "/b", weight: 600 }] },
			}),
		);
		expect(faceWeighted?.weights).toEqual([300, 600]);
		expect(faceWeighted?.variable).toBeUndefined();
		// Minimal variant — every optional spread takes the empty side.
		const minimal = catalogFontInfoOf(JSON.stringify({ family: "M" }));
		expect(minimal).toEqual({ family: "M" });
		// fontAsset.faces not an array → faceWeightsOf undefined branch.
		const badFaces = catalogFontInfoOf(
			JSON.stringify({ family: "B", fontAsset: { faces: "nope" } }),
		);
		expect(badFaces?.weights).toBeUndefined();
	});

	it("catalogFontAssetOf keeps a fallback only with complete finite metrics", () => {
		const withFallback = catalogFontAssetOf(
			JSON.stringify({
				fontAsset: {
					faces: [],
					fallback: {
						name: "Arial",
						local: "Arial Local",
						metrics: {
							sizeAdjust: 105,
							ascentOverride: 90,
							descentOverride: 20,
							lineGapOverride: 0,
						},
					},
				},
			}),
		);
		expect(withFallback?.fallback).toEqual({
			name: "Arial",
			local: "Arial Local",
			metrics: { sizeAdjust: 105, ascentOverride: 90, descentOverride: 20, lineGapOverride: 0 },
		});
		// Incomplete metrics → fallback dropped, manifest survives.
		const partial = catalogFontAssetOf(
			JSON.stringify({
				fontAsset: {
					faces: [{ url: "/u" }],
					fallback: { name: "A", local: "B", metrics: { sizeAdjust: 105 } },
				},
			}),
		);
		expect(partial?.fallback).toBeNull();
		expect(partial?.faces).toHaveLength(1);
		// Non-finite metric → dropped too.
		const nan = catalogFontAssetOf(
			JSON.stringify({
				fontAsset: {
					faces: [],
					fallback: {
						name: "A",
						local: "B",
						metrics: { sizeAdjust: "x", ascentOverride: 1, descentOverride: 1, lineGapOverride: 1 },
					},
				},
			}),
		);
		expect(nan?.fallback).toBeNull();
	});

	it("catalogFontInfoOf resolves weights/variable/axes like the adapter", () => {
		const info = catalogFontInfoOf(variantsJson);
		expect(info).toEqual({
			family: "Inter",
			weights: [400, 700],
			variable: true,
			weightAxis: { min: 100, default: 400, max: 900 },
			axes: [{ tag: "wdth", min: 50, default: 100, max: 200 }],
			unicodeRange: "U+0020-007E",
		});
		// Variable font without explicit weights → axis endpoints.
		const variableOnly = catalogFontInfoOf(
			JSON.stringify({ family: "V", weightAxis: { min: 100, default: 400, max: 900 } }),
		);
		expect(variableOnly?.weights).toEqual([100, 900]);
		expect(variableOnly?.variable).toBe(true);
		// Pre-weights rows fall back to per-face weights.
		const legacy = catalogFontInfoOf(
			JSON.stringify({
				family: "L",
				fontAsset: {
					faces: [
						{ url: "/a", weight: 300 },
						{ url: "/b", weight: 700 },
					],
				},
			}),
		);
		expect(legacy?.weights).toEqual([300, 700]);
		expect(legacy?.variable).toBeUndefined();
		// No family → not a catalog row.
		expect(catalogFontInfoOf(JSON.stringify({ weights: [400] }))).toBeNull();
		expect(catalogFontInfoOf("{bad")).toBeNull();
		expect(catalogFontInfoOf(null)).toBeNull();
	});

	it("fontAxisRangeOf/fontWeightListOf tolerate malformed input", () => {
		expect(fontAxisRangeOf({ min: 1, default: 2, max: 3 })).toEqual({
			min: 1,
			default: 2,
			max: 3,
		});
		expect(fontAxisRangeOf({ min: 3, default: 2, max: 1 })).toBeUndefined();
		expect(fontAxisRangeOf("x")).toBeUndefined();
		expect(fontWeightListOf([700, 400, 400, "x", 4.5])).toEqual([400, 700]);
		expect(fontWeightListOf([])).toBeUndefined();
		expect(fontWeightListOf("x")).toBeUndefined();
	});

	it("written variants round-trip through the canonical schema", () => {
		const written = {
			family: "Inter",
			weights: [400],
			fontAsset: { faces: [{ url: "/u", weight: 400 }], fallback: null },
		};
		const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(CatalogFontVariantsSchema))(
			JSON.stringify(written),
		);
		expect(decoded.family).toBe("Inter");
		expect(decoded.fontAsset?.faces[0]?.weight).toBe(400);
	});
});
