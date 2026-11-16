import { useMemo, useState } from "react";

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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import type { I18nMessage } from "../schema.ts";
import type { LocaleInfo, NamespaceInfo } from "../contract.ts";
import { i18nDiscardDraftFn, i18nPublishFn, i18nSaveDraftFn } from "../fns.ts";

export interface I18nPageData {
	readonly namespaces: readonly NamespaceInfo[];
	readonly locales: readonly LocaleInfo[];
	readonly messages: readonly I18nMessage[];
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
	readonly cell: Cell | undefined;
}

const cellFor = (
	messages: readonly I18nMessage[],
	namespace: string,
	key: string,
	locale: string,
): Cell | undefined => {
	const row = messages.find(
		(m) =>
			m.namespace === namespace &&
			m.key === key &&
			m.locale === locale &&
			m.scope === "global" &&
			m.scopeId === "",
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
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const locales = useMemo(() => data.locales.filter((l) => l.enabled), [data.locales]);
	const nsMessages = useMemo(
		() => data.messages.filter((m) => m.namespace === namespace && m.scope === "global"),
		[data.messages, namespace],
	);
	const keys = useMemo(() => [...new Set(nsMessages.map((m) => m.key))].sort(), [nsMessages]);

	const open = (key: string, locale: string) => {
		const cell = cellFor(data.messages, namespace, key, locale);
		setEditing({ namespace, key, locale, cell });
		setDraft(cell?.draft ?? cell?.live ?? "");
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
		} finally {
			setBusy(false);
		}
	};

	const id = editing
		? {
				namespace: editing.namespace,
				key: editing.key,
				locale: editing.locale,
				scope: "global" as const,
				scopeId: "",
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
								const cell = cellFor(data.messages, namespace, key, l.code);
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
								No messages in this namespace yet.
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
							{editing?.locale} · {editing?.cell?.kind ?? "text"}
							{editing?.cell?.draft != null && editing.cell.draft !== "" && " · draft pending"}
						</DialogDescription>
					</DialogHeader>
					<Textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						rows={6}
						className="font-mono text-sm"
					/>
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
										data: { ...id, value: draft, kind: editing?.cell?.kind ?? "text" },
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
