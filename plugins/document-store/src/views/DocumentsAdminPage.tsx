import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

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
import { Button } from "@ktbhealth/ui/components/button";
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
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
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

	return (
		<PageContainer>
			<PageHeader
				title={collection.name}
				description={t.description}
				actions={
					<div className="flex items-center gap-2">
						<Button size="sm" variant="ghost" render={<Link to="/platform/document-store" />}>
							<ArrowLeftIcon className="size-4" />
							{t.back}
						</Button>
						<Button size="sm" onClick={() => setForm(formFrom(collection, null))}>
							<PlusIcon className="size-4" />
							{t.newDocument}
						</Button>
					</div>
				}
			/>
			{loadFailed ? <p className="text-sm text-destructive">{t.loadFailed}</p> : null}
			{page.rows.length === 0 ? (
				<div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
					<p className="text-sm font-medium">{t.emptyDocumentsTitle}</p>
					<p className="mt-1 text-sm text-muted-foreground">{t.emptyDocumentsDescription}</p>
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.colId}</TableHead>
								{fields.map(([name]) => (
									<TableHead key={name} className="whitespace-nowrap">
										{name}
									</TableHead>
								))}
								<TableHead>{t.colUpdated}</TableHead>
								<TableHead className="text-right">{t.colActions}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{page.rows.map((row) => (
								<TableRow
									key={row.id}
									className="cursor-pointer"
									onClick={() => setForm(formFrom(collection, row))}
								>
									<TableCell className="font-mono text-xs">{row.id}</TableCell>
									{fields.map(([name, descriptor]) => (
										<TableCell key={name} className="max-w-48 truncate text-sm">
											{formatCell(descriptor.kind, row.data[name], locale)}
										</TableCell>
									))}
									<TableCell className="whitespace-nowrap text-muted-foreground">
										{new Date(row.updatedAt).toLocaleString(locale)}
									</TableCell>
									<TableCell>
										<div
											className="flex items-center justify-end gap-1"
											onClick={(e) => e.stopPropagation()}
										>
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
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
			{page.total > PAGE_SIZE ? (
				<div className="mt-4 flex items-center justify-between">
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
				</div>
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
		</PageContainer>
	);
}
