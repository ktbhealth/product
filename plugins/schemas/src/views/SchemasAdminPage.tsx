import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { LocalDateTime } from "@ktb/views/views";
import {
	ConfirmAction,
	TablePage,
	useServerMutation,
	viewsMessages,
	type Column,
} from "@ktb/views/table";

import { Toast, type ToastData } from "@ktbhealth/ui/components/app-toast";
import { Button } from "@ktbhealth/ui/components/button";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import {
	createSchemaFn,
	deleteSchemaFn,
	schemaDocFn,
	updateSchemaFn,
	validateSchemaFn,
	type SchemaDocWire,
	type SchemaMetaWire,
	type SchemaValidationWire,
} from "../fns.ts";
import { I18N_NAMESPACE, schemasMessages, type SchemasMessages } from "../i18n.ts";

/** List row the panel loader hands down — the `schemas` meta narrowed
 * to id/name/description/updatedAt (ISO string). */
export type SchemaRow = SchemaMetaWire;

export interface SchemasAdminPageProps {
	readonly schemas: readonly SchemaRow[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

/** Editor state: `null` shows the schema list; `"new"` opens a
 * create-mode pane (no row yet — the first save inserts it); an id
 * opens the editor pane for that schema (fetched via `schemaDocFn`). */
type EditorView = "new" | { readonly id: number };

/**
 * /platform/schemas console view: CRUD over the `schemas` table. The
 * list view shows schema metas; "New schema" opens a create-mode
 * editor whose first save inserts the row through the admin-gated
 * server fns. The editor edits name + description + the raw JSON
 * Schema text in a monospace textarea (the same pattern the theme and
 * document-store editors use for JSON payloads); "Validate" persists
 * pending edits, then runs the stored schema against `{}` and lists
 * the issues. Deletes go through a ConfirmDialog confirm. Mutations go
 * through the plugin's server fns; the loader re-runs via
 * `router.invalidate()` after writes.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell + `ConfirmAction` for the delete confirm +
 * `useServerMutation` for the invalidate plumbing. `defineAdminTable`
 * does not fit — the list swaps the whole page for the editor pane
 * (no row-navigation model), and the editor's create/validate flow is
 * bespoke. `deleteSchemaFn` resolves a bare boolean rather than the
 * `{ ok, data }` envelope, so it is adapted inline.
 */
export function SchemasAdminPage({ schemas, i18n, locale }: SchemasAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, schemasMessages(locale));
	const router = useRouter();
	const [view, setView] = useState<EditorView | null>(null);
	const [toast, setToast] = useState<ToastData | null>(null);

	const del = useServerMutation<{ id: number }>(deleteSchemaFn);

	const showToast = (text: string) => setToast({ id: Date.now(), text });

	const confirmDelete = async (target: SchemaRow) => {
		const ok = await del.mutate({ id: target.id });
		showToast(ok ? t.deleted : t.deleteFailed);
	};

	const columns: readonly Column<SchemaRow>[] = [
		{
			key: "name",
			header: t.colName,
			render: (row) => <span className="font-medium">{row.name}</span>,
		},
		{
			key: "description",
			header: t.colDescription,
			render: (row) => (
				<span className="text-muted-foreground">{row.description ?? ""}</span>
			),
		},
		{
			key: "updatedAt",
			header: t.colUpdated,
			render: (row) => (
				<span className="text-muted-foreground">
					<LocalDateTime value={row.updatedAt} locale={locale} />
				</span>
			),
		},
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (row) => (
				<div className="flex items-center justify-end gap-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setView({ id: row.id })}
						aria-label={t.edit}
					>
						<PencilIcon className="size-4" />
					</Button>
					<ConfirmAction
						trigger={(open) => (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={open}
								aria-label={t.delete}
							>
								<Trash2Icon className="size-4 text-destructive" />
							</Button>
						)}
						title={t.deleteTitle}
						description={t.deleteBody(row.name)}
						confirmLabel={t.deleteConfirm}
						cancelLabel={t.cancel}
						variant="destructive"
						onConfirm={() => confirmDelete(row)}
					/>
				</div>
			),
		},
	];

	if (view !== null) {
		return (
			<PageContainer>
				<SchemasEditorPane
					key={view === "new" ? "new" : view.id}
					view={view}
					t={t}
					onExit={() => {
						setView(null);
						void router.invalidate();
					}}
					onSaved={() => void router.invalidate()}
					onToast={showToast}
				/>
				<Toast toast={toast} onClose={() => setToast(null)} />
			</PageContainer>
		);
	}

	return (
		<TablePage messages={viewsMessages(locale ?? "en")}>
			<TablePage.Header
				title={t.title}
				description={t.description}
				actions={
					<Button
						type="button"
						size="sm"
						onClick={() => setView("new")}
						disabled={del.busy}
					>
						<PlusIcon className="size-4" />
						{t.newSchema}
					</Button>
				}
			/>
			<TablePage.Table
				columns={columns}
				rows={schemas}
				locale={locale}
				empty={{ title: t.emptyTitle, description: t.emptyDescription }}
			/>
			<Toast toast={toast} onClose={() => setToast(null)} />
		</TablePage>
	);
}

interface PaneProps {
	readonly view: EditorView;
	readonly t: SchemasMessages;
	readonly onExit: () => void;
	readonly onSaved: () => void;
	readonly onToast: (text: string) => void;
}

/**
 * Single-schema editor: name + description inputs and the raw JSON
 * Schema in a monospace textarea. Unlike the rich-text pane there is
 * no autosave — writes are explicit through Save (and Validate
 * persists first so the server-side check sees the latest text).
 * "New" mode holds no row id until the first successful create, which
 * flips the pane into edit mode for that row. Edit mode always fetches
 * the doc through `schemaDocFn` — there is no loader-passed payload.
 */
