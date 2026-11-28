import { Effect } from "effect";

import {
	bestEffortDelete,
	checkUpload,
	mimeForExtension,
	multipartFile,
	putStoredObject,
	storedObjectKey,
	type UploadPolicy,
} from "@ktb/media";
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

/** Upload policy — extensions + image/* MIME prefix; the shared
 * @ktb/media contract owns empty/size/ext/mime status mapping. SVG is
 * refused outright (script-capable; sanitizing is out of scope). */
const IMAGE_UPLOAD_POLICY: UploadPolicy = {
	maxBytes: MAX_UPLOAD_BYTES,
	extensions: IMAGE_EXTENSIONS,
	mimePrefixes: ["image/"],
	deny: [{ mimes: ["image/svg+xml"], error: "svg uploads are not supported" }],
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
				const file = multipartFile(form, "file");
				if (file === null) {
					return Response.json({ error: "missing file" }, { status: 400 });
				}
				const titleRaw = form.get("title");
				const altRaw = form.get("alt");
				const title = (typeof titleRaw === "string" ? titleRaw : "").trim();
				const alt = (typeof altRaw === "string" ? altRaw : "").trim();

				// Shared upload contract (@ktb/media): empty → 400,
				// oversize → 413, extension/MIME gates → 415, svg deny.
				const checked = checkUpload(
					{
						bytes: await file.arrayBuffer(),
						fileName: file.name,
						mime: file.type,
					},
					IMAGE_UPLOAD_POLICY,
				);
				if (!checked.ok) {
					return Response.json({ error: checked.error }, { status: checked.status });
				}
				const bytes = checked.bytes;
				const ext = checked.ext;

				const { images: bucket } = getServerRuntime();
				if (!bucket) {
					return Response.json({ error: "image storage not configured" }, { status: 503 });
				}

				// Declared image/* MIME wins; octet-stream/empty falls back
				// to the extension map (the extension gate already ran).
				const storedMime =
					checked.mime !== "" && checked.mime !== "application/octet-stream"
						? checked.mime
						: mimeForExtension(ext);

				const dimensions = sniffImageSize(bytes);
				const key = storedObjectKey("images/", [], ext);
				await putStoredObject(bucket, key, bytes, storedMime);

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
					await bestEffortDelete(bucket, [key]);
					return Response.json({ error: "failed to record image" }, { status: 500 });
				}
			},
		},
	},
});
