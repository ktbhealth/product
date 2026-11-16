import { useEffect, useMemo, useRef, useState } from "react";

import { useRouter } from "@tanstack/react-router";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
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

import { parseMessage, renderMessage } from "@ktb/i18n";

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

export interface I18nPageData {
	readonly namespaces: readonly NamespaceInfo[];
	readonly locales: readonly LocaleInfo[];
}

interface Cell {
	readonly draft: string | null;
	readonly live: string;
	readonly status: "draft" | "published";
	readonly kind: string;
}

interface Editing {
	readonly namespace: string;
	readonly key: string;
	readonly locale: string;
	readonly scope: "global" | "tenant" | "portal";
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

const cellFor = (
	messages: readonly I18nMessage[],
	namespace: string,
	key: string,
	locale: string,
	scope: "global" | "tenant" | "portal" = "global",
	scopeId = "",
): Cell | undefined => {
	const row = messages.find(
		(m) =>
			m.namespace === namespace &&
			m.key === key &&
			m.locale === locale &&
			m.scope === scope &&
			m.scopeId === scopeId,
	);
	if (row === undefined) return undefined;
	return {
		draft: row.draftValue,
		live: row.value,
		status: row.status,
		kind: row.kind,
	};
};

/**
 * /platform/i18n matrix (PL-008 Phase 3 v1): rows = message keys of the
 * selected namespace, columns = enabled locales, global scope. A cell
 * edits through a dialog — save stages `draft_value`, publish moves it
 * live. Tenant/portal scopes and the Streamdown param-chip preview land
 * in the follow-up polish commit.
 */
export function I18nPage({ data }: { data: I18nPageData }) {
	const router = useRouter();
	const [namespace, setNamespace] = useState(data.namespaces[0]?.namespace ?? "");
	const [editing, setEditing] = useState<Editing | null>(null);
	const [draft, setDraft] = useState("");
	const [kind, setKind] = useState<"text" | "rich">("text");
	const [scopeId, setScopeId] = useState("");
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	// Message rows are fetched per selected namespace — the loader only
	// ships namespaces + locales so the whole table never hits the wire.
	const [fetched, setFetched] = useState<{
		readonly ns: string;
		readonly rows: readonly I18nMessage[];
	}>({ ns: "", rows: [] });

	const refresh = () =>
		i18nNamespaceMessagesFn({ data: namespace }).then((res) => {
			if (Array.isArray(res)) setFetched({ ns: namespace, rows: res });
		});

	useEffect(() => {
		if (namespace === "") return;
		let live = true;
		setLoading(true);
		i18nNamespaceMessagesFn({ data: namespace })
			.then((res) => {
				if (live && Array.isArray(res)) setFetched({ ns: namespace, rows: res });
			})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [namespace]);

	const messages = fetched.ns === namespace ? fetched.rows : [];

	const locales = useMemo(() => data.locales.filter((l) => l.enabled), [data.locales]);
	const nsMessages = useMemo(
		() => messages.filter((m) => m.namespace === namespace && m.scope === "global"),
		[messages, namespace],
	);
	const keys = useMemo(() => [...new Set(nsMessages.map((m) => m.key))].sort(), [nsMessages]);

	const open = (key: string, locale: string) => {
		const cell = cellFor(messages, namespace, key, locale);
		setEditing({ namespace, key, locale, scope: "global", scopeId: "", cell });
		setDraft(cell?.draft ?? cell?.live ?? "");
		setKind(cell?.kind === "rich" ? "rich" : "text");
		setScopeId("");
		setError(null);
	};

	/** Re-target the dialog at another scope's cell for the same
	 * namespace/key/locale (PL-008 Phase 6 scope editing). */
	const retarget = (scope: "global" | "tenant" | "portal", nextScopeId: string) => {
		if (editing === null) return;
		const cell = cellFor(
			messages,
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
				title="Translations"
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
						void file.text().then(async (text) => {
							setBusy(true);
							setError(null);
							try {
								const payload = JSON.parse(text) as unknown;
								const res = (await i18nImportFn({ data: payload })) as {
									ok?: boolean;
									error?: string;
								} | null;
								if (res?.ok === false) {
									setError(res.error ?? "import denied");
									return;
								}
								await router.invalidate();
								await refresh();
							} catch {
								setError("invalid JSON file");
							} finally {
								setBusy(false);
							}
						});
					}}
				/>
			</div>
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
								const cell = cellFor(messages, namespace, key, l.code);
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
								{loading ? "Loading…" : "No messages in this namespace yet."}
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>

			<Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
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
								const scope = String(v) as "global" | "tenant" | "portal";
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
		</PageContainer>
	);
}
