import { useEffect, useMemo, useRef, useState } from "react";

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
								return (
									<TableCell key={l.code}>
										<button
											type="button"
											onClick={() => open(key, l.code)}
											className="flex w-full items-center gap-2 text-left"
										>
											<span className="truncate text-sm">
												{shown ?? <span className="text-muted-foreground">—</span>}
											</span>
											{cell?.draft != null && cell.draft !== "" && (
												<Badge variant="secondary">draft</Badge>
											)}
											{cell === undefined && <Badge variant="outline">missing</Badge>}
										</button>
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
