import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { desc, eq } from "drizzle-orm";

import { Forbidden } from "@ktb/authz";
import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";

import { images, type Image } from "./schema.ts";

export type { Image } from "./schema.ts";

/**
 * Media-library domain service (P-111): DB-backed `images` rows whose
 * bytes live in the deployment's image object store (the api route owns
 * the bucket — this service never touches storage). Admin methods
 * re-check the `PlatformAdmin` gate inside the service (defense in
 * depth — the panel guard and the server fns gate too); `getById` and
 * `serveById` are public reads so anonymous visitors can render site
 * images through `/api/images/:id` and the `"image"` element kind can
 * resolve refs without a principal.
 */

/** `adminUpdate`/`adminRemove` targeted a missing row. */
export class ImageNotFound extends Data.TaggedError("ImageNotFound")<{
	readonly id: number;
}> {}

/** `adminCreate`/`adminUpdate` received meta that fails validation —
 * the rejected input is carried for debugging. */
export class InvalidImageInput extends Data.TaggedError("InvalidImageInput")<{
	readonly field: string;
	readonly value: unknown;
}> {}

export type ImageError = Forbidden | ImageNotFound | InvalidImageInput;

/** Row shape shared by admin and public reads. `storageKey` is the
 * bucket object key — server-side only (the serve route needs it; it
 * never reaches the wire). */
export interface ImageRecord {
	readonly id: number;
	readonly title: string;
	readonly alt: string;
	readonly mime: string;
	readonly size: number;
	readonly storageKey: string;
	readonly width: number | null;
	readonly height: number | null;
	readonly createdAt: Date;
}

const TITLE_MAX = 200;
const ALT_MAX = 500;
const KEY_MAX = 512;

const toRecord = (row: Image): ImageRecord => ({
	id: row.id,
	title: row.title,
	alt: row.alt,
	mime: row.mime,
	size: row.size,
	storageKey: row.storageKey,
	width: row.width,
	height: row.height,
	createdAt: row.createdAt,
});

const normText = (
	value: string | undefined,
	field: string,
	max: number,
): Effect.Effect<string | undefined, InvalidImageInput> => {
	if (value === undefined) return Effect.succeed(undefined);
	const trimmed = value.trim();
	if (trimmed.length > max) {
		return Effect.fail(new InvalidImageInput({ field, value }));
	}
	return Effect.succeed(trimmed);
};

/** Upload metadata the api route hands to `adminCreate` — every field
 * is validated again here so direct service callers get the same
 * contract the wire schema promises. */
export interface ImageUploadMeta {
	readonly title?: string;
	readonly alt?: string;
	readonly mime: string;
	readonly size: number;
	readonly storageKey: string;
	readonly width?: number | null;
	readonly height?: number | null;
}

/** The `Images` service shape — exported so client-safe modules (the
 * `"image"` element-kind declaration in ./kind.tsx) can type the
 * services record via `import type` without pulling the server graph. */
export interface ImagesShape {
	/** Every image, newest first. */
	readonly adminList: () => Effect.Effect<readonly ImageRecord[], Forbidden>;
	/** One image by id; null when missing. */
	readonly adminGet: (id: number) => Effect.Effect<ImageRecord | null, ImageError>;
	/** Record an uploaded object; `InvalidImageInput` on bad meta. */
	readonly adminCreate: (input: ImageUploadMeta) => Effect.Effect<ImageRecord, ImageError>;
	/** Update title and/or alt; `ImageNotFound` when missing. */
	readonly adminUpdate: (
		id: number,
		input: { readonly title?: string; readonly alt?: string },
	) => Effect.Effect<ImageRecord, ImageError>;
	/** Delete the row by id; `ImageNotFound` when missing. The caller
	 * owns object cleanup — `adminGet`/`getById` exposes `storageKey`. */
	readonly adminRemove: (id: number) => Effect.Effect<void, ImageError>;
	/** Public read by id (no admin gate); null when missing. */
	readonly getById: (id: number) => Effect.Effect<ImageRecord | null>;
}

