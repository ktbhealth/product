import { useMemo, useState } from "react";

import { useRouter } from "@tanstack/react-router";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { viewsMessages } from "@ktb/views";
import {
	ConfirmAction,
	SearchInput,
	TablePage,
	useTableQuery,
	type Column,
} from "@ktb/views/table";

import { i18nDiscardDraftFn, i18nPublishFn } from "../fns.ts";
import type { I18nMessage } from "../schema.ts";
import type { LocaleInfo } from "../contract.ts";
import { i18nAdminMessages, I18N_NAMESPACE } from "../i18n.ts";

export interface DraftsPageData {
	readonly drafts: readonly I18nMessage[];
	readonly locales: readonly LocaleInfo[];
}

/** Stable row id for the busy/selection state — the message PK is composite. */
const rowId = (m: I18nMessage): string =>
	[m.namespace, m.key, m.locale, m.scope, m.scopeId].join("\u001f");

/** Composite message id accepted by the publish/discard server fns. */
const messageRef = (m: I18nMessage) => ({
	namespace: m.namespace,
	key: m.key,
	locale: m.locale,
	scope: m.scope,
	scopeId: m.scopeId,
});

/** Compact scope label — global rows carry no scope id. */
const scopeLabel = (m: I18nMessage, global: string): string =>
	m.scope === "global" ? global : `${m.scope}:${m.scopeId}`;

/** Server-fn result shape shared by publish and discard. */
type FnResult = { ok?: boolean; error?: string } | null;

/** `namespace.key` substring predicate for `useTableQuery` — module-level
 * so the `search` config object stays referentially stable. */
const matchesDraft = (m: I18nMessage, needle: string): boolean =>
	`${m.namespace}.${m.key}`.toLowerCase().includes(needle);

/**
 * /platform/i18n/drafts — every row with a staged `draft_value` across
 * global scope. Drafts are edits awaiting publish: rows with
 * `status: "published"` keep a live `value` until the draft lands;
 * `status: "draft"` rows were never published, so `value` is empty and
 * the draft is the only copy. Publish promotes the draft, Discard drops
 * it (for never-published rows that deletes the message entirely).
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell, `SearchInput` + `useTableQuery` filter, `Column` model, and
 * `ConfirmAction` for the bulk discard. Row selection stays a custom
 * leading column — the kit's `selectable` checkboxes have no `disabled`
 * prop, and this page disables them while a mutation is in flight.
 * Mutations stay manual: the kit's `useServerMutation` only reports a
 * boolean and these flows surface the server's `error` string verbatim.
 */
