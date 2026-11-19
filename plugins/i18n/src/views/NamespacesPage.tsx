import { useMemo, useRef, useState } from "react";

import { PSEUDO_LOCALE } from "@ktb/i18n";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { viewsMessages } from "@ktb/views";
import { SearchInput, TablePage, useTableQuery, type Column } from "@ktb/views/table";

import type { LocaleInfo, NamespaceCoverage, NamespaceInfo } from "../contract.ts";
import { i18nMissingKeysFn } from "../fns.ts";

export interface NamespacesPageData {
	readonly namespaces: readonly NamespaceInfo[];
	readonly coverage: readonly NamespaceCoverage[];
	readonly locales: readonly LocaleInfo[];
}

interface NamespaceRow {
	readonly namespace: string;
	readonly pluginId: string;
	readonly defaultLocale: string;
	readonly keyCount: number;
	readonly translated: Readonly<Record<string, number>> | undefined;
	readonly manifestDrift: NamespaceCoverage["manifestDrift"];
}

type SortMode = "name" | "worst" | "keys";

/** Which namespace+locale cell opened the missing-keys dialog. */
interface MissingTarget {
	readonly namespace: string;
	readonly locale: string;
	readonly localeLabel: string;
}

type MissingState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: string }
	| { readonly status: "ready"; readonly keys: readonly string[] };

const pctOf = (translated: number, keyCount: number): number =>
	Math.round((translated / keyCount) * 100);

/** A row is incomplete when at least one enabled locale is below
 * full coverage — the same notion the summary's per-locale count
 * uses, rolled up to the row. Zero-key rows have nothing to
 * translate, so they count as complete. */
const isIncomplete = (row: NamespaceRow, locales: readonly LocaleInfo[]): boolean =>
	row.keyCount > 0 && locales.some((l) => (row.translated?.[l.code] ?? 0) < row.keyCount);

/** Worst per-locale coverage on the row (0–100); zero-key rows
 * sort as fully covered. */
const worstPct = (row: NamespaceRow, locales: readonly LocaleInfo[]): number => {
	if (row.keyCount === 0) return 100;
	return Math.min(...locales.map((l) => pctOf(row.translated?.[l.code] ?? 0, row.keyCount)));
};

/** Heatmap tint for a coverage cell — subtle warning washes only;
 * full coverage stays untinted. */
const cellTint = (pct: number): string =>
	pct < 50 ? "bg-warning/15" : pct < 100 ? "bg-warning/5" : "";

/** Namespace-substring predicate for `useTableQuery` — module-level so
 * the `search` config object stays referentially stable. */
const matchesNamespace = (row: NamespaceRow, needle: string): boolean =>
	row.namespace.toLowerCase().includes(needle);

/**
 * /platform/i18n/namespaces — per-namespace translation coverage
 * (global scope). Read-only: namespaces come from the plugin
 * manifests, coverage from the published/draft message rows. The
 * two lists can disagree (a namespace may have rows but no manifest
 * entry, or vice versa), so rows are the union of both, sorted by
 * namespace name; coverage rows win on pluginId/defaultLocale when
 * the manifest side is missing. Rows also carry the manifest-drift
 * verdict from coverage(): "yes" renders a warning badge.
 *
 * Coverage cells with missing keys are clickable: the dialog lists
 * the exact missing key names via i18nMissingKeysFn. A toolbar
 * filters by namespace substring, hides fully-covered rows, and
 * re-sorts by name / worst coverage / key count.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell, `SearchInput` + `useTableQuery` substring search, `Column`
 * model with per-locale coverage columns. The heatmap tint wraps the
 * cell content (`-m-2 p-2` bleeds into the kit cell's padding) because
 * `Column` has no per-cell className hook. The missing-keys dialog
 * stays plugin-local — the kit's dialogs model forms/collections,
 * not a fetched key list.
 */
