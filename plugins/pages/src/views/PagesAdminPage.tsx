import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { TablePage, viewsMessages, type Column } from "@ktb/views/table";

import { Badge } from "@ktbhealth/ui/components/badge";
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

import { createPageFn, deletePageFn, updatePageFn } from "../fns.ts";
import { pagesMessages, I18N_NAMESPACE } from "../i18n.ts";

/** Row shape the panel loader hands down — the `custom_pages` record
 * narrowed to the fields the console edits (timestamps unused).
 * `richTextId` references the @ktb/rich-text document rendered as the
 * page body (null = no document); `layoutId` references the
 * @ktb/layouts row whose sections compose the body instead (null =
 * single-document render). */
export interface AdminPageRow {
	readonly id: number;
	readonly path: string;
	readonly title: string;
	readonly richTextId: number | null;
	readonly searchSchemaId: number | null;
	readonly layoutId: number | null;
	readonly published: boolean;
	readonly showInNav: boolean;
	readonly sortOrder: number;
}

/** Picker option for the content-document select — the loader maps
 * `RichTexts.adminList()` meta down to id + title. */
export interface RichTextDocRef {
	readonly id: number;
	readonly title: string;
}

/** Picker option for the search-schema select — the loader maps
 * `Schemas.adminList()` meta down to id + name + description. */
export interface SchemaRef {
	readonly id: number;
	readonly name: string;
	readonly description: string | null;
}

/** Picker option for the layout select — the loader maps
 * `Layouts.adminList()` meta down to id + name + description. */
export interface LayoutRef {
	readonly id: number;
	readonly name: string;
	readonly description: string | null;
}

