import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { asAdmin, orHandled } from "@ktb/admin-store";
import { getServerRuntime, pluginHandler, sessionHandler } from "@ktb/server-fns";

import { ImageDeleteHooks, type ImageUsageOwner } from "./delete-hooks.ts";
import { Images, type ImageRecord } from "./service.ts";

// Media-library server functions (P-111): every admin method is
// PlatformAdmin-gated (the /platform layout already 404s non-admins;
// the service re-checks inside runAs — defense in depth, same pattern
// as the rich-text plugin). Handled domain failures (Forbidden /
// ImageNotFound / InvalidImageInput) collapse to null/false/[] — the
// same "not visible / not saved" contract the other plugin fns use;
// other errors still propagate. Hook errors (`ImageDeleteHooks.usage/
// cleanup`) are `unknown` and deliberately NOT in HANDLED_TAGS: a
// hidden referencer is worse than a failed dialog, so they propagate
// to the client, which already try/catches.
//
// Uploads do NOT come through here — multipart bodies ride the
// `POST /api/images` api route (src/api-routes/images.ts), which owns
// the object store; these fns cover metadata CRUD, usage reporting and
// deletion (row + best-effort object cleanup).

/** Serializable image row — `createdAt` is an ISO string so list UIs
 * can format it client-side; `src` is the public serve URL. */
export interface ImageWire {
	readonly id: number;
	readonly title: string;
	readonly alt: string;
	readonly mime: string;
	readonly size: number;
	readonly width: number | null;
	readonly height: number | null;
	readonly createdAt: string;
	readonly src: string;
}

/** Referencers of an image grouped by owning plugin — drives the
 * delete dialog's extended confirm. Already serializable (ids, titles
 * and optional paths only). */
export type ImageUsageWire = readonly ImageUsageOwner[];

const toWire = (row: ImageRecord): ImageWire => ({
	id: row.id,
	title: row.title,
	alt: row.alt,
	mime: row.mime,
	size: row.size,
	width: row.width,
	height: row.height,
	createdAt: row.createdAt.toISOString(),
	src: `/api/images/${row.id}`,
});

const UpdateInput = Schema.Struct({
	id: Schema.Number,
	title: Schema.optionalKey(Schema.String),
	alt: Schema.optionalKey(Schema.String),
});
const IdInput = Schema.Struct({ id: Schema.Number });
const DeleteInput = Schema.Struct({
	id: Schema.Number,
	// Present when the admin picked a referencer action in the delete
	// dialog — the hooks' cleanup runs before the row is removed.
	actionId: Schema.optionalKey(Schema.String),
});

const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);
const decodeId = Schema.decodeUnknownSync(IdInput);
const decodeDelete = Schema.decodeUnknownSync(DeleteInput);

const HANDLED_TAGS = ["Forbidden", "ImageNotFound", "InvalidImageInput"] as const;

/** Admin image list for the console grid and the element-kind picker —
 * full wire rows (thumbs resolve through `src`). Handled failures
 * collapse to an empty list. */
export const listImagesFn = createServerFn({ method: "GET" }).handler(
	pluginHandler(
		"image.panel",
		sessionHandler(async ({ user }): Promise<readonly ImageWire[]> => {
			return asAdmin(
				user,
				Effect.gen(function* () {
					const images = yield* Images;
					const rows = yield* images.adminList();
					return rows.map(toWire);
				}),
			).catch(orHandled(HANDLED_TAGS, [] as readonly ImageWire[]));
		}),
	),
);

/** Update an image's title and/or alt text; `null` for non-admins,
 * missing rows and other handled failures. */
export const updateImageFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(
		pluginHandler(
			"image.panel",
			sessionHandler(async ({ data, user }): Promise<ImageWire | null> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const images = yield* Images;
						const { id, ...input } = data;
						return toWire(yield* images.adminUpdate(id, input));
					}),
				).catch(orHandled(HANDLED_TAGS, null));
			}),
		),
	);

/** Referencers of an image grouped by owning plugin — feeds the
 * delete dialog's extended confirm. Handled failures collapse to an
 * empty list; hook errors propagate (see the header comment). */
export const imageUsageFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		pluginHandler(
			"image.panel",
			sessionHandler(async ({ data, user }): Promise<ImageUsageWire> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const hooks = yield* ImageDeleteHooks;
						return yield* hooks.usage(data.id);
					}),
				).catch(orHandled(HANDLED_TAGS, [] as ImageUsageWire));
			}),
		),
	);

/** Delete an image by id; `false` for non-admins and missing rows.
 * When `actionId` is present the referencer hooks' `cleanup` runs
 * FIRST (a failed cleanup aborts before the row is touched); without
 * it the behavior is the plain delete. The stored object is removed
 * best-effort afterwards — a bucket failure never resurrects the row
 * and never fails the delete (the object is orphaned, not leaked into
 * a served URL: `/api/images/:id` resolves through the row). */
export const deleteImageFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeDelete(input))
	.handler(
		pluginHandler(
			"image.panel",
			sessionHandler(async ({ data, user }): Promise<boolean> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const images = yield* Images;
						// Read first: the storage key is needed for object cleanup
						// and a missing row must not run hooks or delete.
						const row = yield* images.adminGet(data.id);
						if (row === null) return false;
						if (data.actionId !== undefined) {
							const hooks = yield* ImageDeleteHooks;
							yield* hooks.cleanup(data.id, data.actionId);
						}
						yield* images.adminRemove(data.id);
						return row.storageKey;
					}),
				)
					.then(async (storageKey) => {
						if (storageKey === false) return false;
						// Best-effort object cleanup outside the admin gate — the
						// row is already gone; a storage failure only orphans bytes
						// (the serve route resolves through the row, so orphaned
						// objects are unreachable, never leaked).
						const bucket = getServerRuntime().images;
						if (bucket !== undefined) {
							try {
								await bucket.delete([storageKey]);
							} catch (error) {
								console.error("image object delete failed", { storageKey, error });
							}
						}
						return true;
					})
					.catch(orHandled(HANDLED_TAGS, false));
			}),
		),
	);
