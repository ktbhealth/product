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
import { Input } from "@ktbhealth/ui/components/input";
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
 */
export function NamespacesPage({ data }: { data: NamespacesPageData }) {
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

	const [filter, setFilter] = useState("");
	const [incompleteOnly, setIncompleteOnly] = useState(false);
	const [sort, setSort] = useState<SortMode>("name");
	const [missingFor, setMissingFor] = useState<MissingTarget | null>(null);
	const [missingState, setMissingState] = useState<MissingState>({ status: "loading" });
	// Stale-response guard: a second cell click while the first fetch
	// is in flight must not overwrite the newer dialog's state.
	const missingSeq = useRef(0);

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
		const needle = filter.trim().toLowerCase();
		let list = rows;
		if (needle !== "") {
			list = list.filter((r) => r.namespace.toLowerCase().includes(needle));
		}
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
	}, [rows, locales, filter, incompleteOnly, sort]);

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

	return (
		<PageContainer>
			<PageHeader
				title="Namespaces"
				description="Registered message namespaces and per-locale translation coverage (global scope)."
			/>
			{rows.length > 0 && (
				<p className="mb-3 text-sm text-muted-foreground">
					{rows.length} {rows.length === 1 ? "namespace" : "namespaces"} · {summary.totalKeys}{" "}
					{summary.totalKeys === 1 ? "key" : "keys"} · {summary.incompleteLocales}{" "}
					{summary.incompleteLocales === 1 ? "locale" : "locales"} below full coverage
					{summary.drifted > 0 &&
						` · ${summary.drifted} ${summary.drifted === 1 ? "namespace" : "namespaces"} with contract drift`}
				</p>
			)}
			{rows.length > 0 && (
				<div className="mb-3 flex flex-wrap items-center gap-3">
					<Input
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter namespaces"
						className="w-56"
					/>
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
				</div>
			)}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Namespace</TableHead>
						<TableHead>Plugin</TableHead>
						<TableHead>Default locale</TableHead>
						<TableHead>Keys</TableHead>
						{locales.map((l) => (
							<TableHead key={l.code}>{l.endonym}</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{visibleRows.map((row) => (
						<TableRow key={row.namespace}>
							<TableCell className="font-mono text-xs">
								<span className="inline-flex items-center gap-2">
									{row.namespace}
									{row.manifestDrift === "yes" && (
										<Badge variant="secondary" className="font-sans text-warning">
											contract changed
										</Badge>
									)}
								</span>
							</TableCell>
							<TableCell className="text-xs text-muted-foreground">
								{row.pluginId === "" ? "—" : row.pluginId}
							</TableCell>
							<TableCell className="font-mono text-xs">
								{row.defaultLocale === "" ? (
									<span className="text-muted-foreground">—</span>
								) : (
									row.defaultLocale
								)}
							</TableCell>
							<TableCell>{row.keyCount}</TableCell>
							{locales.map((l) => {
								if (row.keyCount === 0) {
									return (
										<TableCell key={l.code}>
											<span className="text-muted-foreground">—</span>
										</TableCell>
									);
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
									<TableCell key={l.code} className={cellTint(pct)}>
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
									</TableCell>
								);
							})}
						</TableRow>
					))}
					{visibleRows.length === 0 && rows.length > 0 && (
						<TableRow>
							<TableCell colSpan={4 + locales.length} className="text-center text-muted-foreground">
								No namespaces match the current filters.
							</TableCell>
						</TableRow>
					)}
					{rows.length === 0 && (
						<TableRow>
							<TableCell colSpan={4 + locales.length} className="text-center text-muted-foreground">
								No namespaces registered.
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
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
		</PageContainer>
	);
}
