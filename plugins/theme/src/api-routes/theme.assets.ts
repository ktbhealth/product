import { Effect } from "effect";

import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";
import { createPluginApiRoute, getDoctorUser, getServerRuntime, runAs } from "@ktb/server-fns";

import {
	FONT_UPLOAD_EXTENSIONS,
	IMAGE_UPLOAD_EXTENSIONS,
	THEME_ASSET_JOB_KIND,
	THEME_ASSETS_PREFIX,
	THEME_FONT_JOB_KIND,
	contentTypeForKey,
	decodeThemeAssetJob,
	decodeThemeFontJob,
	insertThemeAsset,
	isThemeAssetKind,
} from "../assets.ts";
import { getThemeById } from "../theme.ts";
import type { ThemeAssetKind, ThemeFontSlot } from "../types.ts";

/**
 * /api/theme/assets — Phase 4 upload + serving route (P-082/PL-006).
 *
 * POST (multipart): `file` + `themeId` + `kind` (+ `family`/`slot` for
 * kind=font). PlatformAdmin only — same gate as theme writes. Stores
 * the original in THEME_ASSETS_BUCKET, records a pending
 * `theme_assets` row and enqueues a `theme.asset`/`theme.font` job on
 * the dedicated ktb-theme-assets queue; derivatives land asynchronously.
 *
 * GET ?key=<r2key>: streams a stored object back — public (brand assets
 * are public branding), restricted to the theme-assets/ prefix, never a
 * bucket URL. Cache-friendly: keys are content-unique (uuid).
 *
 * The route module lives in this package and is mounted into the host's
 * virtual route tree by `themeRoutesPlugin`
 * (physical("/api", "src/api-routes")); the session/runtime boundary is
 * @ktb/server-fns — the bucket and queue arrive through the runtime
 * registry (P-033).
 */

/** Bound worker memory: originals are buffered fully before the R2 put.
 * 10MB covers print-grade logos; WASM decode happens in the queue. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const FONT_SLOTS: readonly ThemeFontSlot[] = ["sans", "heading", "mono"];

const isAdmin = (user: { id: string; email?: string }) =>
	runAs(
		user,
		Effect.gen(function* () {
			const gate = yield* PlatformAdmin;
			return yield* gate.isAdmin(user.email);
		}),
	).catch(() => false);

/** Theme row must exist before an asset links to it. */
const themeExists = (user: { id: string }, themeId: number) =>
	runAs(
		user,
		Effect.gen(function* () {
			const db = yield* Db;
			return (yield* Effect.promise(() => getThemeById(db, themeId))) !== null;
		}),
	).catch(() => false);

const insertAsset = (
	user: { id: string },
	input: { themeId: number; kind: ThemeAssetKind; r2Key: string | null },
) =>
	runAs(
		user,
		Effect.gen(function* () {
			const db = yield* Db;
			return yield* Effect.promise(() => insertThemeAsset(db, input));
		}),
	);

const extAllowed = (ext: string, kind: ThemeAssetKind): boolean =>
	kind === "font"
		? (FONT_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)
		: (IMAGE_UPLOAD_EXTENSIONS as readonly string[]).includes(ext);

