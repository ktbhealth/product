import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { useRouter } from "@tanstack/react-router";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { ConfirmDialog } from "@ktbhealth/ui/components/confirm-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { RichTextEditor } from "@ktbhealth/ui/components/rich-text-editor";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import { PSEUDO_LOCALE, parseMessage, renderMessage } from "@ktb/i18n";

import type { I18nMessage } from "../schema.ts";
import type { LocaleInfo, NamespaceInfo } from "../contract.ts";
import {
	i18nDiscardDraftFn,
	i18nExportFn,
	i18nImportFn,
	i18nNamespaceMessagesFn,
	i18nPublishFn,
	i18nSaveDraftFn,
} from "../fns.ts";
import {
	buildCellIndex,
	cellFor,
	isDraftDirty,
	summarizeImportPayload,
	type Cell,
	type ImportSummary,
	type MessageScope,
} from "./i18n-page-utils.ts";

/** Sentinel Select value for the compare picker's "None" option —
 * locale codes can't collide with it. */
const COMPARE_NONE = "__none__";

/** Single-click opens the cell dialog after a beat so a double-click
 * on an editable text cell can win the race and start inline editing
 * instead (the dialog would otherwise cover the second click). */
const CELL_OPEN_DELAY_MS = 250;

/** Ref-map key for one matrix cell button — unit-separator join so a
 * key or locale containing common punctuation can't collide. */
const cellDomId = (key: string, locale: string): string => `${key}\u001f${locale}`;

/** Param names referenced by a template. `parseMessage` yields the
 * exact signature for well-formed templates; the regex fallback still
 * lints drafts mid-edit that don't parse yet (the preview surfaces
 * the parse error separately). */
const extractParamNames = (template: string): ReadonlySet<string> => {
	const parsed = parseMessage("text", template);
	if (parsed.ok) return new Set(parsed.message.params.map((p) => p.name));
	const names = new Set<string>();
	for (const m of template.matchAll(/\{(\w+)(?=[,}])/g)) {
		if (m[1] !== undefined) names.add(m[1]);
	}
	return names;
};

interface CellEdit {
	readonly key: string;
	readonly locale: string;
	readonly value: string;
}

interface ParamLint {
	readonly extra: readonly string[];
	readonly missing: readonly string[];
	readonly label: string;
}

export interface I18nPageData {
	readonly namespaces: readonly NamespaceInfo[];
	readonly locales: readonly LocaleInfo[];
}

interface Editing {
	readonly namespace: string;
	readonly key: string;
	readonly locale: string;
	readonly scope: MessageScope;
	readonly scopeId: string;
	readonly cell: Cell | undefined;
}

/** Sample value per param hint for the live preview (PL-008): real
 * `Intl.*` formatting so number/date/list hints render as they will
 * in the app. */
const sampleParam = (param: {
	readonly name: string;
	readonly hint?: string;
	readonly cases?: readonly string[];
	readonly plural?: boolean;
}): unknown => {
	if (param.plural === true) return 3;
	if (param.cases !== undefined) return param.cases.find((c) => c !== "other") ?? "other";
	switch (param.hint) {
		case "number":
			return 1234.5;
		case "date":
		case "datetime":
			return new Date(Date.now() + 86_400_000);
		case "relative":
			return new Date(Date.now() + 172_800_000);
		case "list":
			return ["Alpha", "Beta"];
		default:
			return "sample";
	}
};

/** Live preview under the editor: text kinds render with sample params
 * plus a chip per declared param; rich kinds round-trip through the
 * editor's sanitizer read-only. */
