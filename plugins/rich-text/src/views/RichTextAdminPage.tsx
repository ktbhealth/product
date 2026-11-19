import { useEffect, useRef, useState } from "react";
import { useLocation, useRouter, useSearch } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice, Plugin } from "@ktb/kernel";

import { Toast, type ToastData } from "@ktbhealth/ui/components/app-toast";
import { Button } from "@ktbhealth/ui/components/button";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import {
	RichTextEditor,
	htmlToRichText,
	richTextToHtml,
} from "@ktbhealth/ui/components/rich-text-editor";

import {
	createRichTextFn,
	deleteRichTextFn,
	richTextDocFn,
	richTextUsageFn,
	updateRichTextFn,
	type RichTextDocWire,
	type RichTextMetaWire,
} from "../fns.ts";
import { I18N_NAMESPACE, richTextMessages, type RichTextMessages } from "../i18n.ts";
import { isRichTextEmpty } from "../value.ts";
import { RichTextDeleteDialog } from "./delete-dialog.tsx";

/** List row the panel loader hands down — the `rich_text` meta narrowed
 * to id/title/updatedAt (ISO string). */
export type RichTextDocRow = RichTextMetaWire;

export interface RichTextAdminPageProps {
	readonly docs: readonly RichTextDocRow[];
	/** Discovered plugin registry — feeds the delete dialog's
	 * `dialogAction` chrome collection. */
	readonly plugins?: readonly Plugin[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

/** Editor state: `null` shows the document list; an object opens the
 * editor pane for that document (`initial` carries the full doc when it
 * was just created, so no refetch is needed). */
interface EditorView {
	readonly id: number;
	readonly initial?: RichTextDocWire;
}

/** Canonical empty document — same seed the service writes on create. */
const EMPTY_DOC: unknown = [{ type: "p", children: [{ text: "" }] }];

const SAVE_DEBOUNCE_MS = 800;
const SAVED_INDICATOR_MS = 2000;

const asValue = (content: unknown): unknown =>
	content === null || content === undefined ? EMPTY_DOC : content;

/**
 * /platform/rich-text console view: CRUD over the `rich_text` table.
 * The list view shows document metas; "New document" creates an empty
 * row server-side and opens the editor. The editor autosaves (debounced)
 * title + Plate value through the admin-gated server fns; leaving with
 * an empty document deletes the row instead of saving it. Mutations go
 * through the plugin's server fns; the loader re-runs via
 * `router.invalidate()` after writes.
 */
export function RichTextAdminPage({ docs, plugins = [], i18n, locale }: RichTextAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, richTextMessages(locale));
	const router = useRouter();
	const pathname = useLocation({ select: (l) => l.pathname });
	const locationKey = useLocation({ select: (l) => l.state.key });
	// Deep link: /platform/rich-text?doc=<id> opens that document's
	// editor directly (the pages console's "Manage rich text" link
	// targets it). Read once — the initializer can't re-run, so later
	// search changes never hijack the view state.
	const search = useSearch({ strict: false }) as { doc?: string | number };
	const [view, setView] = useState<EditorView | null>(() => {
		const raw = search.doc;
		const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
		return Number.isInteger(id) && id > 0 ? { id } : null;
	});
	const lastLocationKeyRef = useRef(locationKey);

	// There is no in-page back affordance: any committed navigation —
	// sidebar re-click, browser back, a different console page — returns
	// to the list. The editor pane's unmount flush persists or
	// deletes-when-empty on the way out.
	useEffect(() => {
		if (lastLocationKeyRef.current === locationKey) return;
		lastLocationKeyRef.current = locationKey;
		setView(null);
	}, [locationKey]);
	const [deleteTarget, setDeleteTarget] = useState<RichTextDocRow | null>(null);
	const [busy, setBusy] = useState(false);
	const [toast, setToast] = useState<ToastData | null>(null);

	const showToast = (text: string) => setToast({ id: Date.now(), text });

	const create = async () => {
		setBusy(true);
		try {
			const doc = await createRichTextFn({ data: {} });
			if (doc === null) {
				showToast(t.saveFailed);
				return;
			}
			setView({ id: doc.id, initial: doc });
			await router.invalidate();
		} catch {
			showToast(t.saveFailed);
		} finally {
			setBusy(false);
		}
	};

	const confirmDelete = async (actionId: string | null) => {
		/* v8 ignore next -- the confirm action only exists while the dialog is open */
		if (deleteTarget === null) return;
		setBusy(true);
		setDeleteTarget(null);
		try {
			const ok = await deleteRichTextFn({
				data: actionId === null ? { id: deleteTarget.id } : { id: deleteTarget.id, actionId },
			});
			if (ok) {
				await router.invalidate();
				showToast(t.deleted);
			} else {
				showToast(t.deleteFailed);
			}
		} catch {
			showToast(t.deleteFailed);
		} finally {
			setBusy(false);
		}
	};

	if (view !== null) {
		return (
			<PageContainer>
				<RichTextEditorPane
					key={view.id}
					id={view.id}
					initial={view.initial}
					plugins={plugins}
					pathname={pathname}
					t={t}
					onExit={() => {
						setView(null);
						void router.invalidate();
					}}
					onToast={showToast}
				/>
				<Toast toast={toast} onClose={() => setToast(null)} />
			</PageContainer>
		);
	}

	return (
		<PageContainer>
			<PageHeader
				title={t.title}
				description={t.description}
				actions={
					<Button size="sm" onClick={() => void create()} disabled={busy}>
						<PlusIcon className="size-4" />
						{t.newDoc}
					</Button>
				}
			/>
			{docs.length === 0 ? (
				<div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
					<p className="text-sm font-medium">{t.emptyTitle}</p>
					<p className="mt-1 text-sm text-muted-foreground">{t.emptyDescription}</p>
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.colTitle}</TableHead>
								<TableHead>{t.colUpdated}</TableHead>
								<TableHead className="text-right">{t.colActions}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{docs.map((row) => (
								<TableRow key={row.id}>
									<TableCell>{row.title || t.untitled}</TableCell>
									<TableCell className="text-muted-foreground">
										{new Date(row.updatedAt).toLocaleString(locale)}
									</TableCell>
									<TableCell>
										<div className="flex items-center justify-end gap-1">
											<Button
												size="sm"
												variant="ghost"
												onClick={() => setView({ id: row.id })}
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
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}

			<RichTextDeleteDialog
				doc={deleteTarget}
				plugins={plugins}
				pathname={pathname}
				t={t}
				busy={busy}
				onConfirm={(actionId) => void confirmDelete(actionId)}
				onCancel={() => setDeleteTarget(null)}
			/>
			<Toast toast={toast} onClose={() => setToast(null)} />
		</PageContainer>
	);
}

interface PaneProps {
	readonly id: number;
	/** Full document when just created — skips the `richTextDocFn` fetch. */
	readonly initial?: RichTextDocWire;
	readonly plugins: readonly Plugin[];
	readonly pathname: string;
	readonly t: RichTextMessages;
	readonly onExit: () => void;
	readonly onToast: (text: string) => void;
}

/**
 * Single-document editor: title input + `RichTextEditor`. The editor
 * exchanges sanitized HTML; we convert to the Plate value once per
 * change (`htmlToRichText`) and keep it in a ref for saving/empty
 * checks. Saves are debounced (~800ms) through a serialized promise
 * queue; leaving (any navigation or unmount) flushes pending saves — and
 * deletes the row instead when the document is empty.
 */
function RichTextEditorPane({ id, initial, plugins, pathname, t, onExit, onToast }: PaneProps) {
	const [status, setStatus] = useState<"loading" | "ready">(
		initial === undefined ? "loading" : "ready",
	);
	const [title, setTitle] = useState(initial?.title ?? "");
	// `docHtml` is computed once per document and never fed back — the
	// editor is uncontrolled after mount, so re-serializing our state on
	// every keystroke would fight the caret.
	const [docHtml, setDocHtml] = useState<string | null>(() =>
		initial === undefined ? null : richTextToHtml(asValue(initial.content) as never),
	);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
	// Toolbar delete now routes through the shared referencer-aware
	// dialog instead of deleting immediately.
	const [deleteDoc, setDeleteDoc] = useState<{ id: number; title: string } | null>(null);

	const titleRef = useRef(title);
	const valueRef = useRef<unknown>(asValue(initial?.content));
	const dirtyRef = useRef(false);
	const readyRef = useRef(initial !== undefined);
	const didExitRef = useRef(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
	const exitRef = useRef<() => void>(() => {});
	const loadCancelledRef = useRef(false);
	const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tRef = useRef(t);
	const onExitRef = useRef(onExit);
	const onToastRef = useRef(onToast);

	useEffect(() => {
		tRef.current = t;
		onExitRef.current = onExit;
		onToastRef.current = onToast;
	});

	// Fetch the document when the pane opened from the list (no `initial`).
	useEffect(() => {
		if (initial !== undefined) return;
		loadCancelledRef.current = false;
		richTextDocFn({ data: { id } })
			.then((doc) => {
				if (loadCancelledRef.current) return;
				if (doc === null) {
					onToastRef.current(tRef.current.loadFailed);
					onExitRef.current();
					return;
				}
				const content = asValue(doc.content);
				titleRef.current = doc.title;
				valueRef.current = content;
				setTitle(doc.title);
				setDocHtml(richTextToHtml(content as never));
				readyRef.current = true;
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
		// Callbacks and copy ride the refs above; `initial` is fixed for
		// the pane's lifetime (keyed remount per doc) but declared for
		// exhaustive-deps.
	}, [id, initial]);

	/** Persist title + value when dirty; failures keep `dirtyRef` set so
	 * the next change or the exit flush retries. */
	const doSave = async () => {
		if (!dirtyRef.current) return;
		setSaveState("saving");
		try {
			const res = await updateRichTextFn({
				data: {
					id,
					title: titleRef.current,
					value: JSON.stringify(valueRef.current),
				},
			});
			if (res === null) {
				setSaveState("idle");
				onToastRef.current(tRef.current.saveFailed);
				return;
			}
			dirtyRef.current = false;
			setSaveState("saved");
			if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
			savedTimerRef.current = setTimeout(() => setSaveState("idle"), SAVED_INDICATOR_MS);
		} catch {
			setSaveState("idle");
			onToastRef.current(tRef.current.saveFailed);
		}
	};

	/** Serialize saves so exit-time flushes never overlap an in-flight
	 * write. */
	const enqueueSave = () => {
		saveQueueRef.current = saveQueueRef.current.then(() => doSave());
	};

	const scheduleSave = () => {
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => enqueueSave(), SAVE_DEBOUNCE_MS);
	};

	const handleTitle = (next: string) => {
		titleRef.current = next;
		setTitle(next);
		dirtyRef.current = true;
		scheduleSave();
	};

	const handleChange = (html: string) => {
		const next = htmlToRichText(html);
		valueRef.current = next;
		dirtyRef.current = true;
		scheduleSave();
	};

	const clearTimers = () => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		if (savedTimerRef.current) {
			clearTimeout(savedTimerRef.current);
			savedTimerRef.current = null;
		}
	};

	/** Leave the editor: flush pending saves, or delete the row when the
	 * document is empty. Guarded by `didExitRef` so repeated exits can't
	 * double-run it. */
	const exitDoc = async () => {
		if (didExitRef.current) return;
		didExitRef.current = true;
		clearTimers();
		if (!readyRef.current) {
			// Still loading — nothing was edited; just leave.
			onExitRef.current();
			return;
		}
		if (isRichTextEmpty(valueRef.current)) {
			// Drain any in-flight save first so it can't resurrect the row.
			await saveQueueRef.current;
			// Referenced docs can't be deleted — the FK on referencers is
			// the backstop — so ask the hooks first and surface a clear
			// reason instead of a bare delete failure. A usage-fn failure
			// falls through to the delete attempt: the FK still protects
			// referencers, preserving the pre-hook behavior.
			let referenced = false;
			try {
				referenced = (await richTextUsageFn({ data: { id } })).length > 0;
			} catch {
				// fall through — the FK backstop decides
			}
			if (referenced) {
				onToastRef.current(tRef.current.deleteInUse);
			} else {
				try {
					const ok = await deleteRichTextFn({ data: { id } });
					onToastRef.current(ok ? tRef.current.deletedEmpty : tRef.current.deleteFailed);
				} catch {
					onToastRef.current(tRef.current.deleteFailed);
				}
			}
			onExitRef.current();
			return;
		}
		enqueueSave();
		await saveQueueRef.current;
		onExitRef.current();
	};
	/** Toolbar delete opens the shared referencer-aware dialog; the
	 * actual delete runs on confirm (regardless of content, unlike
	 * exit-with-empty). `didExitRef` is only claimed once the delete is
	 * confirmed — cancelling the dialog must not block a later exit. */
	const confirmDeleteDoc = async (actionId: string | null) => {
		setDeleteDoc(null);
		/* v8 ignore next -- the dialog closes on confirm; a second confirm can't arrive */
		if (didExitRef.current) return;
		didExitRef.current = true;
		clearTimers();
		await saveQueueRef.current;
		try {
			const ok = await deleteRichTextFn({
				data: actionId === null ? { id } : { id, actionId },
			});
			if (ok) {
				onToastRef.current(tRef.current.deleted);
				onExitRef.current();
			} else {
				onToastRef.current(tRef.current.deleteFailed);
				didExitRef.current = false;
			}
		} catch {
			onToastRef.current(tRef.current.deleteFailed);
			didExitRef.current = false;
		}
	};

	// Keep the unmount-flush entry point on the latest exitDoc closure.
	useEffect(() => {
		exitRef.current = () => {
			void exitDoc();
		};
	});

	// Unmount flush: leaving the route without an explicit exit (e.g. parent
	// navigation) still persists or deletes the document. The flush is
	// deferred one tick: React StrictMode's dev double-mount runs this
	// cleanup and immediately re-runs setup, which cancels the pending
	// flush — a real unmount never re-mounts, so it still fires.
	useEffect(() => {
		if (unmountTimerRef.current !== null) {
			clearTimeout(unmountTimerRef.current);
			unmountTimerRef.current = null;
		}
		return () => {
			unmountTimerRef.current = setTimeout(() => {
				unmountTimerRef.current = null;
				exitRef.current();
			}, 0);
		};
	}, []);

	if (status === "loading" || docHtml === null) {
		return (
			<div className="flex items-center gap-3 py-16">
				<Spinner className="size-6" />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<Input
					value={title}
					onChange={(e) => handleTitle(e.target.value)}
					placeholder={t.untitled}
					aria-label={t.fieldTitle}
					className="h-8 max-w-64"
				/>
				<span className="text-xs text-muted-foreground" aria-live="polite">
					{saveState === "saving" ? t.saving : saveState === "saved" ? t.saved : ""}
				</span>
				<Button
					variant="ghost"
					size="sm"
					className="ml-auto"
					onClick={() => setDeleteDoc({ id, title: titleRef.current })}
					aria-label={t.delete}
				>
					<Trash2Icon className="size-4 text-destructive" />
					{t.delete}
				</Button>
			</div>
			<RichTextEditor
				value={docHtml}
				onChange={handleChange}
				placeholder={t.fieldContent}
				aria-label={t.fieldContent}
			/>
			<RichTextDeleteDialog
				doc={deleteDoc}
				plugins={plugins}
				pathname={pathname}
				t={t}
				busy={false}
				onConfirm={(actionId) => void confirmDeleteDoc(actionId)}
				onCancel={() => setDeleteDoc(null)}
			/>
		</div>
	);
}