export interface PagesAdminPageProps {
	readonly pages: readonly AdminPageRow[];
	readonly docs: readonly RichTextDocRef[];
	/** False when the rich-text plugin's service is absent — the
	 * content-document field (picker + manage link) is hidden; stored
	 * `richTextId` values are preserved untouched. */
	readonly richTextEnabled: boolean;
	/** Schema picker options for the search-schema field. */
	readonly schemas: readonly SchemaRef[];
	/** False when the schemas plugin's service is absent — the
	 * search-schema field is hidden; stored `searchSchemaId` values
	 * are preserved untouched. */
	readonly searchSchemaEnabled: boolean;
	/** Layout picker options for the layout field. */
	readonly layouts: readonly LayoutRef[];
	/** False when the layouts plugin's service is absent — the layout
	 * field is hidden; stored `layoutId` values are preserved
	 * untouched. */
	readonly layoutEnabled: boolean;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

interface FormState {
	readonly id: number | null;
	readonly path: string;
	readonly title: string;
	readonly richTextId: number | null;
	readonly searchSchemaId: number | null;
	readonly layoutId: number | null;
	readonly published: boolean;
	readonly showInNav: boolean;
	readonly sortOrder: string;
}

const EMPTY_FORM: FormState = {
	id: null,
	path: "",
	title: "",
	richTextId: null,
	searchSchemaId: null,
	layoutId: null,
	published: false,
	showInNav: false,
	sortOrder: "0",
};

const formFrom = (row: AdminPageRow | null): FormState =>
	row === null
		? /* v8 ignore next -- formFrom is only invoked with a table row */ EMPTY_FORM
		: {
				id: row.id,
				path: row.path,
				title: row.title,
				richTextId: row.richTextId,
				searchSchemaId: row.searchSchemaId,
				layoutId: row.layoutId,
				published: row.published,
				showInNav: row.showInNav,
				sortOrder: String(row.sortOrder),
			};

const toInput = (form: FormState) => ({
	path: form.path,
	title: form.title,
	richTextId: form.richTextId,
	searchSchemaId: form.searchSchemaId,
	layoutId: form.layoutId,
	published: form.published,
	showInNav: form.showInNav,
	sortOrder: Number(form.sortOrder) || 0,
});

/** Console route owned by the @ktb/rich-text plugin — not part of the
 * typed route tree, so the Link target is cast like chrome.tsx does
 * for page paths. */
const RICH_TEXT_CONSOLE = "/platform/rich-text" as string;

/** Console route owned by the @ktb/schemas plugin — same untyped-route
 * cast as RICH_TEXT_CONSOLE. */
const SCHEMAS_CONSOLE = "/platform/schemas" as string;

/** Console route owned by the @ktb/layouts plugin — same untyped-route
 * cast as RICH_TEXT_CONSOLE. */
const LAYOUTS_CONSOLE = "/platform/layouts" as string;

/**
 * /platform/pages console view (T-083): CRUD over the `custom_pages`
 * table. Published pages render publicly through the wildcard `pages`
 * descriptor; `showInNav` pages join the app-header nav. Mutations go
 * through the plugin's admin-gated server fns; the loader re-runs via
 * `router.invalidate()` after each write.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell with a `Column` model for the row badges/actions. The
 * create/edit dialog and delete confirm stay plugin-local — the kit's
 * `FormDialog`/`ConfirmAction` cannot express the conditional
 * rich-text/schema pickers and the untyped console links.
 */
export function PagesAdminPage({
	pages,
	docs,
	richTextEnabled,
	schemas,
	searchSchemaEnabled,
	layouts,
	layoutEnabled,
	i18n,
	locale,
}: PagesAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, pagesMessages(locale));
	// Select items for the document picker: "" is the none option —
	// the same empty-string convention the consultations patient picker
	// uses (onValueChange maps "" back to null).
	const docItems = [
		{ value: "", label: t.contentDocNone },
		...docs.map((doc) => ({ value: String(doc.id), label: doc.title })),
	];
	// Same "" = none convention for the search-schema picker.
	const schemaItems = [
		{ value: "", label: t.searchSchemaNone },
		...schemas.map((schema) => ({ value: String(schema.id), label: schema.name })),
	];
	// Same "" = none convention for the layout picker.
	const layoutItems = [
		{ value: "", label: t.layoutNone },
		...layouts.map((layout) => ({ value: String(layout.id), label: layout.name })),
	];
	const router = useRouter();
	const [form, setForm] = useState<FormState | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<AdminPageRow | null>(null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setForm((f) =>
			f === null
				? /* v8 ignore next -- the inputs only exist while the form dialog is open */ f
				: { ...f, [key]: value },
		);

	const save = async () => {
		/* v8 ignore next -- the save action only exists while the form dialog is open */
		if (form === null) return;
		setBusy(true);
		setFailed(false);
		try {
			const input = toInput(form);
			const ok =
				form.id === null
					? await createPageFn({ data: input })
					: await updatePageFn({ data: { id: form.id, ...input } });
			if (ok !== null) {
				setForm(null);
				await router.invalidate();
			} else {
				setFailed(true);
			}
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		/* v8 ignore next -- the delete action only exists while the confirm dialog is open */
		if (deleteTarget === null) return;
		setBusy(true);
		setFailed(false);
		try {
			const ok = await deletePageFn({ data: { id: deleteTarget.id } });
			if (ok) await router.invalidate();
			else setFailed(true);
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
			setDeleteTarget(null);
		}
	};

	const columns: Column<AdminPageRow>[] = [
		{
			key: "path",
			header: t.colPath,
			render: (row) => <span className="font-mono text-xs">{row.path}</span>,
		},
		{ key: "title", header: t.colTitle },
		{
			key: "status",
			header: t.colStatus,
			render: (row) => (
				<Badge variant={row.published ? "default" : "secondary"}>
					{row.published ? t.statusPublished : t.statusDraft}
				</Badge>
			),
		},
		{
			key: "nav",
			header: t.colNav,
			render: (row) => (
				<Badge variant={row.showInNav ? "default" : "outline"}>
					{row.showInNav ? t.navShown : t.navHidden}
				</Badge>
			),
		},
		{
			key: "sortOrder",
			header: t.colOrder,
			render: (row) => <span className="text-muted-foreground">{row.sortOrder}</span>,
		},
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (row) => (
				<div className="flex items-center justify-end gap-1">
					{row.published ? (
						<Link
							to={row.path as "/"}
							className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
							aria-label={t.view}
						>
							<ExternalLinkIcon className="size-4" />
						</Link>
					) : null}
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setForm(formFrom(row))}
						aria-label={t.edit}
					>
						<PencilIcon className="size-4" />
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setDeleteTarget(row)}
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
				title={t.title}
				description={t.description}
				actions={
					<Button size="sm" onClick={() => setForm(EMPTY_FORM)}>
						<PlusIcon className="size-4" />
						{t.newPage}
					</Button>
				}
			/>
			{failed ? <p className="text-sm text-destructive">{t.saveFailed}</p> : null}
			<TablePage.Table
				columns={columns}
				rows={pages}
				rowKey={(row) => String(row.id)}
				empty={{ title: t.emptyTitle, description: t.emptyDescription }}
				locale={locale}
			/>

			<Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{form?.id === null || form === null ? t.create : t.edit}</DialogTitle>
						<DialogDescription>{t.pathHint}</DialogDescription>
					</DialogHeader>
					{form === null ? null : (
						<div className="flex flex-col gap-4">
							<Field>
								<FieldLabel htmlFor="cp-path">{t.fieldPath}</FieldLabel>
								<Input
									id="cp-path"
									value={form.path}
									onChange={(e) => set("path", e.target.value)}
									placeholder="/about"
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="cp-title">{t.fieldTitle}</FieldLabel>
								<Input
									id="cp-title"
									value={form.title}
									onChange={(e) => set("title", e.target.value)}
								/>
							</Field>
							{richTextEnabled ? (
								<Field>
									<FieldLabel>{t.fieldContentDoc}</FieldLabel>
									<Select
										items={docItems}
										value={form.richTextId === null ? "" : String(form.richTextId)}
										onValueChange={(v) => set("richTextId", v === "" ? null : Number(v))}
									>
										<SelectTrigger aria-label={t.fieldContentDoc} className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{docItems.map((item) => (
												<SelectItem key={item.value} value={item.value}>
													{item.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FieldDescription>
										{t.contentDocHint}{" "}
										<Link
											to={
												(form.richTextId === null
													? RICH_TEXT_CONSOLE
													: `${RICH_TEXT_CONSOLE}?doc=${form.richTextId}`) as "/"
											}
											className="underline underline-offset-2 hover:text-foreground"
										>
											{form.richTextId === null ? t.manageDocs : t.manageDoc}
										</Link>
									</FieldDescription>
								</Field>
							) : null}
							{searchSchemaEnabled ? (
								<Field>
									<FieldLabel>{t.fieldSearchSchema}</FieldLabel>
									<Select
										items={schemaItems}
										value={form.searchSchemaId === null ? "" : String(form.searchSchemaId)}
										onValueChange={(v) => set("searchSchemaId", v === "" ? null : Number(v))}
									>
										<SelectTrigger aria-label={t.fieldSearchSchema} className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{schemaItems.map((item) => (
												<SelectItem key={item.value} value={item.value}>
													{item.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FieldDescription>
										{t.searchSchemaHint}{" "}
										<Link
											to={SCHEMAS_CONSOLE as "/"}
											className="underline underline-offset-2 hover:text-foreground"
										>
											{t.manageSchemas}
										</Link>
									</FieldDescription>
								</Field>
							) : null}
							{layoutEnabled ? (
								<Field>
									<FieldLabel>{t.fieldLayout}</FieldLabel>
									<Select
										items={layoutItems}
										value={form.layoutId === null ? "" : String(form.layoutId)}
										onValueChange={(v) => set("layoutId", v === "" ? null : Number(v))}
									>
										<SelectTrigger aria-label={t.fieldLayout} className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{layoutItems.map((item) => (
												<SelectItem key={item.value} value={item.value}>
													{item.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FieldDescription>
										{t.layoutHint}{" "}
										<Link
											to={LAYOUTS_CONSOLE as "/"}
											className="underline underline-offset-2 hover:text-foreground"
										>
											{t.manageLayouts}
										</Link>
									</FieldDescription>
								</Field>
							) : null}
							<div className="flex flex-wrap gap-6">
								<label className="flex items-center gap-2 text-sm">
									<Checkbox
										checked={form.published}
										onCheckedChange={(v) => set("published", v === true)}
									/>
									{t.fieldPublished}
								</label>
								<label className="flex items-center gap-2 text-sm">
									<Checkbox
										checked={form.showInNav}
										onCheckedChange={(v) => set("showInNav", v === true)}
									/>
									{t.fieldShowInNav}
								</label>
								<Field className="w-28">
									<FieldLabel htmlFor="cp-order">{t.fieldSortOrder}</FieldLabel>
									<Input
										id="cp-order"
										type="number"
										value={form.sortOrder}
										onChange={(e) => set("sortOrder", e.target.value)}
									/>
								</Field>
							</div>
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
				onOpenChange={(open) => !open && setDeleteTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t.deleteTitle}</AlertDialogTitle>
						<AlertDialogDescription>
							{deleteTarget === null ? "" : t.deleteBody(deleteTarget.path)}
						</AlertDialogDescription>
					</AlertDialogHeader>
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
