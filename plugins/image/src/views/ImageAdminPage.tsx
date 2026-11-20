import { useRef, useState } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { PencilIcon, Trash2Icon, UploadIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice, Plugin } from "@ktb/kernel";
import { useServerMutation } from "@ktb/views/table";

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
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import { Toast, type ToastData } from "@ktbhealth/ui/components/app-toast";

import { deleteImageFn, updateImageFn, type ImageWire } from "../fns.ts";
import { I18N_NAMESPACE, imageMessages, type ImageMessages } from "../i18n.ts";
import { ImageDeleteDialog } from "./image-delete-dialog.tsx";

/** List row the panel loader hands down — the `images` table narrowed
 * to the wire shape (ISO `createdAt`, `src` serve URL). */
export type ImageRow = ImageWire;

export interface ImageAdminPageProps {
	readonly images: readonly ImageRow[];
	/** Discovered plugin registry — feeds the delete dialog's
	 * `dialogAction` chrome collection (`image.delete.actions`). */
	readonly plugins?: readonly Plugin[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

/** Image pending metadata edit — `null` keeps the dialog closed. */
interface EditTarget {
	readonly id: number;
	readonly title: string;
	readonly alt: string;
}

/**
 * /platform/images console view (P-111): the media library — a grid of
 * uploaded images with upload, metadata edit and referencer-aware
 * delete. Uploads POST multipart to `/api/images` (the api route owns
 * validation + object storage); meta edits and deletes go through the
 * admin-gated server fns; the loader re-runs via `router.invalidate()`
 * after writes.
 */
export function ImageAdminPage({ images, plugins = [], i18n, locale }: ImageAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, imageMessages(locale));
	const router = useRouter();
	const pathname = useLocation({ select: (l) => l.pathname });
	const [deleteTarget, setDeleteTarget] = useState<ImageRow | null>(null);
	const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
	const [uploading, setUploading] = useState(false);
	const [toast, setToast] = useState<ToastData | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const del = useServerMutation<{ id: number; actionId?: string }>(deleteImageFn);
	const anyBusy = uploading || del.busy;

	const showToast = (text: string) => setToast({ id: Date.now(), text });

	const upload = async (file: File) => {
		setUploading(true);
		try {
			const form = new FormData();
			form.set("file", file);
			form.set("title", file.name.replace(/\.[^.]+$/, ""));
			const res = await fetch("/api/images", { method: "POST", body: form });
			if (res.ok) {
				await router.invalidate();
			} else {
				showToast(t.uploadFailed);
			}
		} catch {
			showToast(t.uploadFailed);
		} finally {
			setUploading(false);
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	const confirmDelete = async (actionId: string | null) => {
		/* v8 ignore next -- the confirm action only exists while the dialog is open */
		if (deleteTarget === null) return;
		const target = deleteTarget;
		setDeleteTarget(null);
		const ok = await del.mutate(
			actionId === null ? { id: target.id } : { id: target.id, actionId },
		);
		showToast(ok ? t.deleted : t.deleteFailed);
	};

	return (
		<PageContainer>
			<div className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-2">
					<div>
						<h1 className="text-lg font-semibold">{t.title}</h1>
						<p className="text-sm text-muted-foreground">{t.description}</p>
					</div>
					<div className="ml-auto flex items-center gap-2">
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
						<Button size="sm" disabled={anyBusy} onClick={() => fileRef.current?.click()}>
							{uploading ? <Spinner className="size-4" /> : <UploadIcon className="size-4" />}
							{uploading ? t.uploading : t.upload}
						</Button>
					</div>
				</div>

				{images.length === 0 ? (
					<div className="rounded-lg border border-dashed border-border py-12 text-center">
						<p className="text-sm font-medium">{t.emptyTitle}</p>
						<p className="text-sm text-muted-foreground">{t.emptyDescription}</p>
					</div>
				) : (
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
						{images.map((img) => (
							<div
								key={img.id}
								className="group overflow-hidden rounded-lg border border-border bg-card"
							>
								<div className="relative aspect-square bg-muted">
									<img
										src={img.src}
										alt={img.alt}
										loading="lazy"
										className="h-full w-full object-cover"
									/>
									<div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
										<Button
											size="icon"
											variant="secondary"
											className="size-7"
											aria-label={t.edit}
											onClick={() =>
												setEditTarget({
													id: img.id,
													title: img.title,
													alt: img.alt,
												})
											}
										>
											<PencilIcon className="size-3.5" />
										</Button>
										<Button
											size="icon"
											variant="secondary"
											className="size-7"
											aria-label={t.delete}
											onClick={() => setDeleteTarget(img)}
										>
											<Trash2Icon className="size-3.5 text-destructive" />
										</Button>
									</div>
								</div>
								<div className="truncate px-2 py-1.5 text-xs">
									{img.title || img.alt || t.untitled}
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<ImageEditDialog
				target={editTarget}
				t={t}
				busy={anyBusy}
				onClose={() => setEditTarget(null)}
				onSaved={() => {
					setEditTarget(null);
					void router.invalidate();
				}}
				onToast={showToast}
			/>

			<ImageDeleteDialog
				image={deleteTarget}
				plugins={plugins}
				pathname={pathname}
				t={t}
				busy={anyBusy}
				onConfirm={(actionId) => void confirmDelete(actionId)}
				onCancel={() => setDeleteTarget(null)}
			/>
			<Toast toast={toast} onClose={() => setToast(null)} />
		</PageContainer>
	);
}

interface EditDialogProps {
	readonly target: EditTarget | null;
	readonly t: ImageMessages;
	readonly busy: boolean;
	readonly onClose: () => void;
	readonly onSaved: () => void;
	readonly onToast: (text: string) => void;
}

/** Title/alt editor for one image — saves through `updateImageFn`. */
function ImageEditDialog({ target, t, busy, onClose, onSaved, onToast }: EditDialogProps) {
	const [title, setTitle] = useState("");
	const [alt, setAlt] = useState("");
	const [saving, setSaving] = useState(false);
	const [loadedId, setLoadedId] = useState<number | null>(null);

	// Sync fields when a different image opens the dialog (render-time
	// adjustment, same pattern as derived state — no effect needed).
	if (target !== null && loadedId !== target.id) {
		setLoadedId(target.id);
		setTitle(target.title);
		setAlt(target.alt);
	}
	if (target === null && loadedId !== null) {
		setLoadedId(null);
	}

	const save = async () => {
		/* v8 ignore next -- the dialog only renders its footer while open */
		if (target === null) return;
		setSaving(true);
		try {
			const res = await updateImageFn({
				data: { id: target.id, title, alt },
			});
			if (res === null) {
				onToast(t.saveFailed);
				return;
			}
			onSaved();
		} catch {
			onToast(t.saveFailed);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog
			open={target !== null}
			onOpenChange={(open) => {
				/* v8 ignore next -- a controlled dialog only reports closes */
				if (!open) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t.edit}</DialogTitle>
					<DialogDescription>{t.fieldTitle}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="image-edit-title">{t.fieldTitle}</Label>
						<Input id="image-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="image-edit-alt">{t.fieldAlt}</Label>
						<Input id="image-edit-alt" value={alt} onChange={(e) => setAlt(e.target.value)} />
					</div>
				</div>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onClose} disabled={busy || saving}>
						{t.cancel}
					</Button>
					<Button type="button" onClick={() => void save()} disabled={busy || saving}>
						{saving ? <Spinner className="size-4" /> : t.save}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
