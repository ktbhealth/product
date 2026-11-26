import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { DataToolbar } from "@ktbhealth/ui/components/data-toolbar";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
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

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { LocalDateTime } from "@ktb/views/views";

import type {
	AdminAuditRow,
	AuditFacets,
	AuditListQuery,
	AuditListResult,
	AuditVerifyResult,
} from "../index.ts";
import { auditMessages, I18N_NAMESPACE } from "../i18n.ts";

const SEARCH_CLS = "w-56 sm:w-64";
const DATE_CLS = "h-8 w-36 text-xs";
/** Debounce between keystrokes and the server-side search refetch. */
const SEARCH_DEBOUNCE_MS = 300;

/** "all" sentinel — Base UI Select items reject empty-string values. */
const ALL = "all";
/** Actor-filter sentinel for the NULL actor bucket (system rows). */
const SYSTEM_ACTOR = "system";
/** Target-type-filter sentinel for the NULL target_type bucket. */
const NO_TARGET_TYPE = "none";

interface Filters {
	q: string;
	group: string;
	actor: string;
	targetType: string;
	from: string;
	to: string;
}

const EMPTY_FILTERS: Filters = {
	q: "",
	group: ALL,
	actor: ALL,
	targetType: ALL,
	from: "",
	to: "",
};

/** Action group = first dot segment ("users.suspend" → "users"). */
const actionGroup = (action: string): string => {
	const dot = action.indexOf(".");
	return dot === -1 ? action : action.slice(0, dot);
};

const parseDetail = (raw: string | null): unknown => {
	/* v8 ignore next -- the JSON button only renders for non-null detail */
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
};

const targetLabel = (row: AdminAuditRow): string =>
	[row.targetType, row.targetId].filter((v) => v !== null && v !== "").join(":") || "";

/** Actor filter key — mirrors the actor cell's fallback chain. */
const actorKey = (row: AdminAuditRow): string => row.actorEmail ?? row.actorUserId ?? SYSTEM_ACTOR;

/** Target-type filter key; null columns bucket under this sentinel. */
const targetTypeKey = (row: AdminAuditRow): string => row.targetType ?? NO_TARGET_TYPE;

/** `YYYY-MM-DD` from a date input → local-midnight epoch ms. */
const dayStart = (value: string): number | null => {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	/* v8 ignore next -- date inputs only yield "" or YYYY-MM-DD */
	if (m === null) return null;
	const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
	/* v8 ignore next -- a valid YYYY-MM-DD always parses */
	return Number.isNaN(ms) ? null : ms;
};

/** Inclusive end-of-day for a `YYYY-MM-DD` bound. */
const dayEnd = (value: string): number | null => {
	const start = dayStart(value);
	/* v8 ignore next -- dayStart only returns null for non-YYYY-MM-DD input */
	return start === null ? null : start + 24 * 60 * 60 * 1000 - 1;
};

/** UI filters → service query. Sentinels map to the NULL buckets;
 * empty fields are omitted entirely (optionalKey semantics). */
const queryFor = (filters: Filters, limit: number, offset: number): AuditListQuery => {
	const since = filters.from === "" ? null : dayStart(filters.from);
	const until = filters.to === "" ? null : dayEnd(filters.to);
	const q = filters.q.trim();
	return {
		/* v8 ignore next -- page.limit is clamped >= 1 by the service and the
		   empty state hides the toolbar when a page carries no rows */
		...(limit > 0 ? { limit } : {}),
		offset,
		...(filters.group === ALL ? {} : { actionGroup: filters.group }),
		...(filters.actor === ALL
			? {}
			: { actor: filters.actor === SYSTEM_ACTOR ? null : filters.actor }),
		...(filters.targetType === ALL
			? {}
			: { targetType: filters.targetType === NO_TARGET_TYPE ? null : filters.targetType }),
		...(q === "" ? {} : { q }),
		...(since === null ? {} : { since }),
		...(until === null ? {} : { until }),
	};
};