function MessagePreview({
	template,
	kind,
	locale,
}: {
	readonly template: string;
	readonly kind: "text" | "rich";
	readonly locale: string;
}) {
	if (kind === "rich") {
		return <RichTextEditor value={template} disabled aria-label="Rich text preview" />;
	}
	const parsed = parseMessage("text", template);
	if (!parsed.ok) {
		return <p className="text-sm text-destructive">{parsed.error}</p>;
	}
	const samples = Object.fromEntries(parsed.message.params.map((p) => [p.name, sampleParam(p)]));
	return (
		<div className="space-y-2">
			<p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
				{renderMessage(template, samples, locale)}
			</p>
			{parsed.message.params.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{parsed.message.params.map((p) => (
						<Badge key={p.name} variant="outline" className="font-mono text-xs">
							{`{${p.name}}`}
							{p.hint !== undefined && ` · ${p.hint}`}
							{p.plural === true && " · plural"}
							{p.cases !== undefined && !p.plural && " · select"}
						</Badge>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * /platform/i18n matrix (PL-008 Phase 3 v1 + Phase 6 scope editing):
 * rows = message keys of the selected namespace, columns = enabled
 * locales (qps excluded — it's derived at slice time, not stored).
 * A scope selector picks which scope rows the matrix edits; tenant /
 * portal need a scope id (exact match — an empty id would only match
 * rows literally keyed "", so the fetch waits for input). A cell edits
 * through a dialog — save stages `draft_value`, publish moves it live.
 * Text-kind cells also edit inline on double-click.
 */
export function I18nPage({ data }: { data: I18nPageData }) {
	const router = useRouter();
	const [namespace, setNamespace] = useState(data.namespaces[0]?.namespace ?? "");
	const [filterScope, setFilterScope] = useState<MessageScope>("global");
	const [filterScopeId, setFilterScopeId] = useState("");
	const [editing, setEditing] = useState<Editing | null>(null);
	const [draft, setDraft] = useState("");
	const [kind, setKind] = useState<"text" | "rich">("text");
	const [scopeId, setScopeId] = useState("");
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [pendingImport, setPendingImport] = useState<{
		readonly payload: unknown;
		readonly summary: ImportSummary;
	} | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	// Locale picked in the edit dialog's "Compare with" select — ""
	// hides the reference panel.
	const [compareLocale, setCompareLocale] = useState("");
	// Inline matrix edit in flight (text cells only).
	const [cellEdit, setCellEdit] = useState<CellEdit | null>(null);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cellEditBusy = useRef(false);
	// Roving-focus grid: exactly one cell button is tabbable; arrows
	// move DOM focus across key rows × locale columns.
	const [activeCell, setActiveCell] = useState<{ key: string; locale: string } | null>(null);
	const cellButtons = useRef(new Map<string, HTMLButtonElement>());
	// Cancel a pending deferred cell-open on unmount.
	useEffect(
		() => () => {
			if (openTimer.current !== null) clearTimeout(openTimer.current);
		},
		[],
	);
	// Message rows are fetched per selected namespace + scope — the
	// loader only ships namespaces + locales so the table never hits
	// the wire wholesale.
	const [fetched, setFetched] = useState<{
		readonly ns: string;
		readonly scope: MessageScope;
		readonly scopeId: string;
		readonly rows: readonly I18nMessage[];
	}>({ ns: "", scope: "global", scopeId: "", rows: [] });

	/** scopeId is an exact-match column: "" is meaningful only for
	 * global, so tenant/portal fetches wait for a non-empty id. */
	const scopeReady = filterScope === "global" || filterScopeId !== "";
	const fetchScopeId = filterScope === "global" ? "" : filterScopeId;

	const refresh = () => {
		if (!scopeReady) return Promise.resolve();
		return i18nNamespaceMessagesFn({
			data: { namespace, scope: filterScope, scopeId: fetchScopeId },
		}).then((res) => {
			if (Array.isArray(res)) {
				setFetched({ ns: namespace, scope: filterScope, scopeId: fetchScopeId, rows: res });
			}
		});
	};

	useEffect(() => {
		if (namespace === "" || !scopeReady) return;
		let live = true;
		setLoading(true);
		void i18nNamespaceMessagesFn({
			data: { namespace, scope: filterScope, scopeId: fetchScopeId },
		})
			.then((res) => {
				if (live && Array.isArray(res)) {
					setFetched({ ns: namespace, scope: filterScope, scopeId: fetchScopeId, rows: res });
				}
			})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [namespace, filterScope, fetchScopeId, scopeReady]);

	const messages = useMemo(
		() =>
			fetched.ns === namespace && fetched.scope === filterScope && fetched.scopeId === fetchScopeId
				? fetched.rows
				: [],
		[fetched, namespace, filterScope, fetchScopeId],
	);

	// qps is pseudo-localized at slice time — it has no stored rows, so
	// it would render as an all-"missing" column. Keep it out of the
	// editable matrix; enabled-locale filtering is otherwise unchanged.
	const locales = useMemo(
		() => data.locales.filter((l) => l.enabled && l.code !== PSEUDO_LOCALE),
		[data.locales],
	);
	const nsMessages = useMemo(
		() =>
			messages.filter(
				(m) => m.namespace === namespace && m.scope === filterScope && m.scopeId === fetchScopeId,
			),
		[messages, namespace, filterScope, fetchScopeId],
	);
	const keys = useMemo(() => [...new Set(nsMessages.map((m) => m.key))].sort(), [nsMessages]);

	// O(1) cell lookups — the matrix maps keys × locales cells and
	// re-renders on every keystroke in the editor dialog.
	const cellIndex = useMemo(() => buildCellIndex(messages), [messages]);

	const open = (key: string, locale: string) => {
		const cell = cellFor(cellIndex, namespace, key, locale, filterScope, fetchScopeId);
		setEditing({ namespace, key, locale, scope: filterScope, scopeId: fetchScopeId, cell });
		setDraft(cell?.draft ?? cell?.live ?? "");
		setKind(cell?.kind === "rich" ? "rich" : "text");
		// The dialog's scope-id input mirrors the cell's scope id.
		setScopeId(fetchScopeId);
		setError(null);
		setCellEdit(null);
		// Compare picker defaults to the namespace default locale when
		// it's another enabled locale, else the first available one.
		const others = locales.filter((l) => l.code !== locale);
		const defaultLocale = data.namespaces.find((n) => n.namespace === namespace)?.defaultLocale;
		setCompareLocale(
			defaultLocale !== undefined && others.some((l) => l.code === defaultLocale)
				? defaultLocale
				: (others[0]?.code ?? ""),
		);
	};

	/** Single click arms a deferred dialog open; a double-click on an
	 * editable text cell cancels it and enters inline edit instead. */
	const armCellOpen = (key: string, locale: string) => {
		if (openTimer.current !== null) clearTimeout(openTimer.current);
		openTimer.current = setTimeout(() => {
			openTimer.current = null;
			open(key, locale);
		}, CELL_OPEN_DELAY_MS);
	};

	const startCellEdit = (key: string, locale: string) => {
		if (openTimer.current !== null) {
			clearTimeout(openTimer.current);
			openTimer.current = null;
		}
		const cell = cellFor(cellIndex, namespace, key, locale, filterScope, fetchScopeId);
		setCellEdit({ key, locale, value: cell?.draft ?? cell?.live ?? "" });
		setError(null);
	};

	/** Roving focus: the requested active cell may point at a
	 * key/locale that no longer exists after a namespace or scope
	 * switch — fall back to the first rendered cell so exactly one
	 * button stays tabbable (and none when the grid is empty). */
	const firstKey = keys[0];
	const firstLocale = locales[0]?.code;
	const active =
		activeCell !== null &&
		keys.includes(activeCell.key) &&
		locales.some((l) => l.code === activeCell.locale)
			? activeCell
			: firstKey !== undefined && firstLocale !== undefined
				? { key: firstKey, locale: firstLocale }
				: null;

	/** Move roving focus to a cell: update the tabbable marker AND
	 * move real DOM focus so screen readers and the next keypress
	 * land on the new cell. */
	const focusCell = (key: string, locale: string) => {
		setActiveCell({ key, locale });
		cellButtons.current.get(cellDomId(key, locale))?.focus();
	};

	/** Grid keyboard nav on a focused cell button. Enter mirrors a
	 * click and opens the edit dialog directly — the 250ms deferred
	 * arm only exists so dblclick can win for inline editing, which
	 * stays a double-click-only gesture. Arrow keys stop at grid
	 * edges; this handler never fires while typing (it lives on the
	 * cell buttons, not a container) and is inert while the dialog or
	 * an inline edit is open. */
	const onCellKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, key: string, locale: string) => {
		if (editing !== null || cellEdit !== null) return;
		if (e.key === "Enter") {
			e.preventDefault();
			open(key, locale);
			return;
		}
		const keyIndex = keys.indexOf(key);
		const localeIndex = locales.findIndex((l) => l.code === locale);
		let nextKey = key;
		let nextLocale = locale;
		if (e.key === "ArrowRight") {
			const l = locales[localeIndex + 1];
			if (l === undefined) return;
			nextLocale = l.code;
		} else if (e.key === "ArrowLeft") {
			const l = locales[localeIndex - 1];
			if (l === undefined) return;
			nextLocale = l.code;
		} else if (e.key === "ArrowDown") {
			const k = keys[keyIndex + 1];
			if (k === undefined) return;
			nextKey = k;
		} else if (e.key === "ArrowUp") {
			const k = keys[keyIndex - 1];
			if (k === undefined) return;
			nextKey = k;
		} else {
			return;
		}
		e.preventDefault();
		focusCell(nextKey, nextLocale);
	};

	/** Inline commit: same wire call as the dialog's "Save draft" for a
	 * plain text value — stages `draft_value`, nothing goes live. */
	const commitCellEdit = () => {
		const cur = cellEdit;
		if (cur === null || cellEditBusy.current) return;
		const cell = cellFor(cellIndex, namespace, cur.key, cur.locale, filterScope, fetchScopeId);
		// An unchanged value would stage a redundant draft — just close.
		if (cur.value === (cell?.draft ?? cell?.live ?? "")) {
			setCellEdit(null);
			return;
		}
		cellEditBusy.current = true;
		setBusy(true);
		setError(null);
		void (async () => {
			try {
				const res = (await i18nSaveDraftFn({
					data: {
						namespace,
						key: cur.key,
						locale: cur.locale,
						scope: filterScope,
						scopeId: fetchScopeId,
						value: cur.value,
						kind: "text",
					},
				})) as { ok?: boolean; error?: string } | null;
				if (res !== null && typeof res === "object" && res.ok === false) {
					setError(res.error ?? "denied");
					return;
				}
				setCellEdit(null);
				await router.invalidate();
				await refresh();
			} finally {
				cellEditBusy.current = false;
				setBusy(false);
			}
		})();
	};

	/** Re-target the dialog at another scope's cell for the same
	 * namespace/key/locale (PL-008 Phase 6 scope editing). */
	const retarget = (scope: MessageScope, nextScopeId: string) => {
		/* v8 ignore next -- retarget is only reachable from the open dialog's controls */
		if (editing === null) return;
		const cell = cellFor(
			cellIndex,
			editing.namespace,
			editing.key,
			editing.locale,
			scope,
			nextScopeId,
		);
		setEditing({ ...editing, scope, scopeId: nextScopeId, cell });
		setDraft(cell?.draft ?? cell?.live ?? "");
		setKind(cell?.kind === "rich" ? "rich" : "text");
		setError(null);
	};

	const run = async (op: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			const res = (await op()) as { ok?: boolean; error?: string } | null;
			if (res !== null && typeof res === "object" && res.ok === false) {
				setError(res.error ?? "denied");
				return;
			}
			setEditing(null);
			await router.invalidate();
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	/** Confirmed import: the file was already parsed + summarized
	 * client-side; a foreign namespace switches the selector so the
	 * imported rows are visible (the fetch effect refetches on
	 * namespace change — same-namespace imports refresh explicitly). */
	const confirmImport = async () => {
		const pending = pendingImport;
		/* v8 ignore next -- the confirm dialog only fires onConfirm while open */
		if (pending === null) return;
		setBusy(true);
		setError(null);
		try {
			const res = (await i18nImportFn({ data: pending.payload })) as {
				ok?: boolean;
				error?: string;
				imported?: number;
			} | null;
			if (res?.ok === false) {
				setError(res.error ?? "import denied");
				return;
			}
			const target = pending.summary.namespace;
			setNotice(`Imported ${res?.imported ?? pending.summary.entryCount} entries into ${target}.`);
			setPendingImport(null);
			await router.invalidate();
			if (target === namespace) {
				await refresh();
			} else {
				setNamespace(target);
			}
		} finally {
			setBusy(false);
		}
	};

	// Locales the compare picker can offer — every enabled non-qps
	// locale except the one being edited.
	const compareOptions = useMemo(
		() => (editing === null ? [] : locales.filter((l) => l.code !== editing.locale)),
		[editing, locales],
	);
	const compareCell =
		editing !== null && compareLocale !== ""
			? cellFor(
					cellIndex,
					editing.namespace,
					editing.key,
					compareLocale,
					editing.scope,
					editing.scopeId,
				)
			: undefined;
	const compareShown = compareCell?.draft ?? compareCell?.live ?? null;
	const compareInfo =
		compareLocale === "" ? undefined : locales.find((l) => l.code === compareLocale);

	/** Param lint: draft params vs the row's LIVE value (same
	 * namespace/key/locale/scope). Never-published rows carry an empty
	 * live value — fall back to the namespace default locale's live
	 * value, else skip. Non-blocking: warnings never gate saving. */
	const paramLint = useMemo((): ParamLint | null => {
		if (editing === null) return null;
		const live = editing.cell?.live;
		let reference: string | null = null;
		let label = "live value";
		if (live !== undefined && live !== "") {
			reference = live;
		} else {
			const defaultLocale = data.namespaces.find(
				(n) => n.namespace === editing.namespace,
			)?.defaultLocale;
			if (defaultLocale !== undefined && defaultLocale !== "" && defaultLocale !== editing.locale) {
				const defCell = cellFor(
					cellIndex,
					editing.namespace,
					editing.key,
					defaultLocale,
					editing.scope,
					editing.scopeId,
				);
				if (defCell !== undefined && defCell.live !== "") {
					reference = defCell.live;
					label = `${defaultLocale} live value`;
				}
			}
		}
		if (reference === null) return null;
		const draftParams = extractParamNames(draft);
		const refParams = extractParamNames(reference);
		const extra = [...draftParams].filter((p) => !refParams.has(p)).sort();
		const missing = [...refParams].filter((p) => !draftParams.has(p)).sort();
		if (extra.length === 0 && missing.length === 0) return null;
		return { extra, missing, label };
	}, [editing, draft, cellIndex, data.namespaces]);

	const dirty = editing !== null && isDraftDirty(draft, editing.cell);

	const id = editing
		? {
				namespace: editing.namespace,
				key: editing.key,
				locale: editing.locale,
				scope: editing.scope,
				scopeId: editing.scopeId,
			}
		: null;

	return (
		<PageContainer>
			<PageHeader
				title="Messages"
				description="DB-canonical UI copy — edits stage as drafts until published."
			/>
			<div className="mb-4 flex items-center gap-3">
				<Select value={namespace} onValueChange={(v) => setNamespace(String(v))}>
					<SelectTrigger className="w-64">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{data.namespaces.map((ns) => (
							<SelectItem key={ns.namespace} value={ns.namespace}>
								{ns.namespace} ({ns.messageCount})
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={filterScope}
					onValueChange={(v) => {
						setFilterScope(String(v) as MessageScope);
						// Scope ids don't carry across scopes — a tenant id is
						// meaningless as a portal instance id.
						setFilterScopeId("");
					}}
				>
					<SelectTrigger className="w-28">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="global">global</SelectItem>
						<SelectItem value="tenant">tenant</SelectItem>
						<SelectItem value="portal">portal</SelectItem>
					</SelectContent>
				</Select>
				{filterScope !== "global" && (
					<Input
						value={filterScopeId}
						onChange={(e) => setFilterScopeId(e.target.value)}
						placeholder={filterScope === "portal" ? "portal instance id" : "tenant id"}
						className="w-44"
					/>
				)}
				<Button
					variant="outline"
					size="sm"
					disabled={busy || namespace === ""}
					onClick={() =>
						void (async () => {
							setBusy(true);
							try {
								const payload = await i18nExportFn({ data: namespace });
								if (payload === null || typeof payload !== "object" || !("namespace" in payload)) {
									setError("export denied");
									return;
								}
								const blob = new Blob([JSON.stringify(payload, null, 2)], {
									type: "application/json",
								});
								const a = document.createElement("a");
								a.href = URL.createObjectURL(blob);
								a.download = `i18n-${namespace}.json`;
								a.click();
								URL.revokeObjectURL(a.href);
							} finally {
								setBusy(false);
							}
						})()
					}
				>
					Export
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => fileRef.current?.click()}
				>
					Import
				</Button>
				<input
					ref={fileRef}
					type="file"
					accept="application/json"
					className="hidden"
					onChange={(e) => {
						const file = e.target.files?.[0];
						e.target.value = "";
						if (!file) return;
						void file.text().then((text) => {
							setError(null);
							setNotice(null);
							let payload: unknown;
							try {
								payload = JSON.parse(text);
							} catch {
								setError("invalid JSON file");
								return;
							}
							// Preview before the wire call — the confirm dialog
							// shows namespace + counts and may retarget the
							// namespace selector on success.
							const parsed = summarizeImportPayload(payload);
							if (!parsed.ok) {
								setError(parsed.error);
								return;
							}
							setPendingImport({ payload, summary: parsed.summary });
						});
					}}
				/>
			</div>
			{error !== null && <p className="mb-3 text-sm text-destructive">{error}</p>}
			{notice !== null && <p className="mb-3 text-sm text-muted-foreground">{notice}</p>}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Key</TableHead>
						{locales.map((l) => (
							<TableHead key={l.code}>{l.endonym}</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{keys.map((key) => (
						<TableRow key={key}>
							<TableCell className="font-mono text-xs">{key}</TableCell>
							{locales.map((l) => {
								const cell = cellFor(cellIndex, namespace, key, l.code, filterScope, fetchScopeId);
								const shown = cell?.draft ?? cell?.live;
								const activeEdit =
									cellEdit !== null && cellEdit.key === key && cellEdit.locale === l.code
										? cellEdit
										: null;
								return (
									<TableCell key={l.code}>
										{activeEdit !== null ? (
											<Input
												autoFocus
												disabled={busy}
												value={activeEdit.value}
												aria-label={`Edit ${key} in ${l.code}`}
												className="h-7 font-mono text-xs"
												onChange={(e) => setCellEdit({ ...activeEdit, value: e.target.value })}
												onClick={(e) => e.stopPropagation()}
												onDoubleClick={(e) => e.stopPropagation()}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														e.preventDefault();
														commitCellEdit();
													} else if (e.key === "Escape") {
														e.preventDefault();
														e.stopPropagation();
														if (!cellEditBusy.current) setCellEdit(null);
													}
												}}
												onBlur={commitCellEdit}
											/>
										) : (
											<button
												type="button"
												ref={(el) => {
													const id = cellDomId(key, l.code);
													if (el === null) cellButtons.current.delete(id);
													else cellButtons.current.set(id, el);
												}}
												tabIndex={
													active !== null && active.key === key && active.locale === l.code ? 0 : -1
												}
												onClick={() => {
													setActiveCell({ key, locale: l.code });
													armCellOpen(key, l.code);
												}}
												onFocus={() => setActiveCell({ key, locale: l.code })}
												onKeyDown={(e) => onCellKeyDown(e, key, l.code)}
												onDoubleClick={
													cell !== undefined && cell.kind === "text"
														? () => startCellEdit(key, l.code)
														: undefined
												}
												className="flex w-full items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
											>
												<span className="truncate text-sm">
													{shown ?? <span className="text-muted-foreground">—</span>}
												</span>
												{cell?.draft != null && cell.draft !== "" && (
													<Badge variant="secondary">draft</Badge>
												)}
												{cell === undefined && <Badge variant="outline">missing</Badge>}
											</button>
										)}
									</TableCell>
								);
							})}
						</TableRow>
					))}
					{keys.length === 0 && (
						<TableRow>
							<TableCell colSpan={locales.length + 1} className="text-center text-muted-foreground">
								{loading
									? "Loading…"
									: !scopeReady
										? `Enter a ${filterScope} id to load scoped messages.`
										: "No messages in this namespace yet."}
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>

			<Dialog
				open={editing !== null}
				onOpenChange={(o) => {
					/* v8 ignore next -- open is controlled by `editing`; only close events fire */
					if (o) return;
					// Dirty drafts get a confirm before being discarded —
					// Escape/overlay/X all funnel through here.
					if (dirty) setConfirmDiscard(true);
					else setEditing(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{editing?.namespace}.{editing?.key}
						</DialogTitle>
						<DialogDescription>
							{editing?.locale} · {editing?.scope}
							{editing !== null && editing.scopeId !== "" && `:${editing.scopeId}`} · {kind}
							{editing?.cell?.draft != null && editing.cell.draft !== "" && " · draft pending"}
						</DialogDescription>
					</DialogHeader>
					<div className="flex items-center gap-2">
						<Select
							value={editing?.scope ?? "global"}
							onValueChange={(v) => {
								const scope = String(v) as MessageScope;
								retarget(scope, scope === "global" ? "" : scopeId);
							}}
						>
							<SelectTrigger className="w-32">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="global">global</SelectItem>
								<SelectItem value="tenant">tenant</SelectItem>
								<SelectItem value="portal">portal</SelectItem>
							</SelectContent>
						</Select>
						{editing !== null && editing.scope !== "global" && (
							<Input
								value={scopeId}
								onChange={(e) => setScopeId(e.target.value)}
								onBlur={() => retarget(editing.scope, scopeId)}
								placeholder={editing.scope === "portal" ? "portal instance id" : "tenant id"}
								className="w-40"
							/>
						)}
						<Select value={kind} onValueChange={(v) => setKind(String(v) as "text" | "rich")}>
							<SelectTrigger className="w-28">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="text">text</SelectItem>
								<SelectItem value="rich">rich</SelectItem>
							</SelectContent>
						</Select>
						{editing !== null && compareOptions.length > 0 && (
							<>
								<span className="text-xs text-muted-foreground">Compare with</span>
								<Select
									value={compareLocale === "" ? COMPARE_NONE : compareLocale}
									onValueChange={(v) => {
										const next = String(v);
										setCompareLocale(next === COMPARE_NONE ? "" : next);
									}}
								>
									<SelectTrigger aria-label="Compare with" className="w-36">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={COMPARE_NONE}>None</SelectItem>
										{compareOptions.map((l) => (
											<SelectItem key={l.code} value={l.code}>
												{l.endonym}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</>
						)}
					</div>
					{kind === "rich" ? (
						<RichTextEditor
							value={draft}
							/* v8 ignore next -- Plate's editor internals can't be driven in jsdom */
							onChange={(html) => setDraft(html)}
							aria-label="Message rich text"
						/>
					) : (
						<Textarea
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							rows={6}
							className="font-mono text-sm"
						/>
					)}
					<MessagePreview template={draft} kind={kind} locale={editing?.locale ?? "en"} />
					{editing !== null && compareLocale !== "" && compareInfo !== undefined && (
						<div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2">
							<p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								{compareInfo.endonym} ({compareLocale})
								{compareCell?.draft != null && compareCell.draft !== "" && (
									<Badge variant="secondary">draft</Badge>
								)}
							</p>
							{compareShown !== null && compareShown !== "" ? (
								<p className="whitespace-pre-wrap text-sm">{compareShown}</p>
							) : (
								<p className="text-sm text-muted-foreground">No translation for {compareLocale}.</p>
							)}
						</div>
					)}
					{paramLint !== null && (
						<p className="text-sm text-warning">
							Param mismatch vs {paramLint.label}:{" "}
							{paramLint.extra.length > 0 &&
								`extra: ${paramLint.extra.map((p) => `{${p}}`).join(", ")}`}
							{paramLint.extra.length > 0 && paramLint.missing.length > 0 && " · "}
							{paramLint.missing.length > 0 &&
								`missing: ${paramLint.missing.map((p) => `{${p}}`).join(", ")}`}
						</p>
					)}
					{error !== null && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						{editing?.cell?.draft != null && editing.cell.draft !== "" && (
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => id && void run(() => i18nDiscardDraftFn({ data: id }))}
							>
								Discard draft
							</Button>
						)}
						<Button
							variant="outline"
							disabled={busy}
							onClick={() =>
								id &&
								void run(() =>
									i18nSaveDraftFn({
										data: { ...id, value: draft, kind },
									}),
								)
							}
						>
							Save draft
						</Button>
						{editing?.cell?.draft != null && editing.cell.draft !== "" && (
							<Button
								disabled={busy}
								onClick={() => id && void run(() => i18nPublishFn({ data: id }))}
							>
								Publish
							</Button>
						)}
					</div>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={confirmDiscard}
				onOpenChange={setConfirmDiscard}
				title="Discard unsaved changes?"
				description="The edits in this dialog haven't been saved as a draft."
				confirmLabel="Discard"
				cancelLabel="Keep editing"
				variant="destructive"
				onConfirm={() => setEditing(null)}
			/>

			<ConfirmDialog
				open={pendingImport !== null}
				onOpenChange={(o) => {
					/* v8 ignore next -- mounted only while pendingImport; only close events fire */
					if (!o) setPendingImport(null);
				}}
				title={`Import into "${pendingImport?.summary.namespace ?? ""}"?`}
				description={
					pendingImport === null
						? undefined
						: `${pendingImport.summary.localeCount} locales · ${pendingImport.summary.keyCount} keys · ${pendingImport.summary.entryCount} entries. Matching keys land as drafts — nothing goes live.`
				}
				confirmLabel="Import"
				cancelLabel="Cancel"
				loading={busy}
				onConfirm={confirmImport}
			/>
		</PageContainer>
	);
}