export const Route = createPluginApiRoute("theme.routes")("/api/theme/assets")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const user = await getDoctorUser();
				if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
				if (!(await isAdmin(user))) return Response.json({ error: "forbidden" }, { status: 403 });

				const contentType = request.headers.get("content-type") ?? "";
				if (!contentType.startsWith("multipart/form-data")) {
					return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
				}
				const form = await request.formData();
				const file = form.get("file");
				const themeId = Number(form.get("themeId"));
				const kindRaw = String(form.get("kind") ?? "");
				if (!(file instanceof File)) {
					return Response.json({ error: "missing file" }, { status: 400 });
				}
				if (!Number.isInteger(themeId) || themeId <= 0) {
					return Response.json({ error: "invalid themeId" }, { status: 400 });
				}
				if (!isThemeAssetKind(kindRaw)) {
					return Response.json({ error: "invalid kind" }, { status: 400 });
				}
				const kind = kindRaw;
				if (!(await themeExists(user, themeId))) {
					return Response.json({ error: "theme not found" }, { status: 404 });
				}

				const bytes = await file.arrayBuffer();
				if (bytes.byteLength === 0) {
					return Response.json({ error: "empty file" }, { status: 400 });
				}
				if (bytes.byteLength > MAX_UPLOAD_BYTES) {
					return Response.json({ error: "file too large (max 10MB)" }, { status: 413 });
				}
				// The multipart parser always supplies a content type.
				/* v8 ignore next -- parsed File.type is never empty */
				const mime = (file.type || "").split(";")[0]!.trim().toLowerCase();
				// FormData turns an empty filename into a plain field, so a
				// parsed File always carries a non-empty name here.
				/* v8 ignore next -- unreachable via multipart */
				const name = file.name || "upload";
				const dot = name.lastIndexOf(".");
				const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
				if (!extAllowed(ext, kind)) {
					return Response.json({ error: "unsupported file type" }, { status: 415 });
				}
				// Cross-check the declared MIME against the extension —
				// octet-stream uploads are allowed (extension is the gate).
				if (
					mime !== "" &&
					mime !== "application/octet-stream" &&
					kind === "font" &&
					!mime.startsWith("font/")
				) {
					return Response.json({ error: "unsupported content type" }, { status: 415 });
				}
				if (
					mime !== "" &&
					mime !== "application/octet-stream" &&
					kind !== "font" &&
					!mime.startsWith("image/")
				) {
					return Response.json({ error: "unsupported content type" }, { status: 415 });
				}

				const { themeAssets: bucket, themeJobs } = getServerRuntime();
				if (!bucket || !themeJobs) {
					return Response.json({ error: "theme asset storage not configured" }, { status: 503 });
				}

				const key = `${THEME_ASSETS_PREFIX}${themeId}/${kind}/${crypto.randomUUID()}.${ext}`;
				await bucket.put(key, bytes, {
					httpMetadata: { contentType: contentTypeForKey(key) },
				});

				const asset = await insertAsset(user, { themeId, kind, r2Key: key });
				if (asset === null) {
					return Response.json({ error: "failed to record asset" }, { status: 500 });
				}

				try {
					if (kind === "font") {
						const family = String(form.get("family") ?? "").trim();
						const slotRaw = String(form.get("slot") ?? "sans");
						const slot = (FONT_SLOTS as readonly string[]).includes(slotRaw)
							? (slotRaw as ThemeFontSlot)
							: "sans";
						if (family === "") {
							return Response.json({ error: "font family required" }, { status: 400 });
						}
						// Payload shape is validated again at the consumer —
						// decode here so a malformed enqueue never happens.
						const payload = decodeThemeFontJob({
							assetId: asset.id,
							themeId,
							family,
							slot,
							source: "upload",
							key,
							format: ext,
						});
						await themeJobs.enqueue(THEME_FONT_JOB_KIND, payload, {
							payloadRef: `theme-asset:${asset.id}`,
						});
					} else {
						const payload = decodeThemeAssetJob({
							assetId: asset.id,
							themeId,
							kind,
							key,
						});
						await themeJobs.enqueue(THEME_ASSET_JOB_KIND, payload, {
							payloadRef: `theme-asset:${asset.id}`,
						});
					}
				} catch {
					return Response.json(
						{ error: "asset stored but processing queue unavailable" },
						{ status: 502 },
					);
				}

				return Response.json({ ok: true, assetId: asset.id, status: "queued" });
			},
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const key = url.searchParams.get("key") ?? "";
				if (!key.startsWith(THEME_ASSETS_PREFIX) || key.includes("..") || key.includes("\0")) {
					return Response.json({ error: "not found" }, { status: 404 });
				}
				const { themeAssets: bucket } = getServerRuntime();
				if (!bucket) {
					return Response.json({ error: "theme asset storage not configured" }, { status: 503 });
				}
				const object = await bucket.get(key);
				if (object === null) return Response.json({ error: "not found" }, { status: 404 });
				return new Response(object.body, {
					headers: {
						"content-type": object.httpMetadata?.contentType ?? contentTypeForKey(key),
						"content-length": String(object.size),
						// Keys embed a uuid — content is immutable per key.
						"cache-control": "public, max-age=31536000, immutable",
					},
				});
			},
		},
	},
});
