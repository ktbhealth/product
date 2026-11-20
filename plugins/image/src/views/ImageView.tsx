import type { ElementKindRendererProps } from "@ktb/kernel";

/**
 * Renderable payload the `"image"` kind's server descriptor resolves —
 * exactly what `ImageView` receives as `value`. Kept structural (not
 * imported from element-kind.ts) so this module stays client-safe and
 * free of service imports.
 */
export interface ImageViewPayload {
	readonly src: string;
	readonly alt: string;
	readonly title?: string;
	readonly width?: number | null;
	readonly height?: number | null;
	readonly mime?: string;
	readonly fit?: string | null;
}

const FIT_CLASS: Record<string, string> = {
	cover: "object-cover",
	contain: "object-contain",
	fill: "object-fill",
};

const asPayload = (value: unknown): ImageViewPayload | null => {
	if (typeof value !== "object" || value === null) return null;
	const src = (value as { src?: unknown }).src;
	if (typeof src !== "string" || src === "") return null;
	const alt = (value as { alt?: unknown }).alt;
	const width = (value as { width?: unknown }).width;
	const height = (value as { height?: unknown }).height;
	const title = (value as { title?: unknown }).title;
	const mime = (value as { mime?: unknown }).mime;
	const fit = (value as { fit?: unknown }).fit;
	return {
		src,
		alt: typeof alt === "string" ? alt : "",
		...(typeof title === "string" ? { title } : {}),
		width: typeof width === "number" ? width : null,
		height: typeof height === "number" ? height : null,
		...(typeof mime === "string" ? { mime } : {}),
		fit: typeof fit === "string" ? fit : null,
	};
};

/**
 * `elementKinds` renderer for kind `"image"` (P-111): a responsive
 * `<img>` fed by the resolved payload. `src` is the plugin's public
 * serve URL (`/api/images/:id`); intrinsic `width`/`height` become
 * attributes plus an aspect-ratio hint so layout doesn't jump while
 * the bytes stream; `fit` maps to the matching object-fit utility.
 * Missing/invalid payloads render an empty placeholder — a deleted or
 * unresolved image degrades the block, never the page.
 */
export function ImageView({ value }: ElementKindRendererProps) {
	const payload = asPayload(value);
	if (payload === null) {
		return <div className="w-full" aria-hidden="true" />;
	}
	const hasDims =
		typeof payload.width === "number" &&
		payload.width > 0 &&
		typeof payload.height === "number" &&
		payload.height > 0;
	const fitClass = typeof payload.fit === "string" ? (FIT_CLASS[payload.fit] ?? "") : "";
	return (
		<img
			src={payload.src}
			alt={payload.alt}
			title={payload.title}
			width={hasDims ? payload.width : undefined}
			height={hasDims ? payload.height : undefined}
			loading="lazy"
			decoding="async"
			className={`h-auto w-full ${fitClass}`.trim()}
			style={hasDims ? { aspectRatio: `${payload.width} / ${payload.height}` } : undefined}
		/>
	);
}
