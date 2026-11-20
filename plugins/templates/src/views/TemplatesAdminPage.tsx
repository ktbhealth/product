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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import {
	deleteTemplateFn,
	saveTemplateFn,
	templateDocFn,
	updateTemplateFn,
	type TemplateDocWire,
	type TemplateMetaWire,
} from "../fns.ts";
import { I18N_NAMESPACE, templatesMessages, type TemplatesMessages } from "../i18n.ts";

/** List row the panel loader hands down — the `templates` meta
 * narrowed to id/kind/name/description/createdBy + ISO timestamps. */
export type TemplateRow = TemplateMetaWire;

/** Registered kind descriptor the loader resolved from
 * `TemplateKinds` — `label` is the admin-facing display string. */
export interface TemplateKindInfo {
	readonly kind: string;
	readonly label: string;
}

export interface TemplatesAdminPageProps {
	readonly rows: readonly TemplateRow[];
	readonly kinds: readonly TemplateKindInfo[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

/** Editor state: `null` shows the template list; `"new"` opens a
 * create-mode pane (kind + name + payload); an id opens the editor
 * pane for that template (fetched via `templateDocFn`). */
type EditorView = "new" | { readonly id: number };

/**
 * /platform/templates console view: CRUD over the `templates` table,
 * grouped by kind. Templates are snapshots written by "Save as
 * template" flows on templatable surfaces; this console lists them
 * per kind, creates raw-payload templates (kind + JSON payload,
 * validated server-side against the kind's `validate`), renames
 * name/description/payload, and deletes. Mutations go through the
 * plugin's server fns; the loader re-runs via `router.invalidate()`
 * after writes.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell + `ConfirmAction` for the delete confirm +
 * `useServerMutation` for the invalidate plumbing — the list swaps
 * the whole page for the editor pane (no row-navigation model), and
 * the editor's create flow is bespoke.
 */
export function TemplatesAdminPage({ rows, kinds, i18n, locale }: TemplatesAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, templatesMessages(locale));
	const router = useRouter();
	const [view, setView] = useState<EditorView | null>(null);
	const [toast, setToast] = useState<ToastData | null>(null);

	const del = useServerMutation<{ id: number }>(deleteTemplateFn);

	const showToast = (text: string) => setToast({ id: Date.now(), text });

	const confirmDelete = async (target: TemplateRow) => {
		const ok = await del.mutate({ id: target.id });
		showToast(ok ? t.deleted : t.deleteFailed);
	};

	const kindLabel = (kind: string) => kinds.find((k) => k.kind === kind)?.label ?? kind;

	// Group rows by kind: registered kinds first (registry order), then
	// any rows whose kind is no longer registered (still manageable —
	// delete works, payload editing fails server-side).
	const groups = (() => {
		const byKind = new Map<string, TemplateRow[]>();
		for (const row of rows) {
			const list = byKind.get(row.kind) ?? [];
			list.push(row);
			byKind.set(row.kind, list);
		}
		const ordered = [
			...kinds.map((k) => k.kind),
			...rows
				.map((r) => r.kind)
				.filter((kind, i, all) => all.indexOf(kind) === i && !kinds.some((k) => k.kind === kind)),
		];
		return ordered
			.map((kind) => ({ kind, label: kindLabel(kind), rows: byKind.get(kind) ?? [] }))
			.filter((group) => group.rows.length > 0);
	})();

	const columns: readonly Column<TemplateRow>[] = [
		{
			key: "name",
			header: t.colName,
			render: (row) => <span className="font-medium">{row.name}</span>,
		},
		{
			key: "description",
			header: t.colDescription,
			render: (row) => <span className="text-muted-foreground">{row.description ?? ""}</span>,
		},
		{
			key: "createdBy",
			header: t.colCreatedBy,
			render: (row) => <span className="text-muted-foreground">{row.createdBy ?? ""}</span>,
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
							<Button type="button" variant="ghost" size="sm" onClick={open} aria-label={t.delete}>
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
				<TemplatesEditorPane
					key={view === "new" ? "new" : view.id}
					view={view}
					kinds={kinds}
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
						disabled={del.busy || kinds.length === 0}
					>
						<PlusIcon className="size-4" />
						{t.newTemplate}
					</Button>
				}
			/>
			{groups.length === 0 ? (
				<TablePage.Table
					columns={columns}
					rows={[]}
					locale={locale}
					empty={{
						title: t.emptyTitle,
						description: kinds.length === 0 ? t.noKinds : t.emptyDescription,
					}}
				/>
			) : (
				groups.map((group) => (
					<section key={group.kind} className="flex flex-col gap-2">
						<h2 className="text-sm font-medium text-muted-foreground">
							{group.label} ({group.rows.length})
						</h2>
						<TablePage.Table columns={columns} rows={group.rows} locale={locale} />
					</section>
				))
			)}
			<Toast toast={toast} onClose={() => setToast(null)} />
		</TablePage>
	);
}

interface PaneProps {
	readonly view: EditorView;
	readonly kinds: readonly TemplateKindInfo[];
	readonly t: TemplatesMessages;
	readonly onExit: () => void;
	readonly onSaved: () => void;
	readonly onToast: (text: string) => void;
}

/**
 * Single-template editor: kind picker (create mode only — a template's
 * kind is immutable), name + description inputs and the raw JSON
 * payload in a monospace textarea. Writes are explicit through Save —
 * the payload is parsed client-side for early feedback and
 * re-validated server-side against the kind's `validate`. "New" mode
 * holds no row id until the first successful save, which flips the
 * pane into edit mode for that row. Edit mode always fetches the doc
 * through `templateDocFn` — there is no loader-passed payload.
 */
function TemplatesEditorPane({ view, kinds, t, onExit, onSaved, onToast }: PaneProps) {
	const editId = view === "new" ? null : view.id;
	const [docId, setDocId] = useState<number | null>(editId);
	const [status, setStatus] = useState<"loading" | "ready">(view === "new" ? "ready" : "loading");
	const [kind, setKind] = useState(kinds[0]?.kind ?? "");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [payloadText, setPayloadText] = useState("{}");
	const [payloadError, setPayloadError] = useState(false);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

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

	// Fetch the template when the pane opened from the list.
	useEffect(() => {
		if (editId === null) return;
		loadCancelledRef.current = false;
		templateDocFn({ data: { id: editId } })
			.then((doc) => {
				if (loadCancelledRef.current) return;
				if (doc === null) {
					onToastRef.current(tRef.current.loadFailed);
					onExitRef.current();
					return;
				}
				setKind(doc.kind);
				setName(doc.name);
				setDescription(doc.description ?? "");
				setPayloadText(JSON.stringify(doc.payload, null, 2));
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
	}, [editId]);

	/** Persist name + description + payload. Create-mode inserts the
	 * row and flips the pane to edit mode; edit mode updates. Resolves
	 * the saved wire doc, or null on handled failure / bad JSON. */
	const persist = async (): Promise<TemplateDocWire | null> => {
		let payload: unknown;
		try {
			payload = JSON.parse(payloadText);
		} catch {
			setPayloadError(true);
			return null;
		}
		setPayloadError(false);
		setSaveState("saving");
		const fields = { name, description, payload };
		try {
			const res =
				docId === null
					? await saveTemplateFn({ data: { kind, ...fields } })
					: await updateTemplateFn({ data: { id: docId, ...fields } });
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

	if (status === "loading") {
		return (
			<div className="flex items-center gap-3 py-16">
				<Spinner className="size-6" />
			</div>
		);
	}

	const canSave = name.trim() !== "" && (docId !== null || kind !== "");
	const kindLabel = kinds.find((k) => k.kind === kind)?.label ?? kind;

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
					<Button size="sm" onClick={handleSave} disabled={saveState === "saving" || !canSave}>
						{docId === null ? t.create : t.save}
					</Button>
				</div>
			</div>
			<div className="grid max-w-xl gap-4">
				<div className="space-y-1.5">
					<span className="text-sm font-medium">{t.fieldKind}</span>
					{docId === null ? (
						<Select value={kind} onValueChange={(value) => setKind(value ?? "")}>
							<SelectTrigger>
								<SelectValue placeholder={t.fieldKind} />
							</SelectTrigger>
							<SelectContent>
								{kinds.map((k) => (
									<SelectItem key={k.kind} value={k.kind}>
										{k.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : (
						<p className="text-sm text-muted-foreground">{kindLabel}</p>
					)}
				</div>
				<div className="space-y-1.5">
					<label htmlFor="template-name" className="text-sm font-medium">
						{t.fieldName}
					</label>
					<Input
						id="template-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={t.namePlaceholder}
					/>
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
				<div className="space-y-1.5">
					<label htmlFor="template-payload" className="text-sm font-medium">
						{t.fieldPayload}
					</label>
					<Textarea
						id="template-payload"
						value={payloadText}
						onChange={(e) => {
							setPayloadText(e.target.value);
							setPayloadError(false);
						}}
						rows={14}
						className="font-mono text-xs"
					/>
					<p className={`text-xs ${payloadError ? "text-destructive" : "text-muted-foreground"}`}>
						{payloadError ? t.invalidJson : t.payloadHint}
					</p>
				</div>
			</div>
		</div>
	);
}