export class Images extends Context.Service<Images, ImagesShape>()("@ktb/image/Images") {}

export const ImagesLive = Layer.effect(
	Images,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;

		const requireAdmin = platformAdmin.requireAdmin();
		const byId = (id: number) => eq(images.id, id);

		const validateMeta = (input: ImageUploadMeta) =>
			Effect.gen(function* () {
				const title = yield* normText(input.title, "title", TITLE_MAX);
				const alt = yield* normText(input.alt, "alt", ALT_MAX);
				if (typeof input.mime !== "string" || input.mime.trim() === "") {
					return yield* new InvalidImageInput({ field: "mime", value: input.mime });
				}
				if (!Number.isInteger(input.size) || input.size <= 0) {
					return yield* new InvalidImageInput({ field: "size", value: input.size });
				}
				const storageKey = input.storageKey.trim();
				if (storageKey === "" || storageKey.length > KEY_MAX || storageKey.includes("..")) {
					return yield* new InvalidImageInput({
						field: "storageKey",
						value: input.storageKey,
					});
				}
				const dim = (v: number | null | undefined, field: string) =>
					v === undefined || v === null
						? Effect.succeed(null)
						: Number.isInteger(v) && v > 0
							? Effect.succeed(v)
							: Effect.fail(new InvalidImageInput({ field, value: v }));
				const width = yield* dim(input.width, "width");
				const height = yield* dim(input.height, "height");
				return { title, alt, width, height, storageKey };
			});

		return Images.of({
			adminList: Effect.fn("Images.adminList")(function* () {
				yield* requireAdmin;
				return yield* Effect.promise(() =>
					db.select().from(images).orderBy(desc(images.createdAt)),
				).pipe(Effect.map((rows) => rows.map(toRecord)));
			}),
			adminGet: Effect.fn("Images.adminGet")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() => db.select().from(images).where(byId(id)).limit(1));
				const row = rows[0];
				return row === undefined ? null : toRecord(row);
			}),
			adminCreate: Effect.fn("Images.adminCreate")(function* (input: ImageUploadMeta) {
				yield* requireAdmin;
				const meta = yield* validateMeta(input);
				const rows = yield* Effect.promise(() =>
					db
						.insert(images)
						.values({
							title: meta.title ?? "",
							alt: meta.alt ?? "",
							mime: input.mime.trim().toLowerCase(),
							size: input.size,
							storageKey: meta.storageKey,
							width: meta.width,
							height: meta.height,
							createdAt: new Date(),
						})
						.returning(),
				);
				const row = rows[0];
				if (row === undefined) {
					return yield* new InvalidImageInput({ field: "storageKey", value: input.storageKey });
				}
				return toRecord(row);
			}),
			adminUpdate: Effect.fn("Images.adminUpdate")(function* (
				id: number,
				input: { readonly title?: string; readonly alt?: string },
			) {
				yield* requireAdmin;
				const title = yield* normText(input.title, "title", TITLE_MAX);
				const alt = yield* normText(input.alt, "alt", ALT_MAX);
				const set: { title?: string; alt?: string } = {};
				if (title !== undefined) set.title = title;
				if (alt !== undefined) set.alt = alt;
				const rows = yield* Effect.promise(() =>
					db.update(images).set(set).where(byId(id)).returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new ImageNotFound({ id });
				return toRecord(row);
			}),
			adminRemove: Effect.fn("Images.adminRemove")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.delete(images).where(byId(id)).returning({ id: images.id }),
				);
				if (rows.length === 0) return yield* new ImageNotFound({ id });
			}),
			getById: Effect.fn("Images.getById")(function* (id: number) {
				const rows = yield* Effect.promise(() => db.select().from(images).where(byId(id)).limit(1));
				const row = rows[0];
				return row === undefined ? null : toRecord(row);
			}),
		});
	}),
);
