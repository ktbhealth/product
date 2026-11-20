import { Effect } from "effect";

import { createPluginApiRoute, getDoctorUser, getServerRuntime, runAs } from "@ktb/server-fns";
import { PlatformAdmin } from "@ktb/platform";

import { sniffImageSize } from "../image-size.ts";
import { Images } from "../service.ts";

/**
 * POST /api/images — media-library upload (P-111).
 *
 * Multipart form: `file` + optional `title`/`alt`. PlatformAdmin only —
 * same gate as theme asset uploads. Stores the original in the
 * deployment's image bucket (ServerRuntime.images — R2 in prod, the
 * local filesystem stand-in under dev:node) under an `images/` key
 * prefix, sniffs intrinsic dimensions when the format allows, and
 * records the `images` row. Serving goes through GET /api/images/:id —
 * never a bucket URL.
 *
 * The route module lives in this package and is mounted into the host's
 * virtual route tree by `imageRoutesPlugin`
 * (physical("/api", "src/api-routes")); the session/runtime boundary is
 * @ktb/server-fns — the bucket arrives through the runtime registry
 * (P-033), so no host imports or env reads are needed.
 */

/** Bound worker memory: originals are buffered fully before the bucket
 * put. 10MB matches the theme-assets ceiling — web-bound imagery is
 * expected to be optimized upstream; derivatives are phase 2 (PL-016). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif"] as const;

const EXT_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif",
};

const isAdmin = (user: { id: string; actorId: string; email?: string }) =>
	runAs(
		user,
		Effect.gen(function* () {
			const gate = yield* PlatformAdmin;
			return yield* gate.isAdmin({ email: user.email, userId: user.actorId });
		}),
	).catch(() => false);

export const Route = createPluginApiRoute("image.routes")("/api/images")({
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
				if (!(file instanceof File)) {
					return Response.json({ error: "missing file" }, { status: 400 });
				}
				const titleRaw = form.get("title");
				const altRaw = form.get("alt");
				const title = (typeof titleRaw === "string" ? titleRaw : "").trim();
				const alt = (typeof altRaw === "string" ? altRaw : "").trim();

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
				if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
					return Response.json({ error: "unsupported file type" }, { status: 415 });
				}
				// Cross-check the declared MIME against the extension —
				// octet-stream uploads are allowed (extension is the gate).
				if (mime !== "" && mime !== "application/octet-stream" && !mime.startsWith("image/")) {
					return Response.json({ error: "unsupported content type" }, { status: 415 });
				}
				// SVG is refused outright: image/svg+xml can carry script
				// and sanitizing it is out of scope for phase 1 (PL-016).
				if (ext === "svg" || mime === "image/svg+xml") {
					return Response.json({ error: "svg uploads are not supported" }, { status: 415 });
				}

				const { images: bucket } = getServerRuntime();
				if (!bucket) {
					return Response.json({ error: "image storage not configured" }, { status: 503 });
				}

				// Declared image/* MIME wins; octet-stream/empty falls back
				// to the extension map (the extension gate already ran, and
				// EXT_MIME covers every allowed extension).
				const storedMime =
					mime !== "" && mime !== "application/octet-stream" ? mime : EXT_MIME[ext];

				const dimensions = sniffImageSize(new Uint8Array(bytes));
				const key = `images/${crypto.randomUUID()}.${ext}`;
				await bucket.put(key, bytes, {
					httpMetadata: { contentType: storedMime },
				});

				try {
					const image = await runAs(
						user,
						Effect.gen(function* () {
							const images = yield* Images;
							return yield* images.adminCreate({
								title: title === "" ? undefined : title,
								alt: alt === "" ? undefined : alt,
								mime: storedMime,
								size: bytes.byteLength,
								storageKey: key,
								width: dimensions?.width ?? null,
								height: dimensions?.height ?? null,
							});
						}),
					);
					return Response.json({
						ok: true,
						image: {
							id: image.id,
							title: image.title,
							alt: image.alt,
							mime: image.mime,
							size: image.size,
							width: image.width,
							height: image.height,
							createdAt: image.createdAt.toISOString(),
							src: `/api/images/${image.id}`,
						},
					});
				} catch {
					// Row insert failed after the object landed — best-effort
					// rollback so a retry doesn't orphan bytes.
					try {
						await bucket.delete([key]);
					} catch {
						// Rollback is best-effort; the orphan is unreachable
						// (serving resolves through the row).
					}
					return Response.json({ error: "failed to record image" }, { status: 500 });
				}
			},
		},
	},
});
