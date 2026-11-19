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

import { richTextUsageFn, type RichTextUsageWire } from "../fns.ts";
import type { RichTextMessages } from "../i18n.ts";

/** The document pending deletion — `null` keeps the dialog closed. */
interface DeleteDialogDoc {
	readonly id: number;
	readonly title: string;
}

export interface RichTextDeleteDialogProps {
	readonly doc: DeleteDialogDoc | null;
	/** Discovered plugin registry — `dialogAction` chrome entries in
	 * the `rich-text.delete.actions` region supply the referencer
	 * actions. */
	readonly plugins: readonly Plugin[];
	/** Active pathname — chrome `when` rules evaluate against it. */
	readonly pathname: string;
	readonly t: RichTextMessages;
	readonly busy: boolean;
	/** `actionId` is the picked `dialogAction` id, `null` for the plain
	 * unreferenced delete. */
	readonly onConfirm: (actionId: string | null) => void;
	readonly onCancel: () => void;
}

type UsageState =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly owners: RichTextUsageWire };

interface DialogAction {
	readonly id: string;
	readonly owner: string;
	readonly label: string;
	readonly description?: string;
	readonly destructive?: boolean;
}

/**
 * Shared delete-confirmation dialog for rich-text documents. On open it
 * asks `richTextUsageFn` which plugins reference the document; owners
 * with referents get the extended dialog — referents grouped by owner
 * plus a picker of the `dialogAction` chrome entries those owners
 * contributed (actions whose owner reported zero referents stay
 * hidden). Unreferenced documents get the plain confirm.
 *
 * A usage-fn failure renders the error state with confirm disabled —
 * guessing "unreferenced" could hide a referencer, and the FK backstop
 * would only surface a bare delete failure anyway.
 */
export function RichTextDeleteDialog({
	doc,
	plugins,
	pathname,
	t,
	busy,
	onConfirm,
	onCancel,
}: RichTextDeleteDialogProps) {
	const docId = doc?.id ?? null;
	// Results are tagged with the docId they belong to — a doc switch
	// derives "loading" again without a synchronous reset inside the
	// effect (react/set-state-in-effect).
	const [usageResult, setUsageResult] = useState<{
		readonly docId: number;
		readonly state: UsageState;
	} | null>(null);
	const [selected, setSelected] = useState<{ docId: number; id: string } | null>(null);
	const usage: UsageState =
		docId !== null && usageResult?.docId === docId ? usageResult.state : { status: "loading" };
	const selectedId = selected !== null && selected.docId === docId ? selected.id : null;

	useEffect(() => {
		if (docId === null) return;
		let cancelled = false;
		richTextUsageFn({ data: { id: docId } })
			.then((owners) => {
				if (!cancelled) setUsageResult({ docId, state: { status: "ready", owners } });
			})
			.catch(() => {
				if (!cancelled) setUsageResult({ docId, state: { status: "error" } });
			});
		return () => {
			cancelled = true;
		};
	}, [docId]);

	const extended = usage.status === "ready" && usage.owners.length > 0;

	// Contributed actions filtered to owners that actually reported
	// referents — collectChrome already applied region + `when` rules.
	const actions = useMemo<readonly DialogAction[]>(() => {
		const state = docId !== null && usageResult?.docId === docId ? usageResult.state : null;
		if (state?.status !== "ready") return [];
		const ownerIds = new Set(state.owners.map((owner) => owner.id));
		return collectChrome(plugins, "rich-text.delete.actions", pathname).flatMap((entry) => {
			if (entry.content.kind !== "dialogAction") return [];
			const action = entry.content.action;
			return ownerIds.has(action.owner) ? [action] : [];
		});
	}, [usageResult, docId, plugins, pathname]);

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
			open={doc !== null}
			onOpenChange={(open) => {
				/* v8 ignore next -- a controlled dialog only reports closes */
				if (!open) onCancel();
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t.deleteTitle}</AlertDialogTitle>
					<AlertDialogDescription>
						{doc === null ? "" : t.deleteBody(doc.title)}
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
											<li key={item.id}>
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
													if (docId !== null) setSelected({ docId, id: action.id });
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
