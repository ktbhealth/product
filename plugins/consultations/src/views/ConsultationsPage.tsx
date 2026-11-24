import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ClipboardListIcon, DownloadIcon, LockIcon } from "lucide-react";

import { factContent } from "@ktb/anamnesis";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { viewsMessages } from "@ktb/views";
import { LocalDateTime } from "@ktb/views/views";
import { SearchInput, TablePage, type Column } from "@ktb/views/table";

import { Avatar, AvatarFallback } from "@ktbhealth/ui/components/avatar";
import { Badge } from "@ktbhealth/ui/components/badge";
import { buttonVariants } from "@ktbhealth/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ktbhealth/ui/components/empty";
import { Tabs, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";

import { BADGE_TONES } from "./-ui.ts";
import { consultationMessages, sourceLabel, I18N_NAMESPACE } from "../i18n.ts";
import { prefersWhisper } from "../backend.ts";
import { prefetchWhisperModel } from "../whisper-prefetch.ts";
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
}

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

	// Warm the Whisper model while the doctor browses the list — on the
	// Web Speech fallback there is no model to prefetch.
	useEffect(() => {
		if (prefersWhisper) prefetchWhisperModel();
	}, []);

	const shown = useMemo(() => {
		const needle = q.trim().toLowerCase();
		return display.filter((c) => {
			if (filter === "anamnesis" && !c.hasAnamnesis) return false;
			if (filter === "pending" && c.hasAnamnesis) return false;
			if (!needle) return true;
			// Locked rows are opaque — searchable by id only, never by
			// envelope content.
			if (isCipheredConsultation(c)) return String(c.id).includes(needle);
			return [c.patientName, c.chiefComplaint, c.transcript, String(c.id)]
				.filter(Boolean)
				.some((t) => (t as string).toLowerCase().includes(needle));
		});
	}, [display, q, filter]);

	const columns: Column<ConsultationListItem>[] = [
		{
			key: "patient",
			header: t.list.colPatient,
			render: (c) =>
				isCipheredConsultation(c) ? (
					// Locked row (T-145): no DEK grant for this device — the
					// envelope stays opaque and the row is not navigable.
					<span className="flex items-center gap-3 text-muted-foreground">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
							<LockIcon className="size-4" />
						</span>
						<span className="min-w-0">
							<span className="block font-medium text-foreground">{t.zk.lockedRecord}</span>
							<span className="block text-xs">{t.zk.lockedHint}</span>
						</span>
					</span>
				) : (
					<span className="flex items-center gap-3">
						<Avatar className="size-9">
							<AvatarFallback className="bg-gradient-to-br from-primary/15 to-primary/5 text-xs font-semibold text-primary">
								{initials(c.patientName)}
							</AvatarFallback>
						</Avatar>
						<span className="min-w-0">
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
				),
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
						{c.status === "live" ? <ToneBadge tone="red">● {t.list.live}</ToneBadge> : null}
						{c.consentAt ? <ToneBadge tone="green">{t.list.consent}</ToneBadge> : null}
					</span>
				),
		},
		{
			key: "anamnesis",
			header: t.common.anamnesis,
			render: (c) =>
				isCipheredConsultation(c) ? null : (
					<span className="flex flex-wrap items-center gap-1.5">
						{c.hasAnamnesis ? (
							<ToneBadge tone="green">{t.common.anamnesis}</ToneBadge>
						) : (
							<ToneBadge tone="amber">{t.list.noAnamnesis}</ToneBadge>
						)}
						<ToneBadge>{sourceLabel(t, c.source)}</ToneBadge>
					</span>
				),
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
					<TablePage.Toolbar
						search={
							<SearchInput
								value={q}
								onChange={setQ}
								placeholder={t.list.searchPlaceholder}
								aria-label={t.list.searchLabel}
							/>
						}
						filters={
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