export function DraftsPage({
	data,
	locale = "en",
	i18n,
}: {
	data: DraftsPageData;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
	/** Resolved DB-catalog slice — absent on surfaces without it. */
	i18n?: PageI18nSlice;
}) {
	const router = useRouter();
	const m = sliceMessages(i18n, I18N_NAMESPACE, i18nAdminMessages(locale));
	const [busy, setBusy] = useState<string | null>(null);
	const [bulkBusy, setBulkBusy] = useState<"publish" | "discard" | null>(null);
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const localeEndonym = useMemo(
		() => new Map(data.locales.map((l) => [l.code, l.endonym])),
		[data.locales],
	);

	const search = useMemo(() => ({ predicate: matchesDraft }), []);
	const query = useTableQuery<I18nMessage>({
		rows: data.drafts,
		rowKey: rowId,
		search,
	});
	const drafts = query.rows;

	// Selection is keyed by composite row id; counts only consider rows
	// still visible so stale ids (filtered out or refreshed away) don't
	// inflate the toolbar or block select-all.
	const selectedVisible = useMemo(
		() => drafts.filter((m) => selected.has(rowId(m))),
		[drafts, selected],
	);
	const selectedCount = selectedVisible.length;
	const allVisibleSelected = drafts.length > 0 && selectedCount === drafts.length;
	const someVisibleSelected = selectedCount > 0 && !allVisibleSelected;
	const controlsDisabled = busy !== null || bulkBusy !== null;

	const toggleRow = (id: string, on: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	};

	const toggleAllVisible = (on: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			for (const m of drafts) {
				const id = rowId(m);
				if (on) next.add(id);
				else next.delete(id);
			}
			return next;
		});
	};

	const run = async (row: I18nMessage, action: "publish" | "discard") => {
		const label = `${row.namespace}.${row.key} (${row.locale})`;
		setError(null);
		setNotice(null);
		setBusy(rowId(row));
		try {
			const res = (await (action === "publish"
				? i18nPublishFn({ data: messageRef(row) })
				: i18nDiscardDraftFn({ data: messageRef(row) }))) as FnResult;
			if (res?.ok === false) {
				setError(res.error ?? m.common.denied);
				return;
			}
			setNotice(
				action === "publish" ? m.drafts.noticePublished(label) : m.drafts.noticeDiscarded(label),
			);
			await router.invalidate();
		} finally {
			setBusy(null);
		}
	};

	/** Sequential bulk action over the currently visible selection. */
	const runBulk = async (action: "publish" | "discard") => {
		const rows = drafts.filter((row) => selected.has(rowId(row)));
		if (rows.length === 0) return;
		setError(null);
		setNotice(null);
		setBulkBusy(action);
		try {
			const verb = action === "publish" ? m.drafts.verbPublished : m.drafts.verbDiscarded;
			let ok = 0;
			let failed = 0;
			let firstError: string | null = null;
			for (const row of rows) {
				const res = (await (action === "publish"
					? i18nPublishFn({ data: messageRef(row) })
					: i18nDiscardDraftFn({ data: messageRef(row) }))) as FnResult;
				if (res?.ok === false) {
					failed += 1;
					firstError ??= res.error ?? m.common.denied;
				} else {
					ok += 1;
				}
			}
			setNotice(
				failed === 0
					? m.drafts.bulkOk(verb, ok)
					: m.drafts.bulkPartial(verb, ok, failed, firstError !== null ? ` — ${firstError}` : ""),
			);
			if (ok > 0) await router.invalidate();
			setSelected(new Set());
		} finally {
			setBulkBusy(null);
		}
	};

	const columns: Column<I18nMessage>[] = [
		{
			key: "select",
			header: (
				<Checkbox
					checked={allVisibleSelected}
					indeterminate={someVisibleSelected}
					disabled={controlsDisabled || drafts.length === 0}
					aria-label={m.drafts.selectAll}
					onCheckedChange={(v) => toggleAllVisible(v === true)}
				/>
			),
			width: "2.5rem",
			render: (row) => {
				const rid = rowId(row);
				return (
					<Checkbox
						checked={selected.has(rid)}
						disabled={controlsDisabled}
						aria-label={m.drafts.selectRow(`${row.namespace}.${row.key} (${row.locale})`)}
						onCheckedChange={(v) => toggleRow(rid, v === true)}
					/>
				);
			},
		},
		{
			key: "key",
			header: m.drafts.colKey,
			render: (row) => (
				<span>
					<span className="text-muted-foreground">{row.namespace}</span>
					<span className="font-mono text-xs">.{row.key}</span>
					{row.kind === "rich" && (
						<Badge variant="secondary" className="ml-2">
							{m.messages.kindRich}
						</Badge>
					)}
				</span>
			),
		},
		{
			key: "locale",
			header: m.drafts.colLocale,
			render: (row) => (
				<span>
					{localeEndonym.get(row.locale) ?? row.locale}
					<span className="ml-1 font-mono text-xs text-muted-foreground">{row.locale}</span>
				</span>
			),
		},
		{
			key: "scope",
			header: m.drafts.colScope,
			render: (row) => (
				<span className="font-mono text-xs">{scopeLabel(row, m.common.global)}</span>
			),
		},
		{
			key: "value",
			header: m.drafts.colLive,
			render: (row) =>
				row.value !== "" ? (
					<span className="block max-w-48 truncate text-sm">{row.value}</span>
				) : (
					<span className="text-muted-foreground">—</span>
				),
		},
		{
			key: "draftValue",
			header: m.drafts.colDraft,
			render: (row) => (
				<span className="block max-w-48 truncate font-medium text-sm">{row.draftValue ?? ""}</span>
			),
		},
		{
			key: "updatedAt",
			header: m.drafts.colUpdated,
			render: (row) => (
				<span className="text-xs text-muted-foreground">{row.updatedAt.toLocaleDateString()}</span>
			),
		},
	];

	const rowActions = (row: I18nMessage) => {
		const disabled = controlsDisabled;
		return (
			<div className="flex gap-2">
				<Button size="sm" disabled={disabled} onClick={() => void run(row, "publish")}>
					{m.common.publish}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => void run(row, "discard")}
				>
					{m.common.discard}
				</Button>
			</div>
		);
	};

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header title={m.drafts.title} description={m.drafts.description} />
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			{notice !== null && <p className="text-sm text-muted-foreground">{notice}</p>}
			<TablePage.Toolbar
				search={
					<SearchInput
						value={query.q}
						onChange={query.setQ}
						placeholder={m.drafts.filter}
						aria-label={m.drafts.filter}
					/>
				}
				actions={
					selectedCount > 0 ? (
						<>
							<Button size="sm" disabled={controlsDisabled} onClick={() => void runBulk("publish")}>
								{m.drafts.publishSelected(selectedCount)}
							</Button>
							<ConfirmAction
								trigger={(open) => (
									<Button variant="outline" size="sm" disabled={controlsDisabled} onClick={open}>
										{m.drafts.discardSelected(selectedCount)}
									</Button>
								)}
								title={m.drafts.discardTitle(selectedCount)}
								description={m.drafts.discardDesc}
								confirmLabel={m.common.discard}
								cancelLabel={m.common.cancel}
								variant="destructive"
								onConfirm={() => runBulk("discard")}
							/>
						</>
					) : undefined
				}
			/>
			<TablePage.Table
				columns={columns}
				rows={drafts}
				rowKey={rowId}
				total={data.drafts.length}
				isFiltered={query.isFiltered}
				empty={{ title: m.drafts.empty }}
				noMatch={m.drafts.noMatch}
				locale={locale}
				rowActions={rowActions}
			/>
		</TablePage>
	);
}
