import { useMemo, useState } from "react";

import { useRouter } from "@tanstack/react-router";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
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
const scopeLabel = (m: I18nMessage): string =>
	m.scope === "global" ? "global" : `${m.scope}:${m.scopeId}`;

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
}: {
	data: DraftsPageData;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
}) {
	const router = useRouter();
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

	const run = async (m: I18nMessage, action: "publish" | "discard") => {
		const label = `${m.namespace}.${m.key} (${m.locale})`;
		setError(null);
		setNotice(null);
		setBusy(rowId(m));
		try {
			const res = (await (action === "publish"
				? i18nPublishFn({ data: messageRef(m) })
				: i18nDiscardDraftFn({ data: messageRef(m) }))) as FnResult;
			if (res?.ok === false) {
				setError(res.error ?? "denied");
				return;
			}
			setNotice(`${action === "publish" ? "Published" : "Discarded draft for"} ${label}.`);
			await router.invalidate();
		} finally {
			setBusy(null);
		}
	};

	/** Sequential bulk action over the currently visible selection. */
	const runBulk = async (action: "publish" | "discard") => {
		const rows = drafts.filter((m) => selected.has(rowId(m)));
		if (rows.length === 0) return;
		setError(null);
		setNotice(null);
		setBulkBusy(action);
		try {
			const verb = action === "publish" ? "Published" : "Discarded";
			let ok = 0;
			let failed = 0;
			let firstError: string | null = null;
			for (const m of rows) {
				const res = (await (action === "publish"
					? i18nPublishFn({ data: messageRef(m) })
					: i18nDiscardDraftFn({ data: messageRef(m) }))) as FnResult;
				if (res?.ok === false) {
					failed += 1;
					firstError ??= res.error ?? "denied";
				} else {
					ok += 1;
				}
			}
			setNotice(
				failed === 0
					? `${verb} ${ok} draft${ok === 1 ? "" : "s"}.`
					: `${verb} ${ok}, failed ${failed}${firstError !== null ? ` — ${firstError}` : ""}.`,
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
					aria-label="Select all visible drafts"
					onCheckedChange={(v) => toggleAllVisible(v === true)}
				/>
			),
			width: "2.5rem",
			render: (m) => {
				const rid = rowId(m);
				return (
					<Checkbox
						checked={selected.has(rid)}
						disabled={controlsDisabled}
						aria-label={`Select ${m.namespace}.${m.key} (${m.locale})`}
						onCheckedChange={(v) => toggleRow(rid, v === true)}
					/>
				);
			},
		},
		{
			key: "key",
			header: "Key",
			render: (m) => (
				<span>
					<span className="text-muted-foreground">{m.namespace}</span>
					<span className="font-mono text-xs">.{m.key}</span>
					{m.kind === "rich" && (
						<Badge variant="secondary" className="ml-2">
							rich
						</Badge>
					)}
				</span>
			),
		},
		{
			key: "locale",
			header: "Locale",
			render: (m) => (
				<span>
					{localeEndonym.get(m.locale) ?? m.locale}
					<span className="ml-1 font-mono text-xs text-muted-foreground">{m.locale}</span>
				</span>
			),
		},
		{
			key: "scope",
			header: "Scope",
			render: (m) => <span className="font-mono text-xs">{scopeLabel(m)}</span>,
		},
		{
			key: "value",
			header: "Live",
			render: (m) =>
				m.value !== "" ? (
					<span className="block max-w-48 truncate text-sm">{m.value}</span>
				) : (
					<span className="text-muted-foreground">—</span>
				),
		},
		{
			key: "draftValue",
			header: "Draft",
			render: (m) => (
				<span className="block max-w-48 truncate font-medium text-sm">{m.draftValue ?? ""}</span>
			),
		},
		{
			key: "updatedAt",
			header: "Updated",
			render: (m) => (
				<span className="text-xs text-muted-foreground">{m.updatedAt.toLocaleDateString()}</span>
			),
		},
	];

	const rowActions = (m: I18nMessage) => {
		const disabled = controlsDisabled;
		return (
			<div className="flex gap-2">
				<Button size="sm" disabled={disabled} onClick={() => void run(m, "publish")}>
					Publish
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => void run(m, "discard")}
				>
					Discard
				</Button>
			</div>
		);
	};

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title="Pending drafts"
				description="Staged edits awaiting publish — nothing here is live yet."
			/>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			{notice !== null && <p className="text-sm text-muted-foreground">{notice}</p>}
			<TablePage.Toolbar
				search={
					<SearchInput
						value={query.q}
						onChange={query.setQ}
						placeholder="Filter by namespace.key"
						aria-label="Filter by namespace.key"
					/>
				}
				actions={
					selectedCount > 0 ? (
						<>
							<Button size="sm" disabled={controlsDisabled} onClick={() => void runBulk("publish")}>
								Publish {selectedCount} selected
							</Button>
							<ConfirmAction
								trigger={(open) => (
									<Button variant="outline" size="sm" disabled={controlsDisabled} onClick={open}>
										Discard {selectedCount} selected
									</Button>
								)}
								title={`Discard ${selectedCount} draft${selectedCount === 1 ? "" : "s"}?`}
								description="The selected drafts will be permanently discarded — never-published messages are deleted."
								confirmLabel="Discard"
								cancelLabel="Cancel"
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
				empty={{ title: "No pending drafts." }}
				noMatch="No pending drafts."
				locale={locale}
				rowActions={rowActions}
			/>
		</TablePage>
	);
}
