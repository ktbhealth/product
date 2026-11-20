import { useEffect, useRef, useState } from "react";

import type { ElementKindEditorProps } from "@ktb/kernel";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Input } from "@ktbhealth/ui/components/input";
import { Label } from "@ktbhealth/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Spinner } from "@ktbhealth/ui/components/spinner";

import { listImagesFn, type ImageWire } from "../fns.ts";
import { IMAGE_FITS, type ImageFit } from "../value.ts";

/**
 * `elementKinds` editor for kind `"image"` (P-111): a library-picker
 * dialog — grid of uploaded images, an upload affordance hitting
 * `POST /api/images`, and alt/fit fields — that emits the kind's
 * stored value `{ imageId, alt?, fit? }` through `onChange`.
 *
 * The editor is controlled-by-callback (same contract as
 * `RichTextElementEditor`): `value` is the stored payload, never a
 * resolved render payload; consumers own loading/saving and remount
 * via `key` when swapping refs. Client-only — it pulls the dialog and
 * upload stack, so it belongs on the `elementKinds` manifest, never in
 * a server-rendered path.
 */

const FIT_LABELS: Record<ImageFit, string> = {
	cover: "Cover",
	contain: "Contain",
	fill: "Fill",
};

interface Draft {
	readonly imageId: number | null;
	readonly alt: string;
	readonly fit: ImageFit;
}

const draftFrom = (value: unknown): Draft => {
	const v =
		typeof value === "object" && value !== null
			? (value as { imageId?: unknown; alt?: unknown; fit?: unknown })
			: {};
	const imageId =
		typeof v.imageId === "number" && Number.isInteger(v.imageId) && v.imageId > 0
			? v.imageId
			: null;
	return {
		imageId,
		alt: typeof v.alt === "string" ? v.alt : "",
		fit: IMAGE_FITS.includes(v.fit as ImageFit) ? (v.fit as ImageFit) : "cover",
	};
};

export function ImageElementEditor({ value, onChange }: ElementKindEditorProps) {
	const initial = draftFrom(value);
	const [open, setOpen] = useState(false);
	const [images, setImages] = useState<readonly ImageWire[] | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [draft, setDraft] = useState<Draft>(initial);
	const fileRef = useRef<HTMLInputElement>(null);

	const refresh = () => {
		setLoadFailed(false);
		listImagesFn()
			.then(setImages)
			.catch(() => setLoadFailed(true));
	};

	// Fetch the library when the dialog opens (and on every open so
	// uploads from other surfaces show up).
	useEffect(() => {
		if (!open) return;
		setDraft(draftFrom(value));
		refresh();
		// `value` changes while closed don't need a refetch — the draft
		// re-reads it on open.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const upload = async (file: File) => {
		setUploading(true);
		try {
			const form = new FormData();
			form.set("file", file);
			const res = await fetch("/api/images", { method: "POST", body: form });
			if (res.ok) refresh();
		} finally {
			setUploading(false);
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	const selected = images?.find((img) => img.id === draft.imageId) ?? null;

	const confirm = () => {
		if (draft.imageId === null) return;
		onChange({
			imageId: draft.imageId,
			...(draft.alt.trim() !== "" ? { alt: draft.alt.trim() } : {}),
			fit: draft.fit,
		});
		setOpen(false);
	};

	return (
		<div className="flex flex-col gap-2">
			<Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
				{selected !== null || draft.imageId !== null ? "Change image" : "Choose image"}
			</Button>
			{draft.imageId !== null ? (
				<div className="flex items-center gap-3">
					{selected !== null ? (
						<img
							src={selected.src}
							alt={selected.alt}
							className="h-12 w-12 rounded-md border border-border object-cover"
						/>
					) : null}
					<span className="text-xs text-muted-foreground">
						{selected?.title || selected?.alt || `Image #${draft.imageId}`}
					</span>
				</div>
			) : null}

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>Media library</DialogTitle>
						<DialogDescription>
							Pick an image, or upload a new one. Alt text and fit apply to this placement.
						</DialogDescription>
					</DialogHeader>

					<div className="flex items-center gap-2">
						<input
							ref={fileRef}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file !== undefined) void upload(file);
							}}
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={uploading}
							onClick={() => fileRef.current?.click()}
						>
							{uploading ? <Spinner className="size-4" /> : "Upload image"}
						</Button>
					</div>

					{images === null && !loadFailed ? (
						<div className="flex items-center justify-center py-8">
							<Spinner className="size-5" />
						</div>
					) : loadFailed ? (
						<p className="py-4 text-sm text-destructive">Could not load the image library.</p>
					) : images !== null && images.length === 0 ? (
						<p className="py-4 text-sm text-muted-foreground">
							No images yet — upload the first one.
						</p>
					) : (
						<div
							className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4"
							role="listbox"
							aria-label="Image library"
						>
							{(images ?? []).map((img) => {
								const active = img.id === draft.imageId;
								return (
									<button
										key={img.id}
										type="button"
										role="option"
										aria-selected={active}
										onClick={() => setDraft((d) => ({ ...d, imageId: img.id }))}
										className={`overflow-hidden rounded-md border text-left transition-colors ${
											active
												? "border-primary ring-1 ring-primary"
												: "border-border hover:bg-accent/50"
										}`}
									>
										<img
											src={img.src}
											alt={img.alt}
											loading="lazy"
											className="aspect-square w-full bg-muted object-cover"
										/>
										<span className="block truncate px-1.5 py-1 text-xs">
											{img.title || img.alt || `Image #${img.id}`}
										</span>
									</button>
								);
							})}
						</div>
					)}

					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="image-element-alt">Alt text</Label>
							<Input
								id="image-element-alt"
								value={draft.alt}
								onChange={(e) => setDraft((d) => ({ ...d, alt: e.target.value }))}
								placeholder="Leave empty to use the library alt text"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="image-element-fit">Fit</Label>
							<Select
								value={draft.fit}
								onValueChange={(next) => setDraft((d) => ({ ...d, fit: next as ImageFit }))}
							>
								<SelectTrigger id="image-element-fit">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{IMAGE_FITS.map((fit) => (
										<SelectItem key={fit} value={fit}>
											{FIT_LABELS[fit]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button type="button" disabled={draft.imageId === null} onClick={confirm}>
							Use image
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
