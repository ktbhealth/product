import { Effect } from "effect";

import { serveStoredObject } from "@ktb/media";
import { createPluginApiRoute, getServerRuntime, run } from "@ktb/server-fns";

import { Images } from "../service.ts";

/**
 * GET /api/images/:id — serve a media-library image (P-111).
 *
 * Public (site content is public): resolves the `images` row, then
 * streams the stored object back — never a bucket URL. Cache-friendly:
 * storage keys embed a uuid and rows are immutable per id (meta edits
 * don't touch bytes), so responses are `immutable`. A missing row, a
 * missing object or an unbound bucket all answer honest statuses —
 * 404 for absent content, 503 when storage isn't configured.
 *
 * Mounted by `imageRoutesPlugin` (physical("/api", "src/api-routes"));
 * the bucket arrives through the ServerRuntime registry (P-033).
 */
export const Route = createPluginApiRoute("image.routes")("/api/images/$id")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const id = Number.parseInt(String(params.id), 10);
				if (!Number.isInteger(id) || id <= 0) {
					return Response.json({ error: "not found" }, { status: 404 });
				}
				const row = await run(
					Effect.gen(function* () {
						const images = yield* Images;
						return yield* images.getById(id);
					}),
				).catch(() => null);
				if (row === null) return Response.json({ error: "not found" }, { status: 404 });

				const { images: bucket } = getServerRuntime();
				if (!bucket) {
					return Response.json({ error: "image storage not configured" }, { status: 503 });
				}
				const object = await bucket.get(row.storageKey);
				if (object === null) return Response.json({ error: "not found" }, { status: 404 });
				return serveStoredObject(object, {
					contentType: row.mime,
					// Keys embed a uuid — content is immutable per key.
					cacheControl: "public, max-age=31536000, immutable",
				});
			},
		},
	},
});
