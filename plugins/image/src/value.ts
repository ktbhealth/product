/**
 * Pure helpers over the `"image"` element kind's stored value (P-111) —
 * no service/ui imports, so they stay safe for both the client bundle
 * (editor/renderer) and the server descriptor.
 *
 * The stored value is the editor's payload object:
 * `{ imageId, alt?, fit? }` — `imageId` references the `images` row,
 * `alt` is an optional per-placement alt override (falls back to the
 * row's alt text at resolve time), `fit` is the object-fit mode.
 * A bare positive integer is tolerated as `{ imageId }` for
 * hand-written content.
 */

/** Object-fit vocabulary the editor offers and the renderer applies. */
export const IMAGE_FITS = ["cover", "contain", "fill"] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];

export const isImageFit = (value: unknown): value is ImageFit =>
	typeof value === "string" && (IMAGE_FITS as readonly string[]).includes(value);

/** The kind's stored value — what consumers persist next to
 * `kind: "image"` and what the editor's `onChange` emits. */
export interface ImageElementValue {
	readonly imageId: number;
	readonly alt?: string;
	readonly fit?: ImageFit;
}

/** Normalize an unknown stored value into an `ImageElementValue`:
 * `{ imageId }` objects and bare positive integers both qualify;
 * anything else resolves to null. */
export const asImageElementValue = (value: unknown): ImageElementValue | null => {
	if (typeof value === "number") {
		return Number.isInteger(value) && value > 0 ? { imageId: value } : null;
	}
	if (typeof value !== "object" || value === null) return null;
	const imageId = (value as { imageId?: unknown }).imageId;
	if (typeof imageId !== "number" || !Number.isInteger(imageId) || imageId <= 0) {
		return null;
	}
	const alt = (value as { alt?: unknown }).alt;
	const fit = (value as { fit?: unknown }).fit;
	return {
		imageId,
		...(typeof alt === "string" && alt.trim() !== "" ? { alt } : {}),
		...(isImageFit(fit) ? { fit } : {}),
	};
};
