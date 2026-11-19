import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { LocalDateTime } from "@ktb/views/views";
import { TablePage, viewsMessages, type Column } from "@ktb/views/table";

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
import { Button, buttonVariants } from "@ktbhealth/ui/components/button";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import type {
	CollectionWire,
	DocumentWire,
	DocumentsPageWire,
	SaveDocumentResult,
} from "../fns.ts";
import { createDocumentFn, deleteDocumentFn, updateDocumentFn, documentsFn } from "../fns.ts";
import { documentStoreMessages, I18N_NAMESPACE } from "../i18n.ts";
import {
	buildDocumentData,
	DOCUMENTS_PAGE_SIZE,
	fieldEntries,
	formatCell,
	initialInputValue,
	type BuildDataResult,
} from "./field-utils.ts";

const PAGE_SIZE = DOCUMENTS_PAGE_SIZE;
/** Select sentinel for the "no value" option on optional enum fields —
 * Base UI selects reject empty-string item values. */
const NONE_VALUE = "__none__";

export interface DocumentsAdminPageProps {
	readonly collection: CollectionWire;
	/** First page from the panel loader; later pages come from
	 * `documentsFn`. */
	readonly initialPage: DocumentsPageWire;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

interface FormState {
	readonly id: number | null;
	readonly inputs: Record<string, string>;
}

const formFrom = (collection: CollectionWire, doc: DocumentWire | null): FormState => ({
	id: doc?.id ?? null,
	inputs: Object.fromEntries(
		fieldEntries(collection.fields).map(([name, descriptor]) => [
			name,
			initialInputValue(descriptor, doc?.data[name]),
		]),
	),
});

export const reasonMessage = (
	t: ReturnType<typeof documentStoreMessages>,
	reason: "invalidNumber" | "invalidDate" | "invalidJson",
): string =>
	reason === "invalidJson"
		? t.invalidJson
		: reason === "invalidDate"
			? t.invalidDate
			: t.invalidNumber;

/**
 * /platform/document-store/<name> — the document browser for one
 * collection: a table whose columns come from the field DSL, server-
 * side pagination through `documentsFn`, and a generated editor
 * (scalar kinds get real inputs; json/array get a JSON textarea; ref
 * is an id input). Mutations go through the admin-gated server fns;
 * validation issues from the store are rendered verbatim.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell with a dynamic `Column` model and `TablePage.Footer`
 * pagination. The kit table has no per-row click hook, so row-click
 * editing is preserved with a delegated handler on the wrapper —
 * clicks on interactive elements (buttons, links, inputs) are
 * ignored, and the actions cell keeps its own stopPropagation.
 */
export function DocumentsAdminPage({
	collection,
	initialPage,
	i18n,
	locale,
}: DocumentsAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, documentStoreMessages(locale));
	const [page, setPage] = useState<DocumentsPageWire>(initialPage);
	const [pageIndex, setPageIndex] = useState(0);
	const [form, setForm] = useState<FormState | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<DocumentWire | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);

	const fields = fieldEntries(collection.fields);
	const pageCount = Math.max(1, Math.ceil(page.total / PAGE_SIZE));

	const fetchPage = async (index: number) => {
		setLoadFailed(false);
		const result = await documentsFn({
			data: {
				collection: collection.name,
				limit: PAGE_SIZE,
				offset: index * PAGE_SIZE,
			},
		});
		if (result === null) {
			setLoadFailed(true);
			return;
		}
		setPage(result);
		setPageIndex(index);
	};

	const setInput = (name: string, value: string) =>
		setForm(
			/* v8 ignore next -- inputs only render while a form is open */
			(f) => (f === null ? f : { ...f, inputs: { ...f.inputs, [name]: value } }),
		);

	const save = async () => {
		/* v8 ignore next -- the submit button only exists while the dialog is open */
		if (form === null) return;
		const built: BuildDataResult = buildDocumentData(collection.fields, form.inputs);
		if (!built.ok) {
			setFormError(`${built.field}: ${reasonMessage(t, built.reason)}`);
			return;
		}
		setBusy(true);
		setFormError(null);
		try {
			const result: SaveDocumentResult =
				form.id === null
					? await createDocumentFn({ data: { collection: collection.name, data: built.data } })
					: await updateDocumentFn({
							data: { collection: collection.name, id: form.id, data: built.data },
						});
			if (result.status === "saved") {
				setForm(null);
				await fetchPage(pageIndex);
			} else if (result.status === "invalid") {
				setFormError(result.issues.join("; "));
			} else {
				setFormError(t.saveFailed);
			}
		} catch {
			setFormError(t.saveFailed);
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		/* v8 ignore next -- the confirm action only exists while a target is set */
		if (deleteTarget === null) return;
		setBusy(true);
		setDeleteError(null);
		try {
			const result = await deleteDocumentFn({
				data: { collection: collection.name, id: deleteTarget.id },
			});
			if (result.status === "deleted") {
				setDeleteTarget(null);
				await fetchPage(pageIndex);
			} else if (result.status === "in-use") {
				setDeleteError(t.deleteInUse(result.referencedBy.join(", ")));
			} else {
				setDeleteError(t.saveFailed);
			}
		} catch {
			setDeleteError(t.saveFailed);
		} finally {
			setBusy(false);
		}
	};

	const columns: Column<DocumentWire>[] = [
		{
			key: "id",
			header: t.colId,
			render: (row) => <span className="font-mono text-xs">{row.id}</span>,
		},
		...fields.map(([name, descriptor]): Column<DocumentWire> => ({
			key: `field:${name}`,
			header: name,
			render: (row) => {
				const value = row.data[name];
				// Epoch-ms date cells render client-side only —
				// toLocaleString during SSR picks the worker's
				// timezone and mismatches hydration.
				return (
					<span className="block max-w-48 truncate">
						{descriptor.kind === "date" && typeof value === "number" && Number.isFinite(value) ? (
							<LocalDateTime value={value} locale={locale} />
						) : (
							formatCell(descriptor.kind, value, locale)
						)}
					</span>
				);
			},
		})),
		{
			key: "updatedAt",
			header: t.colUpdated,
			render: (row) => (
				<span className="whitespace-nowrap text-muted-foreground">
					<LocalDateTime value={row.updatedAt} locale={locale} />
				</span>
			),
		},
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (row) => (
				<div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setForm(formFrom(collection, row))}
						aria-label={t.edit}
					>
						<PencilIcon className="size-4" />
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							setDeleteError(null);
							setDeleteTarget(row);
						}}
						aria-label={t.delete}
					>
						<Trash2Icon className="size-4 text-destructive" />
					</Button>
				</div>
			),
		},
	];

	return (
		<TablePage messages={viewsMessages(locale ?? "en")}>
			<TablePage.Header
				title={collection.name}
				description={t.description}
				actions={
					<div className="flex items-center gap-2">
						{/* Real link, not Button render=: it navigates, so it
						    keeps link semantics (and avoids the Base UI
						    nativeButton warning). */}
						<Link
							to="/platform/document-store"
							className={buttonVariants({ size: "sm", variant: "ghost" })}
						>
							<ArrowLeftIcon className="size-4" />
							{t.back}
						</Link>
						<Button size="sm" onClick={() => setForm(formFrom(collection, null))}>
							<PlusIcon className="size-4" />
							{t.newDocument}
						</Button>
					</div>
				}
			/>
			{loadFailed ? <p className="text-sm text-destructive">{t.loadFailed}</p> : null}
			<TablePage.Table
				columns={columns}
				rows={page.rows}
				rowKey={(row) => String(row.id)}
				onRowClick={(row) => setForm(formFrom(collection, row))}
				empty={{ title: t.emptyDocumentsTitle, description: t.emptyDocumentsDescription }}
				locale={locale}
			/>
			{page.total > PAGE_SIZE ? (
				<TablePage.Footer>
					<p className="text-sm text-muted-foreground">{t.pageInfo(pageIndex + 1, pageCount)}</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={pageIndex === 0}
							onClick={() => void fetchPage(pageIndex - 1)}
						>
							{t.prevPage}
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={pageIndex + 1 >= pageCount}
							onClick={() => void fetchPage(pageIndex + 1)}
						>
							{t.nextPage}
						</Button>
					</div>
				</TablePage.Footer>
			) : null}

			<Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
				<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							{form?.id === null || form === null ? t.newDocument : t.editDocument}
						</DialogTitle>
						<DialogDescription>{collection.name}</DialogDescription>
					</DialogHeader>
					{form === null ? null : (
						<div className="flex flex-col gap-4">
							{formError !== null ? <p className="text-sm text-destructive">{formError}</p> : null}
							{fields.map(([name, descriptor]) => {
								/* v8 ignore next -- formFrom seeds every declared field */
								const value = form.inputs[name] ?? "";
								const inputId = `doc-${collection.name}-${name}`;
								switch (descriptor.kind) {
									case "boolean":
										return (
											<label key={name} className="flex items-center gap-2 text-sm">
												<Checkbox
													checked={value === "true"}
													onCheckedChange={(v) => setInput(name, v === true ? "true" : "false")}
												/>
												{name}
											</label>
										);
									case "enum":
										return (
											<Field key={name}>
												<FieldLabel htmlFor={inputId}>{name}</FieldLabel>
												<Select
													value={value === "" ? NONE_VALUE : value}
													onValueChange={(v) => setInput(name, v === NONE_VALUE ? "" : String(v))}
												>
													<SelectTrigger id={inputId}>
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value={NONE_VALUE}>{t.none}</SelectItem>
														{(descriptor.values ?? []).map((option) => (
															<SelectItem key={option} value={option}>
																{option}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</Field>
										);
									case "json":
									case "array":
										return (
											<Field key={name}>
												<FieldLabel htmlFor={inputId}>{name}</FieldLabel>
												<Textarea
													id={inputId}
													value={value}
													onChange={(e) => setInput(name, e.target.value)}
													rows={4}
													className="font-mono text-xs"
												/>
												<FieldDescription>{t.invalidJson}</FieldDescription>
											</Field>
										);
									case "date":
										return (
											<Field key={name}>
												<FieldLabel htmlFor={inputId}>{name}</FieldLabel>
												<Input
													id={inputId}
													type="datetime-local"
													value={value}
													onChange={(e) => setInput(name, e.target.value)}
												/>
											</Field>
										);
									case "number":
									case "ref":
										return (
											<Field key={name}>
												<FieldLabel htmlFor={inputId}>{name}</FieldLabel>
												<Input
													id={inputId}
													type="number"
													value={value}
													onChange={(e) => setInput(name, e.target.value)}
												/>
												{descriptor.kind === "ref" &&
												(descriptor.collection !== undefined || descriptor.entity !== undefined) ? (
													<FieldDescription>
														→ {descriptor.collection ?? descriptor.entity}
													</FieldDescription>
												) : null}
											</Field>
										);
									default:
										return (
											<Field key={name}>
												<FieldLabel htmlFor={inputId}>{name}</FieldLabel>
												<Input
													id={inputId}
													value={value}
													onChange={(e) => setInput(name, e.target.value)}
												/>
											</Field>
										);
								}
							})}
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setForm(null)} disabled={busy}>
							{t.cancel}
						</Button>
						<Button onClick={() => void save()} disabled={busy}>
							{busy ? <Spinner className="size-4" /> : form?.id === null ? t.create : t.save}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={deleteTarget !== null}
				onOpenChange={(open) => {
					/* v8 ignore next -- the dialog only closes through this callback; opening is controlled by deleteTarget */
					if (!open) {
						setDeleteTarget(null);
						setDeleteError(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t.deleteTitle}</AlertDialogTitle>
						<AlertDialogDescription>
							{deleteTarget === null ? "" : t.deleteBody(String(deleteTarget.id))}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{deleteError !== null ? <p className="text-sm text-destructive">{deleteError}</p> : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>{t.cancel}</AlertDialogCancel>
						<AlertDialogAction onClick={() => void remove()} disabled={busy}>
							{busy ? <Spinner className="size-4" /> : t.deleteConfirm}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</TablePage>
	);
}
