import { useMemo, useState } from "react";

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
import { Input } from "@ktbhealth/ui/components/input";

import type { TemplatesMessages } from "../i18n.ts";

/** The templatable thing pending save — `null` keeps the dialog
 * closed. `id` keys the inner form so switching targets resets the
 * name/description draft; `source` is the kind-specific object the
 * surface already resolved (the dialog never fetches). */
export interface SaveAsTemplateTarget {
	readonly id: string | number;
	readonly kind: string;
	readonly defaultName: string;
	readonly defaultDescription?: string | null;
	readonly source: unknown;
}

export interface SaveAsTemplateDialogProps {
	readonly target: SaveAsTemplateTarget | null;
	/** Discovered plugin registry — `dialogAction` chrome entries in
	 * the `templates.save.actions` region supply extra save options
	 * (the mirror of `rich-text.delete.actions`). */
	readonly plugins: readonly Plugin[];
	/** Active pathname — chrome `when` rules evaluate against it. */
	readonly pathname: string;
	readonly t: TemplatesMessages;
	readonly busy: boolean;
	/** `actionId` is the picked `dialogAction` id, `null` for the plain
	 * save — surfaces interpret contributed actions themselves. */
	readonly onConfirm: (input: {
		readonly name: string;
		readonly description: string;
		readonly actionId: string | null;
	}) => void;
	readonly onCancel: () => void;
}

interface DialogAction {
	readonly id: string;
	readonly owner: string;
	readonly label: string;
	readonly description?: string;
	readonly destructive?: boolean;
}

/**
 * Shared "Save as template" dialog for templatable surfaces (P-107).
 * Collects `dialogAction` chrome entries from the
 * `templates.save.actions` region — the same collection contract the
 * rich-text delete dialog uses — and renders them as optional save
 * choices; the chosen `actionId` (or `null`) goes back to the surface,
 * which owns the actual `saveTemplateFn` call. The dialog itself is
 * kind-agnostic: it only collects name + description.
 */
export function SaveAsTemplateDialog(props: SaveAsTemplateDialogProps) {
	const { target, onCancel } = props;
	return (
		<AlertDialog
			open={target !== null}
			onOpenChange={(open) => {
				/* v8 ignore next -- a controlled dialog only reports closes */
				if (!open) onCancel();
			}}
		>
			<AlertDialogContent>
				{target !== null ? (
					<SaveAsTemplateForm
						key={`${target.kind}:${String(target.id)}`}
						{...props}
						target={target}
					/>
				) : null}
			</AlertDialogContent>
		</AlertDialog>
	);
}

function SaveAsTemplateForm({
	target,
	plugins,
	pathname,
	t,
	busy,
	onConfirm,
}: SaveAsTemplateDialogProps & { readonly target: SaveAsTemplateTarget }) {
	const [name, setName] = useState(target.defaultName);
	const [description, setDescription] = useState(target.defaultDescription ?? "");
	const [selected, setSelected] = useState<string | null>(null);

	// Contributed save actions — collectChrome already applied region +
	// `when` rules; every dialogAction entry is a global save option.
	const actions = useMemo<readonly DialogAction[]>(
		() =>
			collectChrome(plugins, "templates.save.actions", pathname).flatMap((entry) =>
				entry.content.kind === "dialogAction" ? [entry.content.action] : [],
			),
		[plugins, pathname],
	);

	// Preselect the first non-destructive action (fallback: first) so
	// the common choice is one click — same convention as the delete
	// dialog.
	const defaultActionId =
		actions.find((action) => action.destructive !== true)?.id ?? actions[0]?.id ?? null;
	const effectiveActionId = actions.find((action) => action.id === selected)?.id ?? defaultActionId;

	const canSave = name.trim() !== "" && !busy;

	return (
		<>
			<AlertDialogHeader>
				<AlertDialogTitle>{t.saveAsTitle}</AlertDialogTitle>
				<AlertDialogDescription>{t.saveAsBody(target.defaultName)}</AlertDialogDescription>
			</AlertDialogHeader>
			<div className="flex flex-col gap-3">
				<div className="space-y-1.5">
					<label htmlFor="template-name" className="text-sm font-medium">
						{t.fieldName}
					</label>
					<Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} />
				</div>
				<div className="space-y-1.5">
					<label htmlFor="template-description" className="text-sm font-medium">
						{t.fieldDescription}
					</label>
					<Input
						id="template-description"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
					/>
				</div>
				{actions.length > 0 ? (
					<div>
						<p className="text-sm font-medium">{t.saveAsPrompt}</p>
						<div className="mt-2 flex flex-col gap-1" role="group">
							{actions.map((action) => {
								const isSelected = action.id === effectiveActionId;
								return (
									<button
										key={action.id}
										type="button"
										aria-pressed={isSelected}
										onClick={() => setSelected(action.id)}
										className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
											isSelected ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
										}`}
									>
										<span
											className={
												action.destructive === true ? "font-medium text-destructive" : "font-medium"
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
			<AlertDialogFooter>
				<AlertDialogCancel disabled={busy}>{t.cancel}</AlertDialogCancel>
				<AlertDialogAction
					disabled={!canSave}
					onClick={() =>
						onConfirm({
							name: name.trim(),
							description: description.trim(),
							actionId: effectiveActionId,
						})
					}
				>
					{t.save}
				</AlertDialogAction>
			</AlertDialogFooter>
		</>
	);
}