interface PageState {
	readonly entries: readonly AdminAuditRow[];
	readonly total: number;
	readonly limit: number;
	readonly offset: number;
}

/**
 * Shared audit listing — /platform/audit (platform admin log),
 * /portal/<instance>/activity (actor-scoped staff feed) and
 * /portal/patient/activity (patient access log).
 *
 * Two modes. WITH `onQuery` the filters and pagination are
 * server-driven: the host's server fn re-queries the scoped listing
 * and the dropdown options come from `onFacets` (every value in
 * scope, not just the current page). WITHOUT it the component is a
 * static table: search and the action-group/actor/target-type filters
 * run client-side over the provided window — kept for tests and
 * simple mounts.
 *
 * Detail JSON is shown in a dialog — ids and non-sensitive params
 * only, by contract. Dense/utilitarian by design (system console).
 */
export function AuditPage({
	entries,
	total,
	limit,
	offset = 0,
	i18n,
	locale = "en",
	title,
	onVerify,
	onQuery,
	onFacets,
	showTenant = false,
}: {
	entries: readonly AdminAuditRow[];
	/** Total rows in the log (may exceed the capped page). */
	total: number;
	/** Page size the loader used — seeds server-mode pagination. */
	limit?: number;
	/** Offset the loader read at — seeds server-mode pagination. */
	offset?: number;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
	/** Page heading override — the staff activity feed passes its own
	 * title; defaults to the console's "Audit log" copy. */
	title?: string;
	/** Opt-in on-demand chain verification: only the platform console
	 * passes this — the staff/patient feeds never see the button.
	 * Resolves the walk result, or null when denied/absent. */
	onVerify?: () => Promise<AuditVerifyResult | null>;
	/** Server-driven re-query (filters + pagination). When present the
	 * table is server-filtered; when absent it filters client-side. */
	onQuery?: (query: AuditListQuery) => Promise<AuditListResult | null>;
	/** Distinct filter values for the dropdowns — fetched once on
	 * mount when `onQuery` is present. */
	onFacets?: () => Promise<AuditFacets | null>;
	/** Show the tenant column — only the platform console spans
	 * tenants; scoped feeds always show a single tenant. */
	showTenant?: boolean;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, auditMessages(locale));
	const server = onQuery !== undefined;
	const [page, setPage] = useState<PageState>(() => ({
		entries,
		total,
		limit: limit ?? entries.length,
		offset,
	}));
	const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
	const [facets, setFacets] = useState<AuditFacets | null>(null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const [detailFor, setDetailFor] = useState<AdminAuditRow | null>(null);
	const [verify, setVerify] = useState<{
		readonly state: "idle" | "running" | "done" | "failed";
		readonly result: AuditVerifyResult | null;
	}>({ state: "idle", result: null });
	// Latest filters for async paths (debounce, pagination) that must
	// not close over a stale render.
	const filtersRef = useRef(filters);
	filtersRef.current = filters;
	const pageLimitRef = useRef(page.limit);
	pageLimitRef.current = page.limit;
	// Request sequencing — a slow earlier query must not overwrite a
	// newer one's result when responses land out of order.
	const requestSeq = useRef(0);

	// Latest props → state sync for client-side navigations that swap
	// the loader payload without remounting the page.
	const propsKey = `${total}:${offset}:${limit ?? -1}:${entries.length}`;
	const lastPropsKey = useRef(propsKey);
	useEffect(() => {
		if (lastPropsKey.current === propsKey) return;
		lastPropsKey.current = propsKey;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the loader-data prop is the external system here
		setPage({ entries, total, limit: limit ?? entries.length, offset });
	}, [propsKey, entries, total, limit, offset]);

	const refetch = useCallback(
		async (nextFilters: Filters, nextOffset: number) => {
			/* v8 ignore next -- every caller guards on server mode */
			if (onQuery === undefined) return;
			const seq = ++requestSeq.current;
			setBusy(true);
			setFailed(false);
			try {
				const result = await onQuery(queryFor(nextFilters, pageLimitRef.current, nextOffset));
				// A newer request already landed — drop this stale response.
				if (seq !== requestSeq.current) return;
				if (result === null) {
					setFailed(true);
				} else {
					setPage({
						entries: result.entries,
						total: result.total,
						limit: result.limit,
						offset: result.offset,
					});
				}
			} catch {
				if (seq === requestSeq.current) setFailed(true);
			} finally {
				if (seq === requestSeq.current) setBusy(false);
			}
		},
		[onQuery],
	);

	/** Filter change: update state, then (server mode) re-query at
	 * offset 0 with the NEW filter values — passing them explicitly
	 * avoids the setState-not-yet-applied stale read. */
	const changeFilters = useCallback(
		(patch: Partial<Filters>) => {
			const next = { ...filtersRef.current, ...patch };
			setFilters(next);
			if (server) void refetch(next, 0);
		},
		[server, refetch],
	);

	// Facets load once — they describe the whole scoped log, not the
	// current page, so they don't refetch on filter changes.
	useEffect(() => {
		if (onFacets === undefined) return;
		let cancelled = false;
		void onFacets()
			.then((f) => {
				if (!cancelled && f !== null) setFacets(f);
			})
			.catch(() => {
				// Facets are progressive enhancement — a failed fetch
				// leaves the dropdowns on the entries-derived options.
			});
		return () => {
			cancelled = true;
		};
	}, [onFacets]);

	// Debounced free-text search → server refetch at offset 0. The
	// mount run is skipped — the loader already fetched the first
	// page; only actual text changes re-query.
	const debouncedQ = filters.q;
	const lastSearchedQ = useRef(debouncedQ);
	useEffect(() => {
		if (!server || lastSearchedQ.current === debouncedQ) return;
		lastSearchedQ.current = debouncedQ;
		const timer = setTimeout(() => void refetch({ ...filtersRef.current }, 0), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- debounce keys on the text only; filtersRef carries the rest
	}, [debouncedQ, server, refetch]);

	// The button (and this handler) exists only when the host passes
	// onVerify — building the handler conditionally keeps the guard
	// out of the click path entirely.
	const runVerify =
		onVerify === undefined
			? undefined
			: async () => {
					setVerify({ state: "running", result: null });
					try {
						const result = await onVerify();
						setVerify(
							result === null ? { state: "failed", result: null } : { state: "done", result },
						);
					} catch {
						setVerify({ state: "failed", result: null });
					}
				};

	const verifyMessage = (): string => {
		if (verify.state === "running") return t.verifyRunning;
		if (verify.state === "failed") return t.verifyFailed;
		const result = verify.result;
		if (verify.state !== "done" || result === null) return "";
		if (result.status === "tampered") return t.verifyTampered(result.brokenAt);
		if (result.status === "empty") return t.verifyEmpty;
		return t.verifyVerified(result.entries);
	};

	const groups = useMemo(
		() =>
			server && facets !== null
				? facets.actionGroups
				: [...new Set(page.entries.map((e) => actionGroup(e.action)))].sort(),
		[server, facets, page.entries],
	);
	const actors = useMemo(
		() =>
			server && facets !== null
				? facets.actors.map((a) => a ?? SYSTEM_ACTOR)
				: [...new Set(page.entries.map(actorKey))].sort(),
		[server, facets, page.entries],
	);
	const targetTypes = useMemo(
		() =>
			server && facets !== null
				? facets.targetTypes.map((tt) => tt ?? NO_TARGET_TYPE)
				: [...new Set(page.entries.map(targetTypeKey))].sort(),
		[server, facets, page.entries],
	);
	const needle = filters.q.trim().toLowerCase();
	const filtersActive =
		filters.q.trim() !== "" ||
		filters.group !== ALL ||
		filters.actor !== ALL ||
		filters.targetType !== ALL ||
		filters.from !== "" ||
		filters.to !== "";
	const shown = useMemo(() => {
		// Server mode: the listing already applied every filter.
		if (server) return page.entries;
		return page.entries.filter((e) => {
			if (filters.group !== ALL && actionGroup(e.action) !== filters.group) return false;
			if (filters.actor !== ALL && actorKey(e) !== filters.actor) return false;
			if (filters.targetType !== ALL && targetTypeKey(e) !== filters.targetType) return false;
			if (needle === "") return true;
			return [e.actorEmail ?? "", e.actorUserId ?? "", e.action, e.targetId ?? "", e.detail ?? ""]
				.join(" ")
				.toLowerCase()
				.includes(needle);
		});
	}, [server, page.entries, filters.group, filters.actor, filters.targetType, needle]);

	const pageSize = page.limit > 0 ? page.limit : page.entries.length;
	const totalPages = Math.max(1, Math.ceil(page.total / pageSize));
	const currentPage = Math.min(totalPages, Math.floor(page.offset / pageSize) + 1);
	const showPager = server && page.total > pageSize;
	const colCount = showTenant ? 6 : 5;

	return (
		<PageContainer>
			<PageHeader
				title={title ?? t.title}
				description={t.description(page.entries.length, page.total)}
			/>
			{onVerify !== undefined ? (
				<div className="flex items-center gap-3">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={runVerify}
						disabled={verify.state === "running"}
					>
						{t.verifyButton}
					</Button>
					{verifyMessage() !== "" ? (
						<span className="text-xs text-muted-foreground">{verifyMessage()}</span>
					) : null}
				</div>
			) : null}
			{page.entries.length === 0 && !busy && !filtersActive ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyTitle>{t.emptyTitle}</EmptyTitle>
						<EmptyDescription>{t.emptyDescription}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					<DataToolbar
						search={
							<Input
								type="search"
								value={filters.q}
								onChange={(e) => setFilters({ ...filtersRef.current, q: e.target.value })}
								placeholder={t.searchPlaceholder}
								aria-label={t.searchLabel}
								className={SEARCH_CLS}
							/>
						}
						filters={
							<>
								<Select
									value={filters.group}
									onValueChange={(v) => changeFilters({ group: String(v) })}
								>
									<SelectTrigger className="h-8 w-40 text-xs" aria-label={t.allActions}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ALL}>{t.allActions}</SelectItem>
										{groups.map((g) => (
											<SelectItem key={g} value={g}>
												{g}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Select
									value={filters.actor}
									onValueChange={(v) => changeFilters({ actor: String(v) })}
								>
									<SelectTrigger className="h-8 w-44 text-xs" aria-label={t.allActors}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ALL}>{t.allActors}</SelectItem>
										{actors.map((a) => (
											<SelectItem key={a} value={a}>
												{a === SYSTEM_ACTOR ? t.systemActor : a}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Select
									value={filters.targetType}
									onValueChange={(v) => changeFilters({ targetType: String(v) })}
								>
									<SelectTrigger className="h-8 w-40 text-xs" aria-label={t.allTargetTypes}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ALL}>{t.allTargetTypes}</SelectItem>
										{targetTypes.map((tt) => (
											<SelectItem key={tt} value={tt}>
												{tt === NO_TARGET_TYPE ? t.noTargetType : tt}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{server ? (
									<>
										<Input
											type="date"
											value={filters.from}
											onChange={(e) => changeFilters({ from: e.target.value })}
											aria-label={t.dateFrom}
											className={DATE_CLS}
										/>
										<Input
											type="date"
											value={filters.to}
											onChange={(e) => changeFilters({ to: e.target.value })}
											aria-label={t.dateTo}
											className={DATE_CLS}
										/>
									</>
								) : null}
							</>
						}
						resultCount={!filtersActive ? undefined : t.filteredCount(shown.length, page.total)}
					/>
					{failed ? <p className="text-xs text-destructive">{t.loadFailed}</p> : null}
					<div className="overflow-hidden rounded-lg border border-border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-44">{t.colTime}</TableHead>
									<TableHead>{t.colActor}</TableHead>
									<TableHead>{t.colAction}</TableHead>
									<TableHead>{t.colTarget}</TableHead>
									{showTenant ? <TableHead>{t.colTenant}</TableHead> : null}
									<TableHead className="text-right">{t.colDetail}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{shown.length === 0 ? (
									<TableRow>
										<TableCell colSpan={colCount} className="text-xs text-muted-foreground">
											{t.noMatch}
										</TableCell>
									</TableRow>
								) : (
									shown.map((row) => (
										<TableRow key={row.id}>
											<TableCell className="text-xs text-muted-foreground">
												<LocalDateTime value={row.createdAt} locale={locale} />
											</TableCell>
											<TableCell className="text-xs">
												{row.actorEmail ?? row.actorUserId ?? t.systemActor}
											</TableCell>
											<TableCell className="font-mono text-xs">{row.action}</TableCell>
											<TableCell className="max-w-52 truncate text-xs">
												{targetLabel(row) || t.noTarget}
											</TableCell>
											{showTenant ? (
												<TableCell className="text-xs text-muted-foreground">
													{row.tenantId === null ? t.noTenant : `#${row.tenantId}`}
												</TableCell>
											) : null}
											<TableCell className="text-right">
												{row.detail !== null ? (
													<Button
														type="button"
														variant="ghost"
														size="sm"
														onClick={() => setDetailFor(row)}
													>
														JSON
													</Button>
												) : null}
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
					{showPager ? (
						<div className="mt-4 flex items-center justify-between">
							<p className="text-sm text-muted-foreground">{t.pageInfo(currentPage, totalPages)}</p>
							<div className="flex gap-2">
								<Button
									size="sm"
									variant="outline"
									disabled={busy || page.offset === 0}
									onClick={() =>
										void refetch(filtersRef.current, Math.max(0, page.offset - pageSize))
									}
								>
									{t.prevPage}
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={busy || page.offset + pageSize >= page.total}
									onClick={() => void refetch(filtersRef.current, page.offset + pageSize)}
								>
									{t.nextPage}
								</Button>
							</div>
						</div>
					) : null}
				</>
			)}
			{detailFor !== null ? (
				<Dialog
					open
					onOpenChange={(open) => {
						/* v8 ignore next -- mounted only while detailFor; only close events fire */
						if (!open) setDetailFor(null);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{t.detailTitle}</DialogTitle>
							<DialogDescription className="font-mono text-xs">
								{detailFor.action}
							</DialogDescription>
						</DialogHeader>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
							<dt className="text-muted-foreground">{t.colId}</dt>
							<dd className="font-mono">{detailFor.id}</dd>
							<dt className="text-muted-foreground">{t.colTime}</dt>
							<dd>
								<LocalDateTime value={detailFor.createdAt} locale={locale} />
							</dd>
							<dt className="text-muted-foreground">{t.colActor}</dt>
							<dd>{detailFor.actorEmail ?? detailFor.actorUserId ?? t.systemActor}</dd>
							<dt className="text-muted-foreground">{t.colTarget}</dt>
							<dd className="font-mono">{targetLabel(detailFor) || t.noTarget}</dd>
							{showTenant ? (
								<>
									<dt className="text-muted-foreground">{t.colTenant}</dt>
									<dd>{detailFor.tenantId === null ? t.noTenant : `#${detailFor.tenantId}`}</dd>
								</>
							) : null}
							<dt className="text-muted-foreground">{t.colHash}</dt>
							<dd className="font-mono" title={detailFor.prevHash ?? undefined}>
								{detailFor.prevHash === null ? t.noTarget : `${detailFor.prevHash.slice(0, 16)}…`}
							</dd>
						</dl>
						<pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
							{JSON.stringify(parseDetail(detailFor.detail), null, 2)}
						</pre>
					</DialogContent>
				</Dialog>
			) : null}
		</PageContainer>
	);
}
