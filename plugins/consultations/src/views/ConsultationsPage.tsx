import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ClipboardListIcon, DownloadIcon, LockIcon } from "lucide-react";

import {
	factContent,
	SECTION_LABELS,
	type Anamnesis,
	type AnamnesisSectionKey,
} from "@ktb/anamnesis";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { viewsMessages } from "@ktb/views";
import { LocalDateTime } from "@ktb/views/views";
import { SearchInput, TablePage, type Column } from "@ktb/views/table";

import { Avatar, AvatarFallback } from "@ktbhealth/ui/components/avatar";
import { Badge } from "@ktbhealth/ui/components/badge";
import { buttonVariants } from "@ktbhealth/ui/components/button";
import { Card, CardContent } from "@ktbhealth/ui/components/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ktbhealth/ui/components/empty";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@ktbhealth/ui/components/hover-card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";

import { BADGE_TONES } from "./-ui.ts";
import { consultationMessages, sourceLabel, I18N_NAMESPACE } from "../i18n.ts";
import {
	decryptConsultations,
	isCipheredConsultation,
	parseAnamnesis,
	type ConsultationZk,
} from "../zk.ts";

function initials(name: string | null) {
	if (!name) return "?";
	const parts = name.trim().split(/\s+/);
	return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function ToneBadge({
	children,
	tone = "neutral",
}: {
	children: React.ReactNode;
	tone?: keyof typeof BADGE_TONES;
}) {
	return (
		<Badge variant="secondary" className={`ring-1 ${BADGE_TONES[tone]}`}>
			{children}
		</Badge>
	);
}

/** ~200-char cap for the patient-cell hover preview. */
const PREVIEW_MAX = 200;

/** Hover-preview line: empty/pending sections render a dash, long ones
 * get a single-line ellipsis. */
const previewText = (content: string): string => {
	const fact = factContent(content) ?? "—";
	return fact.length > PREVIEW_MAX ? `${fact.slice(0, PREVIEW_MAX - 1)}…` : fact;
};

/** Count of `baixa`-confidence clinical sections — `historico` is
 * injected context, not a section the doctor reviews (see
 * `AnamnesisSectionKey`). */
const lowConfidenceSections = (doc: Anamnesis): number =>
	(Object.keys(SECTION_LABELS) as AnamnesisSectionKey[]).filter(
		(key) => doc[key].confidence === "baixa",
	).length;

/** Same local calendar day — the "today" stat ignores the clock time. */
const sameLocalDay = (a: Date, b: Date): boolean =>
	a.getFullYear() === b.getFullYear() &&
	a.getMonth() === b.getMonth() &&
	a.getDate() === b.getDate();

export interface ConsultationListItem {
	id: number;
	engine: string | null;
	createdAt: Date;
	transcript: string;
	source: string | null;
	status: string;
	consentAt: Date | null;
	/** Absent on rows from older callers; null when unlinked. */
	patientId?: number | null;
	patientName: string | null;
	chiefComplaint: string | null;
	hasAnamnesis: boolean;
	/** Raw stored `anamnesis` column (T-145): plaintext JSON for non-ZK
	 * rows, a `v1.` envelope under ZK — decrypted client-side. */
	anamnesis?: string | null;
	/** Review stamps (PL-022) — absent on rows from older callers. */
	anamnesisVersion?: number | null;
	transcriptReviewedAt?: Date | null;
	anamnesisReviewedAt?: Date | null;
	anamnesisReviewedVersion?: number | null;
	deferredUntil?: Date | null;
}

/** Parked: deferred stamp still in the future. */
const isDeferred = (c: ConsultationListItem, now: number) =>
	c.deferredUntil != null && new Date(c.deferredUntil).getTime() > now;

/** Anamnesis approval binds the version it stamped — a later edit bumps
 * `anamnesisVersion` and the stamp turns stale instead of lying. */
const anamnesisApproved = (c: ConsultationListItem) =>
	c.anamnesisReviewedVersion != null && c.anamnesisReviewedVersion === c.anamnesisVersion;

const anamnesisStale = (c: ConsultationListItem) =>
	!anamnesisApproved(c) && c.anamnesisReviewedAt != null && c.anamnesisVersion != null;

/** Nothing left for the physician to sign: the anamnesis is approved on
 * its current version, or — transcript-only rows — the transcript was
 * confirmed. */
const reviewDone = (c: ConsultationListItem) =>
	c.hasAnamnesis ? anamnesisApproved(c) : c.transcriptReviewedAt != null;

export function ConsultationsPage({
	consultations,
	i18n,

	locale = "en",
	portalBase,
	zk,
}: {
	consultations: ConsultationListItem[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host (route loader / panel ctx). */
	locale?: string;
	/** Portal instance base path — internal links stay under it (P-081). */
	portalBase?: string;
	/** ZK context (T-145): present only on ZK tenants — rows arrive as
	 * `v1.` envelopes and are decrypted in the browser; rows without a
	 * grant render a locked row. */
	zk?: ConsultationZk;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const navigate = useNavigate();
	const portalPath = (path: string) => (portalBase ? `${portalBase}${path}` : path);
	const FILTERS = [
		["all", t.list.filters.all],
		["anamnesis", t.list.filters.anamnesis],
		["pending", t.list.filters.pending],
	] as const;
	const [q, setQ] = useState("");
	const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
	const [statusFilter, setStatusFilter] = useState<"all" | "live" | "done">("all");
	const [sourceFilter, setSourceFilter] = useState("all");
	const [anamnesisFilter, setAnamnesisFilter] = useState<"all" | "with" | "without">("all");
	const [reviewFilter, setReviewFilter] = useState<"all" | "pending" | "reviewed" | "deferred">(
		"all",
	);
	// Single "now" for the defer comparison across stats/filters/badges —
	// a mount-time snapshot: a still-parked row re-enters pending on the
	// next data refresh, not mid-render.
	const [now] = useState(() => Date.now());

	// Client-side decrypt under ZK (T-145): rows without a grant stay
	// ciphered and render a locked row; decrypted rows get their
	// chiefComplaint re-derived here because the server could not parse
	// the envelope to compute it.
	const [decrypted, setDecrypted] = useState<ReadonlyMap<number, ConsultationListItem>>(new Map());
	useEffect(() => {
		if (!zk) return;
		let live = true;
		decryptConsultations(zk.keyring, zk.api, consultations)
			.then((rows) => {
				if (live) setDecrypted(new Map(rows.map((r) => [r.id, r])));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [zk, consultations]);

	const display = useMemo(() => {
		if (!zk) return consultations;
		return consultations.map((c) => {
			const row = decrypted.get(c.id) ?? c;
			if (isCipheredConsultation(row)) return row;
			const parsed = parseAnamnesis(row.anamnesis);
			return parsed !== null && row.chiefComplaint === null
				? { ...row, chiefComplaint: factContent(parsed.queixa_principal.content) }
				: row;
		});
	}, [consultations, decrypted, zk]);

	// Row facets parsed once per readable anamnesis — feeds the
	// needs-review badge, the hover preview and the stats strip. Ciphered
	// rows stay opaque: they never reach the JSON parser.
	const facets = useMemo(() => {
		const map = new Map<number, { doc: Anamnesis; lowConfidence: number }>();
		for (const c of display) {
			if (isCipheredConsultation(c)) continue;
			const doc = parseAnamnesis(c.anamnesis);
			if (doc === null) continue;
			map.set(c.id, { doc, lowConfidence: lowConfidenceSections(doc) });
		}
		return map;
	}, [display]);

	const stats = useMemo(
		() => ({
			today: display.filter((c) => sameLocalDay(c.createdAt, new Date())).length,
			live: display.filter((c) => c.status === "live").length,
			// Real physician review queue (PL-022): unsigned and not parked.
			review: display.filter((c) => !reviewDone(c) && !isDeferred(c, now)).length,
		}),
		[display, now],
	);

	const shown = useMemo(() => {
		const needle = q.trim().toLowerCase();
		return display.filter((c) => {
			if (filter === "anamnesis" && !c.hasAnamnesis) return false;
			if (filter === "pending" && c.hasAnamnesis) return false;
			if (reviewFilter === "pending" && (reviewDone(c) || isDeferred(c, now))) return false;
			if (reviewFilter === "reviewed" && (!reviewDone(c) || isDeferred(c, now))) return false;
			if (reviewFilter === "deferred" && !isDeferred(c, now)) return false;
			if (statusFilter !== "all" && c.status !== statusFilter) return false;
			if (sourceFilter !== "all" && c.source !== sourceFilter) return false;
			if (anamnesisFilter === "with" && !c.hasAnamnesis) return false;
			if (anamnesisFilter === "without" && c.hasAnamnesis) return false;
			if (!needle) return true;
			// Locked rows are opaque — searchable by id only, never by
			// envelope content.
			if (isCipheredConsultation(c)) return String(c.id).includes(needle);
			return [c.patientName, c.chiefComplaint, c.transcript, String(c.id)]
				.filter(Boolean)
				.some((t) => (t as string).toLowerCase().includes(needle));
		});
	}, [display, q, filter, statusFilter, sourceFilter, anamnesisFilter, reviewFilter, now]);

	const columns: Column<ConsultationListItem>[] = [
		{
			key: "patient",
			header: t.list.colPatient,
			render: (c) => {
				if (isCipheredConsultation(c)) {
					// Locked row (T-145): no DEK grant for this device — the
					// envelope stays opaque and the row is not navigable.
					return (
						<span className="flex items-center gap-3 text-muted-foreground">
							<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
								<LockIcon className="size-4" />
							</span>
							<span className="min-w-0">
								<span className="block font-medium text-foreground">{t.zk.lockedRecord}</span>
								<span className="block text-xs">{t.zk.lockedHint}</span>
							</span>
						</span>
					);
				}
				const cell = (
					<span className="flex max-w-96 items-center gap-3">
						<Avatar className="size-9">
							<AvatarFallback className="bg-gradient-to-br from-primary/15 to-primary/5 text-xs font-semibold text-primary">
								{initials(c.patientName)}
							</AvatarFallback>
						</Avatar>
						{/* whitespace-normal overrides the td's nowrap so the
						 * preview wraps inside the width cap instead of stretching
						 * the column to the full complaint/transcript text. */}
						<span className="min-w-0 whitespace-normal">
							<span className="flex flex-wrap items-baseline gap-x-2">
								<Link
									to={portalPath(`/consultations/${c.id}`)}
									className="font-medium hover:underline"
								>
									{c.patientName ?? t.list.unlinkedPatient}
								</Link>
								{c.patientId ? (
									<Link
										to={portalPath(`/patients/${c.patientId}`)}
										className="text-xs text-primary hover:underline"
									>
										{t.list.patientRecord}
									</Link>
								) : null}
							</span>
							<span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
								{c.chiefComplaint && !c.chiefComplaint.startsWith("A preencher")
									? c.chiefComplaint
									: c.transcript || t.common.noTranscript}
							</span>
						</span>
					</span>
				);
				// Rows with a readable anamnesis get a hover preview of the
				// complaint + plan; the trigger renders as a plain span so
				// whole-row navigation keeps working.
				const facet = facets.get(c.id);
				if (facet === undefined) return cell;
				return (
					<HoverCard>
						<HoverCardTrigger delay={200} render={<span className="block" />}>
							{cell}
						</HoverCardTrigger>
						<HoverCardContent className="w-80">
							{(
								[
									[t.list.previewComplaint, facet.doc.queixa_principal.content],
									[t.list.previewPlan, facet.doc.conduta.content],
								] as const
							).map(([label, text]) => (
								<span key={label} className="mb-2 block last:mb-0">
									<span className="block text-xs font-medium text-muted-foreground">{label}</span>
									<span className="mt-0.5 block">{previewText(text)}</span>
								</span>
							))}
						</HoverCardContent>
					</HoverCard>
				);
			},
		},
		{
			key: "createdAt",
			header: t.list.colDate,
			render: (c) => (
				<span className="whitespace-nowrap text-muted-foreground">
					<span className="text-xs">#{c.id}</span>{" "}
					<LocalDateTime value={c.createdAt} locale={locale} />
				</span>
			),
		},
		{
			key: "status",
			header: t.list.colStatus,
			render: (c) =>
				isCipheredConsultation(c) ? null : (
					<span className="flex flex-wrap items-center gap-1.5">
						{c.status === "live" ? (
							<ToneBadge tone="red">
								<span className="size-1.5 animate-pulse rounded-full bg-destructive" />
								{t.list.liveNow}
							</ToneBadge>
						) : null}
						{c.consentAt ? <ToneBadge tone="green">{t.list.consent}</ToneBadge> : null}
						{isDeferred(c, now) ? (
							<ToneBadge tone="blue">
								{t.list.deferredBadge(
									new Date(c.deferredUntil!).toLocaleDateString(locale, {
										day: "numeric",
										month: "short",
									}),
								)}
							</ToneBadge>
						) : anamnesisApproved(c) ? (
							<ToneBadge tone="green">
								{t.list.reviewedBadge(c.anamnesisReviewedVersion!)}
							</ToneBadge>
						) : anamnesisStale(c) ? (
							<ToneBadge tone="blue">{t.list.staleBadge(c.anamnesisVersion!)}</ToneBadge>
						) : c.transcriptReviewedAt ? (
							<ToneBadge tone="blue">{t.list.transcriptReviewedBadge}</ToneBadge>
						) : null}
					</span>
				),
		},
		{
			key: "anamnesis",
			header: t.common.anamnesis,
			render: (c) => {
				if (isCipheredConsultation(c)) return null;
				const lowConfidence = facets.get(c.id)?.lowConfidence ?? 0;
				return (
					<span className="flex flex-wrap items-center gap-1.5">
						{c.hasAnamnesis ? (
							<ToneBadge tone="green">{t.common.anamnesis}</ToneBadge>
						) : (
							<ToneBadge tone="blue">{t.list.noAnamnesis}</ToneBadge>
						)}
						{lowConfidence > 0 ? (
							<ToneBadge tone="blue">{t.list.needsReview(lowConfidence)}</ToneBadge>
						) : null}
						<ToneBadge>{sourceLabel(t, c.source)}</ToneBadge>
					</span>
				);
			},
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title={t.list.title}
				description={consultations.length === 0 ? t.list.none : t.list.count(consultations.length)}
				actions={
					<Link to={portalPath("/consultations/new")} className={buttonVariants()}>
						{t.list.newConsultation}
					</Link>
				}
			/>

			{consultations.length === 0 ? (
				<Empty className="border bg-card px-6 py-16">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ClipboardListIcon />
						</EmptyMedia>
						<EmptyTitle>{t.list.emptyTitle}</EmptyTitle>
						<EmptyDescription>{t.list.emptyDescription}</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Link to={portalPath("/consultations/new")} className={buttonVariants()}>
							{t.list.startConsultation}
						</Link>
					</EmptyContent>
				</Empty>
			) : (
				<>
					<div className="grid grid-cols-3 gap-3">
						{(
							[
								[t.list.statsToday, stats.today],
								[t.list.statsLiveNow, stats.live],
								[t.list.statsNeedsReview, stats.review],
							] as const
						).map(([label, value]) => (
							<Card key={label} size="sm">
								<CardContent className="flex flex-col gap-0.5">
									<span className="text-2xl font-semibold tabular-nums">{value}</span>
									<span className="text-xs text-muted-foreground">{label}</span>
								</CardContent>
							</Card>
						))}
					</div>
					<TablePage.Toolbar
						search={
							<SearchInput
								value={q}
								onChange={setQ}
								className="w-64 sm:w-96"
								placeholder={t.list.searchPlaceholder}
								aria-label={t.list.searchLabel}
							/>
						}
						filters={
							<>
								<Tabs
									value={filter}
									onValueChange={(v) => setFilter(v as (typeof FILTERS)[number][0])}
									className="w-fit"
								>
									<TabsList aria-label={t.list.filterLabel}>
										{FILTERS.map(([key, label]) => (
											<TabsTrigger key={key} value={key}>
												{label}
											</TabsTrigger>
										))}
									</TabsList>
								</Tabs>
								<Select
									value={statusFilter}
									onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
								>
									<SelectTrigger className="h-8 text-xs" aria-label={t.list.filterAll}>
										<span className="text-muted-foreground">{t.list.facetStatus}:</span>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">{t.list.filterAll}</SelectItem>
										<SelectItem value="live">{t.list.filterLive}</SelectItem>
										<SelectItem value="done">{t.list.filterDone}</SelectItem>
									</SelectContent>
								</Select>
								<Select value={sourceFilter} onValueChange={(v) => setSourceFilter(String(v))}>
									<SelectTrigger className="h-8 text-xs" aria-label={t.list.filterSourceAll}>
										<span className="text-muted-foreground">{t.list.facetSource}:</span>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">{t.list.filterSourceAll}</SelectItem>
										{(Object.keys(t.sources) as (keyof typeof t.sources)[]).map((source) => (
											<SelectItem key={source} value={source}>
												{t.sources[source]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Select
									value={anamnesisFilter}
									onValueChange={(v) => setAnamnesisFilter(v as typeof anamnesisFilter)}
								>
									<SelectTrigger className="h-8 text-xs" aria-label={t.list.filterAnamnesisAll}>
										<span className="text-muted-foreground">{t.list.facetAnamnesis}:</span>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">{t.list.filterAnamnesisAll}</SelectItem>
										<SelectItem value="with">{t.list.filterAnamnesisWith}</SelectItem>
										<SelectItem value="without">{t.list.filterAnamnesisWithout}</SelectItem>
									</SelectContent>
								</Select>
								<Select
									value={reviewFilter}
									onValueChange={(v) => setReviewFilter(v as typeof reviewFilter)}
								>
									<SelectTrigger className="h-8 text-xs" aria-label={t.list.filterReviewAll}>
										<span className="text-muted-foreground">{t.list.facetReview}:</span>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">{t.list.filterReviewAll}</SelectItem>
										<SelectItem value="pending">{t.list.filterReviewPending}</SelectItem>
										<SelectItem value="reviewed">{t.list.filterReviewDone}</SelectItem>
										<SelectItem value="deferred">{t.list.filterReviewDeferred}</SelectItem>
									</SelectContent>
								</Select>
							</>
						}
					/>
					<TablePage.Table
						columns={columns}
						rows={shown}
						total={consultations.length}
						noMatch={t.list.noMatch}
						locale={locale}
						rowActionsHeader={t.list.colActions}
						// Whole-row navigation is the table-kit analogue of the
						// MVP overlay link — clicks on interactive cells (links,
						// buttons) don't trigger it, and locked rows stay inert.
						onRowClick={(c) => {
							if (isCipheredConsultation(c)) return;
							void navigate({ to: portalPath(`/consultations/${c.id}`) });
						}}
						rowActions={(c) =>
							isCipheredConsultation(c) ? null : (
								<span className="flex items-center justify-end gap-1.5">
									<Link
										to={portalPath(`/consultations/${c.id}`)}
										className={buttonVariants({ variant: "outline", size: "sm" })}
									>
										{t.list.open}
									</Link>
									{/* Server-side PDF reads plaintext columns — impossible
									 * under ZK; T-146 adds the client-side renderer. */}
									{c.hasAnamnesis && !zk ? (
										<a
											href={`/api/consultations/${c.id}/pdf`}
											download
											title={t.list.downloadPdfTitle}
											className={buttonVariants({ variant: "outline", size: "sm" })}
										>
											<DownloadIcon className="mr-1 inline size-3.5 -translate-y-px" />
											PDF
										</a>
									) : null}
								</span>
							)
						}
					/>
				</>
			)}
		</TablePage>
	);
}