function SchemasEditorPane({ view, t, onExit, onSaved, onToast }: PaneProps) {
	const editId = view === "new" ? null : view.id;
	const [docId, setDocId] = useState<number | null>(editId);
	const [status, setStatus] = useState<"loading" | "ready">(view === "new" ? "ready" : "loading");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [schemaText, setSchemaText] = useState("{}");
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
	const [validating, setValidating] = useState(false);
	const [validation, setValidation] = useState<SchemaValidationWire | null>(null);

	const loadCancelledRef = useRef(false);
	const tRef = useRef(t);
	const onExitRef = useRef(onExit);
	const onToastRef = useRef(onToast);
	const onSavedRef = useRef(onSaved);

	useEffect(() => {
		tRef.current = t;
		onExitRef.current = onExit;
		onToastRef.current = onToast;
		onSavedRef.current = onSaved;
	});

	// Fetch the schema when the pane opened from the list.
	useEffect(() => {
		if (editId === null) return;
		loadCancelledRef.current = false;
		schemaDocFn({ data: { id: editId } })
			.then((doc) => {
				if (loadCancelledRef.current) return;
				if (doc === null) {
					onToastRef.current(tRef.current.loadFailed);
					onExitRef.current();
					return;
				}
				setName(doc.name);
				setDescription(doc.description ?? "");
				setSchemaText(doc.schema);
				setStatus("ready");
			})
			.catch(() => {
				if (loadCancelledRef.current) return;
				onToastRef.current(tRef.current.loadFailed);
				onExitRef.current();
			});
		return () => {
			loadCancelledRef.current = true;
		};
		// Callbacks and copy ride the refs above; `editId` is fixed for
		// the pane's lifetime (keyed remount per schema).
	}, [editId]);

	/** Persist name + description + schema text. Create-mode inserts
	 * the row and flips the pane to edit mode; edit mode updates.
	 * Resolves the saved wire doc, or null on handled failure. */
	const persist = async (): Promise<SchemaDocWire | null> => {
		setSaveState("saving");
		setValidation(null);
		const payload = { name, description, schema: schemaText };
		try {
			const res =
				docId === null
					? await createSchemaFn({ data: payload })
					: await updateSchemaFn({ data: { id: docId, ...payload } });
			if (res === null) {
				setSaveState("idle");
				onToastRef.current(tRef.current.saveFailed);
				return null;
			}
			if (docId === null) {
				setDocId(res.id);
			}
			setSaveState("saved");
			onSavedRef.current();
			return res;
		} catch {
			setSaveState("idle");
			onToastRef.current(tRef.current.saveFailed);
			return null;
		}
	};

	const handleSave = () => {
		void persist();
	};

	/** Validate the CURRENT editor text against `{}`: persist pending
	 * edits first so the server-side check sees them, then run the
	 * stored schema. Create-mode rows don't exist server-side yet —
	 * save first via the same path (persist flips docId). */
	const handleValidate = async () => {
		setValidating(true);
		try {
			const saved = await persist();
			if (saved === null) return;
			const res = await validateSchemaFn({ data: { schemaId: saved.id, data: {} } });
			setValidation(res);
		} catch {
			onToastRef.current(tRef.current.saveFailed);
		} finally {
			setValidating(false);
		}
	};

	if (status === "loading") {
		return (
			<div className="flex items-center gap-3 py-16">
				<Spinner className="size-6" />
			</div>
		);
	}

	const canValidate = name.trim() !== "";

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="ghost" size="sm" onClick={onExit}>
					{t.cancel}
				</Button>
				<span className="text-xs text-muted-foreground" aria-live="polite">
					{saveState === "saving" ? t.saving : saveState === "saved" ? t.saved : ""}
				</span>
				<div className="ml-auto flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => void handleValidate()}
						disabled={validating || saveState === "saving" || !canValidate}
					>
						{validating ? t.validating : t.validate}
					</Button>
					<Button size="sm" onClick={handleSave} disabled={saveState === "saving"}>
						{docId === null ? t.create : t.save}
					</Button>
				</div>
			</div>
			<div className="grid max-w-xl gap-4">
				<div className="space-y-1.5">
					<label htmlFor="schema-name" className="text-sm font-medium">
						{t.fieldName}
					</label>
					<Input
						id="schema-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={t.namePlaceholder}
					/>
				</div>
				<div className="space-y-1.5">
					<label htmlFor="schema-description" className="text-sm font-medium">
						{t.fieldDescription}
					</label>
					<Input
						id="schema-description"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
					/>
				</div>
				<div className="space-y-1.5">
					<label htmlFor="schema-body" className="text-sm font-medium">
						{t.fieldSchema}
					</label>
					<Textarea
						id="schema-body"
						value={schemaText}
						onChange={(e) => setSchemaText(e.target.value)}
						rows={14}
						className="font-mono text-xs"
					/>
				</div>
				{validation !== null ? (
					<div className="rounded-lg border border-border px-4 py-3">
						<p
							className={
								validation.valid ? "text-sm text-muted-foreground" : "text-sm text-destructive"
							}
						>
							{validation.valid ? t.validationValid : t.validationFailed}
						</p>
						{validation.issues.length > 0 ? (
							<ul className="mt-2 space-y-1">
								{validation.issues.map((issue, i) => (
									<li key={i} className="font-mono text-xs text-muted-foreground">
										{issue.path} {issue.keyword}: {issue.message}
									</li>
								))}
							</ul>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}
