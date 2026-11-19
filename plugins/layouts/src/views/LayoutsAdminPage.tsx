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
	createLayoutFn,
	deleteLayoutFn,
	layoutDocFn,
	updateLayoutFn,
	type LayoutDocWire,
	type LayoutMetaWire,
} from "../fns.ts";
import { I18N_NAMESPACE, layoutsMessages, type LayoutsMessages } from "../i18n.ts";

/** List row the panel loader hands down — the `layouts` meta narrowed
 * to id/name/description/sectionCount/updatedAt (ISO string). */
export type LayoutRow = LayoutMetaWire;

export interface LayoutsAdminPageProps {
	readonly layouts: readonly LayoutRow[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

/** Editor state: `null` shows the layout list; `"new"` opens a
 * create-mode pane (no row yet — the first save inserts it); an id
 * opens the editor pane for that layout (fetched via `layoutDocFn`). */
type EditorView = "new" | { readonly id: number };

/** One parsed config section — only the fields the preview renders. */
interface PreviewSection {
	readonly title?: unknown;
}

/** Lenient client-side parse of the config text for the read-only
 * section-title preview: anything that isn't
 * `{sections:[{title:string}]}` yields an empty list — the server-side
 * contract check on save is the real gate. */
const previewSections = (configText: string): readonly PreviewSection[] => {
	try {
		const parsed: unknown = JSON.parse(configText);
		if (typeof parsed !== "object" || parsed === null) return [];
		const sections = (parsed as { sections?: unknown }).sections;
		return Array.isArray(sections)
			? sections.filter(
					(section): section is PreviewSection => typeof section === "object" && section !== null,
				)
			: [];
	} catch {
		return [];
	}
};

/**
 * /platform/layouts console view: CRUD over the `layouts` table. The
 * list view shows layout metas; "New layout" opens a create-mode
 * editor whose first save inserts the row through the admin-gated
 * server fns. The editor edits name + description + the raw JSON
 * config in a monospace textarea (the same pattern the schemas editor
 * uses for JSON payloads) with a read-only preview of the section
 * titles; writes are explicit through Save — there is no autosave and
 * no visual slot editor yet. Deletes go through a ConfirmDialog
 * confirm. Mutations go through the plugin's server fns; the loader
 * re-runs via `router.invalidate()` after writes.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell + `ConfirmAction` for the delete confirm +
 * `useServerMutation` for the invalidate plumbing — the list swaps
 * the whole page for the editor pane (no row-navigation model), and
 * the editor's create flow is bespoke.
 */
export function LayoutsAdminPage({ layouts, i18n, locale }: LayoutsAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, layoutsMessages(locale));
	const router = useRouter();
	const [view, setView] = useState<EditorView | null>(null);
	const [toast, setToast] = useState<ToastData | null>(null);

	const del = useServerMutation<{ id: number }>(deleteLayoutFn);

	const showToast = (text: string) => setToast({ id: Date.now(), text });

	const confirmDelete = async (target: LayoutRow) => {
		const ok = await del.mutate({ id: target.id });
		showToast(ok ? t.deleted : t.deleteFailed);
	};

	const columns: readonly Column<LayoutRow>[] = [
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
			key: "sectionCount",
			header: t.colSections,
			render: (row) => <span className="text-muted-foreground">{row.sectionCount}</span>,
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
				<LayoutsEditorPane
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
					<Button type="button" size="sm" onClick={() => setView("new")} disabled={del.busy}>
						<PlusIcon className="size-4" />
						{t.newLayout}
					</Button>
				}
			/>
			<TablePage.Table
				columns={columns}
				rows={layouts}
				locale={locale}
				empty={{ title: t.emptyTitle, description: t.emptyDescription }}
			/>
			<Toast toast={toast} onClose={() => setToast(null)} />
		</TablePage>
	);
}

interface PaneProps {
	readonly view: EditorView;
	readonly t: LayoutsMessages;
	readonly onExit: () => void;
	readonly onSaved: () => void;
	readonly onToast: (text: string) => void;
}

/**
 * Single-layout editor: name + description inputs and the raw JSON
 * config in a monospace textarea, plus a read-only preview listing the
 * section titles parsed from the current text. Unlike the rich-text
 * pane there is no autosave — writes are explicit through Save.
 * "New" mode holds no row id until the first successful create, which
 * flips the pane into edit mode for that row. Edit mode always fetches
 * the doc through `layoutDocFn` — there is no loader-passed payload.
 */
function LayoutsEditorPane({ view, t, onExit, onSaved, onToast }: PaneProps) {
	const editId = view === "new" ? null : view.id;
	const [docId, setDocId] = useState<number | null>(editId);
	const [status, setStatus] = useState<"loading" | "ready">(view === "new" ? "ready" : "loading");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [configText, setConfigText] = useState('{"sections":[]}');
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

	// Fetch the layout when the pane opened from the list.
	useEffect(() => {
		if (editId === null) return;
		loadCancelledRef.current = false;
		layoutDocFn({ data: { id: editId } })
			.then((doc) => {
				if (loadCancelledRef.current) return;
				if (doc === null) {
					onToastRef.current(tRef.current.loadFailed);
					onExitRef.current();
					return;
				}
				setName(doc.name);
				setDescription(doc.description ?? "");
				setConfigText(doc.config);
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
		// the pane's lifetime (keyed remount per layout).
	}, [editId]);

	/** Persist name + description + config text. Create-mode inserts
	 * the row and flips the pane to edit mode; edit mode updates.
	 * Resolves the saved wire doc, or null on handled failure. */
	const persist = async (): Promise<LayoutDocWire | null> => {
		setSaveState("saving");
		const payload = { name, description, config: configText };
		try {
			const res =
				docId === null
					? await createLayoutFn({ data: payload })
					: await updateLayoutFn({ data: { id: docId, ...payload } });
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

	const sections = previewSections(configText);
	const canSave = name.trim() !== "";

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
					<label htmlFor="layout-name" className="text-sm font-medium">
						{t.fieldName}
					</label>
					<Input
						id="layout-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={t.namePlaceholder}
					/>
				</div>
				<div className="space-y-1.5">
					<label htmlFor="layout-description" className="text-sm font-medium">
						{t.fieldDescription}
					</label>
					<Input
						id="layout-description"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
					/>
				</div>
				<div className="space-y-1.5">
					<label htmlFor="layout-config" className="text-sm font-medium">
						{t.fieldConfig}
					</label>
					<Textarea
						id="layout-config"
						value={configText}
						onChange={(e) => setConfigText(e.target.value)}
						rows={14}
						className="font-mono text-xs"
					/>
					<p className="text-xs text-muted-foreground">{t.configHint}</p>
				</div>
				<div className="rounded-lg border border-border px-4 py-3">
					<p className="text-sm font-medium">{t.sectionsPreview}</p>
					{sections.length === 0 ? (
						<p className="mt-1 text-sm text-muted-foreground">{t.noSections}</p>
					) : (
						<ol className="mt-2 list-decimal space-y-1 pl-5">
							{sections.map((section, index) => (
								<li key={index} className="text-sm text-muted-foreground">
									{typeof section.title === "string" && section.title !== ""
										? section.title
										: `#${index + 1}`}
								</li>
							))}
						</ol>
					)}
				</div>
			</div>
		</div>
	);
}
