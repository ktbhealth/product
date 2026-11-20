import { useEffect, useMemo, useState } from "react";

import { collectChrome, type Plugin } from "@ktb/kernel";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ktbhealth/ui/components/alert-dialog";
import { Spinner } from "@ktbhealth/ui/components/spinner";

import { imageUsageFn, type ImageUsageWire } from "../fns.ts";
import type { ImageMessages } from "../i18n.ts";

/** The image pending deletion — `null` keeps the dialog closed. */
interface DeleteDialogImage {
	readonly id: number;
	readonly title: string;
}

export interface ImageDeleteDialogProps {
	readonly image: DeleteDialogImage | null;
	/** Discovered plugin registry — `dialogAction` chrome entries in
	 * the `image.delete.actions` region supply the referencer
	 * actions. */
	readonly plugins: readonly Plugin[];
	/** Active pathname — chrome `when` rules evaluate against it. */
	readonly pathname: string;
	readonly t: ImageMessages;
	readonly busy: boolean;
	/** `actionId` is the picked `dialogAction` id, `null` for the plain
	 * unreferenced delete. */
	readonly onConfirm: (actionId: string | null) => void;
	readonly onCancel: () => void;
}

type UsageState =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly owners: ImageUsageWire };

interface DialogAction {
	readonly id: string;
	readonly owner: string;
	readonly label: string;
	readonly description?: string;
	readonly destructive?: boolean;
}

/**
 * Shared delete-confirmation dialog for media-library images — the
 * `image.delete.actions` counterpart of the rich-text delete dialog.
 * On open it asks `imageUsageFn` which plugins reference the image;
 * owners with referents get the extended dialog — referents grouped
 * by owner plus a picker of the `dialogAction` chrome entries those
 * owners contributed (actions whose owner reported zero referents
 * stay hidden). Unreferenced images get the plain confirm.
 *
 * A usage-fn failure renders the error state with confirm disabled —
 * guessing "unreferenced" could hide a referencer and leave a
 * dangling image id inside stored content.
 */
export function ImageDeleteDialog({
	image,
	plugins,
	pathname,
	t,
	busy,
	onConfirm,
	onCancel,
}: ImageDeleteDialogProps) {
	const imageId = image?.id ?? null;
	// Results are tagged with the imageId they belong to — an image
	// switch derives "loading" again without a synchronous reset
	// inside the effect (react/set-state-in-effect).
	const [usageResult, setUsageResult] = useState<{
		readonly imageId: number;
		readonly state: UsageState;
	} | null>(null);
	const [selected, setSelected] = useState<{ imageId: number; id: string } | null>(null);
	const usage: UsageState =
		imageId !== null && usageResult?.imageId === imageId
			? usageResult.state
			: { status: "loading" };
	const selectedId = selected !== null && selected.imageId === imageId ? selected.id : null;

	useEffect(() => {
		if (imageId === null) return;
		let cancelled = false;
		imageUsageFn({ data: { id: imageId } })
			.then((owners) => {
				if (!cancelled) setUsageResult({ imageId, state: { status: "ready", owners } });
			})
			.catch(() => {
				if (!cancelled) setUsageResult({ imageId, state: { status: "error" } });
			});
		return () => {
			cancelled = true;
		};
	}, [imageId]);

	const extended = usage.status === "ready" && usage.owners.length > 0;

	// Contributed actions filtered to owners that actually reported
	// referents — collectChrome already applied region + `when` rules.
	const actions = useMemo<readonly DialogAction[]>(() => {
		const state = imageId !== null && usageResult?.imageId === imageId ? usageResult.state : null;
		if (state?.status !== "ready") return [];
		const ownerIds = new Set(state.owners.map((owner) => owner.id));
		return collectChrome(plugins, "image.delete.actions", pathname).flatMap((entry) => {
			if (entry.content.kind !== "dialogAction") return [];
			const action = entry.content.action;
			return ownerIds.has(action.owner) ? [action] : [];
		});
	}, [usageResult, imageId, plugins, pathname]);

	// Preselect the first non-destructive action (fallback: first) so
	// the common "keep referents" choice is one click.
	const defaultActionId =
		actions.find((action) => action.destructive !== true)?.id ?? actions[0]?.id ?? null;
	const effectiveActionId =
		actions.find((action) => action.id === selectedId)?.id ?? defaultActionId;

	const confirmDisabled =
		busy ||
		usage.status === "loading" ||
		usage.status === "error" ||
		(extended && actions.length === 0);

	return (
		<AlertDialog
			open={image !== null}
			onOpenChange={(open) => {
				/* v8 ignore next -- a controlled dialog only reports closes */
				if (!open) onCancel();
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t.deleteTitle}</AlertDialogTitle>
					<AlertDialogDescription>
						{image === null ? "" : t.deleteBody(image.title || t.untitled)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{usage.status === "loading" ? (
					<div className="flex items-center justify-center py-6">
						<Spinner className="size-5" />
					</div>
				) : usage.status === "error" ? (
					<p className="text-sm text-destructive">{t.deleteFailed}</p>
				) : extended ? (
					<div className="flex flex-col gap-4">
						<div>
							<p className="text-sm font-medium">{t.deleteUsedBy}</p>
							{usage.owners.map((owner) => (
								<div key={owner.id} className="mt-2">
									<ul className="list-disc pl-5 text-sm text-muted-foreground">
										{owner.items.map((item) => (
											<li key={String(item.id)}>
												{item.title}
												{item.path !== undefined ? (
													<span className="text-muted-foreground/70"> ({item.path})</span>
												) : null}
											</li>
										))}
									</ul>
								</div>
							))}
						</div>
						{actions.length > 0 ? (
							<div>
								<p className="text-sm font-medium">{t.deleteActionPrompt}</p>
								<div className="mt-2 flex flex-col gap-1" role="group">
									{actions.map((action) => {
										const selected = action.id === effectiveActionId;
										return (
											<button
												key={action.id}
												type="button"
												aria-pressed={selected}
												onClick={() => {
													/* v8 ignore next -- action buttons only render while an image is open, so imageId is never null here */
													if (imageId !== null) setSelected({ imageId, id: action.id });
												}}
												className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
													selected ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
												}`}
											>
												<span
													className={
														action.destructive === true
															? "font-medium text-destructive"
															: "font-medium"
													}
												>
													{action.label}
												</span>
												{action.description !== undefined ? (
													<span className="block text-xs text-muted-foreground">
														{action.description}
													</span>
												) : null}
											</button>
										);
									})}
								</div>
							</div>
						) : null}
					</div>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy}>{t.cancel}</AlertDialogCancel>
					<AlertDialogAction
						disabled={confirmDisabled}
						onClick={() => {
							if (extended) onConfirm(effectiveActionId);
							else onConfirm(null);
						}}
					>
						{busy ? <Spinner className="size-4" /> : t.deleteConfirm}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