export function NamespacesPage({
	data,
	locale = "en",
}: {
	data: NamespacesPageData;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
}) {
	// qps is pseudo-localized at slice time — it has no stored rows,
	// so it would render as an all-"missing" column. Keep it out,
	// same as the messages matrix.
	const locales = useMemo(
		() => data.locales.filter((l) => l.enabled && l.code !== PSEUDO_LOCALE),
		[data.locales],
	);

	const rows = useMemo<readonly NamespaceRow[]>(() => {
		const nsByName = new Map(data.namespaces.map((n) => [n.namespace, n]));
		const covByName = new Map(data.coverage.map((c) => [c.namespace, c]));
		const names = [...new Set([...nsByName.keys(), ...covByName.keys()])].sort();
		return names.map((name) => {
			const ns = nsByName.get(name);
			const cov = covByName.get(name);
			return {
				namespace: name,
				pluginId: ns?.pluginId ?? cov?.pluginId ?? "",
				defaultLocale: ns?.defaultLocale ?? cov?.defaultLocale ?? "",
				keyCount: cov?.keyCount ?? ns?.messageCount ?? 0,
				translated: cov?.translated,
				manifestDrift: cov?.manifestDrift ?? "unrecorded",
			};
		});
	}, [data.namespaces, data.coverage]);

	const [incompleteOnly, setIncompleteOnly] = useState(false);
	const [sort, setSort] = useState<SortMode>("name");
	const [missingFor, setMissingFor] = useState<MissingTarget | null>(null);
	const [missingState, setMissingState] = useState<MissingState>({ status: "loading" });
	// Stale-response guard: a second cell click while the first fetch
	// is in flight must not overwrite the newer dialog's state.
	const missingSeq = useRef(0);

	const search = useMemo(() => ({ predicate: matchesNamespace }), []);
	const query = useTableQuery<NamespaceRow>({
		rows,
		rowKey: (r) => r.namespace,
		search,
	});

	const summary = useMemo(() => {
		const totalKeys = rows.reduce((acc, r) => acc + r.keyCount, 0);
		// A locale counts as incomplete when at least one namespace
		// has keys missing a published live value for it.
		const incompleteLocales = locales.filter((l) =>
			rows.some((r) => {
				if (r.keyCount === 0) return false;
				return (r.translated?.[l.code] ?? 0) < r.keyCount;
			}),
		).length;
		const drifted = rows.filter((r) => r.manifestDrift === "yes").length;
		return { totalKeys, incompleteLocales, drifted };
	}, [rows, locales]);

	const visibleRows = useMemo(() => {
		let list = query.rows;
		if (incompleteOnly) {
			list = list.filter((r) => isIncomplete(r, locales));
		}
		if (sort === "name") return list;
		const sorted = [...list];
		if (sort === "worst") {
			sorted.sort(
				(a, b) =>
					worstPct(a, locales) - worstPct(b, locales) || a.namespace.localeCompare(b.namespace),
			);
		} else {
			sorted.sort((a, b) => b.keyCount - a.keyCount || a.namespace.localeCompare(b.namespace));
		}
		return sorted;
	}, [query.rows, locales, incompleteOnly, sort]);

	const openMissing = (row: NamespaceRow, locale: LocaleInfo) => {
		setMissingFor({
			namespace: row.namespace,
			locale: locale.code,
			localeLabel: locale.endonym,
		});
		setMissingState({ status: "loading" });
		const seq = ++missingSeq.current;
		void i18nMissingKeysFn({ data: { namespace: row.namespace, locale: locale.code } }).then(
			(res) => {
				if (missingSeq.current !== seq) return;
				const r = res as { ok?: boolean; keys?: unknown; error?: string } | null;
				if (r?.ok === true && Array.isArray(r.keys)) {
					setMissingState({ status: "ready", keys: r.keys as readonly string[] });
				} else {
					setMissingState({ status: "error", error: r?.error ?? "denied" });
				}
			},
		);
	};

	const columns: readonly Column<NamespaceRow>[] = [
		{
			key: "namespace",
			header: "Namespace",
			render: (row) => (
				<span className="inline-flex items-center gap-2 font-mono text-xs">
					{row.namespace}
					{row.manifestDrift === "yes" && (
						<Badge variant="secondary" className="font-sans text-warning">
							contract changed
						</Badge>
					)}
				</span>
			),
		},
		{
			key: "pluginId",
			header: "Plugin",
			render: (row) =>
				row.pluginId === "" ? (
					"—"
				) : (
					<span className="text-xs text-muted-foreground">{row.pluginId}</span>
				),
		},
		{
			key: "defaultLocale",
			header: "Default locale",
			render: (row) =>
				row.defaultLocale === "" ? (
					<span className="text-muted-foreground">—</span>
				) : (
					<span className="font-mono text-xs">{row.defaultLocale}</span>
				),
		},
		{ key: "keyCount", header: "Keys" },
		...locales.map((l): Column<NamespaceRow> => ({
			key: `coverage.${l.code}`,
			header: l.endonym,
			render: (row) => {
				if (row.keyCount === 0) {
					return <span className="text-muted-foreground">—</span>;
				}
				const translated = row.translated?.[l.code] ?? 0;
				const pct = pctOf(translated, row.keyCount);
				const missing = row.keyCount - translated;
				const content = (
					<>
						<span
							className="mb-1 block h-1 w-full overflow-hidden rounded-full bg-muted"
							aria-hidden="true"
						>
							<span
								className={`block h-full rounded-full ${pct === 100 ? "bg-success" : "bg-warning"}`}
								style={{ width: `${pct}%` }}
							/>
						</span>
						<span className="flex flex-col">
							<span className={pct === 100 ? "text-sm" : "text-sm text-warning"}>
								{translated}/{row.keyCount} · {pct}%
							</span>
							{missing > 0 && (
								<span className="text-xs text-muted-foreground">· {missing} missing</span>
							)}
						</span>
					</>
				);
				return (
					// The kit cell pads p-2; the negative margin + matching
					// padding reproduces the old td-level heatmap tint.
					<div className={`-m-2 p-2 ${cellTint(pct)}`}>
						{missing > 0 ? (
							<button
								type="button"
								onClick={() => openMissing(row, l)}
								className="block w-full cursor-pointer text-left"
								aria-label={`Show ${missing} missing ${row.namespace} keys for ${l.endonym}`}
							>
								{content}
							</button>
						) : (
							content
						)}
					</div>
				);
			},
		})),
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title="Namespaces"
				description="Registered message namespaces and per-locale translation coverage (global scope)."
			/>
			{rows.length > 0 && (
				<p className="text-sm text-muted-foreground">
					{rows.length} {rows.length === 1 ? "namespace" : "namespaces"} · {summary.totalKeys}{" "}
					{summary.totalKeys === 1 ? "key" : "keys"} · {summary.incompleteLocales}{" "}
					{summary.incompleteLocales === 1 ? "locale" : "locales"} below full coverage
					{summary.drifted > 0 &&
						` · ${summary.drifted} ${summary.drifted === 1 ? "namespace" : "namespaces"} with contract drift`}
				</p>
			)}
			{rows.length > 0 && (
				<TablePage.Toolbar
					search={
						<SearchInput
							value={query.q}
							onChange={query.setQ}
							placeholder="Filter namespaces"
							aria-label="Filter namespaces"
						/>
					}
					filters={
						<>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={incompleteOnly}
									onCheckedChange={(v) => setIncompleteOnly(v === true)}
									aria-label="Below 100% only"
								/>
								Below 100% only
							</label>
							<Select value={sort} onValueChange={(v) => setSort(String(v) as SortMode)}>
								<SelectTrigger className="w-44">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="name">Sort: name</SelectItem>
									<SelectItem value="worst">Sort: worst coverage</SelectItem>
									<SelectItem value="keys">Sort: most keys</SelectItem>
								</SelectContent>
							</Select>
						</>
					}
				/>
			)}
			<TablePage.Table
				columns={columns}
				rows={visibleRows}
				rowKey={(r) => r.namespace}
				total={rows.length}
				isFiltered={rows.length > 0 && (query.isFiltered || incompleteOnly)}
				empty={{ title: "No namespaces registered." }}
				noMatch="No namespaces match the current filters."
				locale={locale}
			/>
			<Dialog
				open={missingFor !== null}
				onOpenChange={(o) => {
					if (!o) {
						missingSeq.current += 1;
						setMissingFor(null);
					}
				}}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle className="font-mono text-sm">
							{missingFor !== null ? `${missingFor.namespace} · ${missingFor.locale}` : ""}
						</DialogTitle>
						<DialogDescription>
							{missingFor !== null ? `Keys with no published ${missingFor.localeLabel} value.` : ""}
						</DialogDescription>
					</DialogHeader>
					{missingState.status === "loading" && (
						<p className="text-sm text-muted-foreground">Loading…</p>
					)}
					{missingState.status === "error" && (
						<p className="text-sm text-destructive">{missingState.error}</p>
					)}
					{missingState.status === "ready" &&
						(missingState.keys.length === 0 ? (
							<p className="text-sm text-muted-foreground">All keys translated.</p>
						) : (
							<ul className="max-h-80 overflow-y-auto rounded-md border font-mono text-xs">
								{missingState.keys.map((key) => (
									<li key={key} className="border-b px-3 py-1.5 last:border-b-0">
										{key}
									</li>
								))}
							</ul>
						))}
				</DialogContent>
			</Dialog>
		</TablePage>
	);
}
