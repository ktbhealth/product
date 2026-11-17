import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ClipboardListIcon, DownloadIcon, LockIcon } from "lucide-react";

import { factContent } from "@ktb/anamnesis";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

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
import { SearchInput } from "@ktbhealth/ui/components/search-input";
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
	 * grant render a locked card. */
	zk?: ConsultationZk;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const portalPath = (path: string) => (portalBase ? `${portalBase}${path}` : path);
	const FILTERS = [
		["all", t.list.filters.all],
		["anamnesis", t.list.filters.anamnesis],
		["pending", t.list.filters.pending],
	] as const;
	const [q, setQ] = useState("");
	const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");

	// Client-side decrypt under ZK (T-145): rows without a grant stay
	// ciphered and render a locked card; decrypted rows get their
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

	return (
		<div>
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<h1 className="text-3xl font-bold tracking-tight">{t.list.title}</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						{consultations.length === 0 ? t.list.none : t.list.count(consultations.length)}
					</p>
				</div>
				<Link to={portalPath("/consultations/new")} className={buttonVariants()}>
					{t.list.newConsultation}
				</Link>
			</div>

			{consultations.length > 0 ? (
				<div className="mt-6 flex flex-wrap items-center gap-3">
					<SearchInput
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder={t.list.searchPlaceholder}
						aria-label={t.list.searchLabel}
						className="w-full max-w-sm"
					/>
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
				</div>
			) : null}

			<div className="mt-5 space-y-3">
				{shown.map((c) =>
					isCipheredConsultation(c) ? (
						// Locked row (T-145): no DEK grant for this device — the
						// envelope stays opaque and the card is not navigable.
						<article
							key={c.id}
							className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm"
						>
							<div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
								<LockIcon className="size-4" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="font-semibold">{t.zk.lockedRecord}</p>
								<p className="mt-0.5 text-sm text-muted-foreground">{t.zk.lockedHint}</p>
								<p className="mt-0.5 text-xs text-muted-foreground">
									#{c.id} · {new Date(c.createdAt).toLocaleString()}
								</p>
							</div>
						</article>
					) : (
						<article
							key={c.id}
							className="group relative flex items-start gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm transition hover:border-foreground/20 hover:shadow"
						>
							<div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/15 to-primary/5 text-sm font-semibold text-primary">
								{initials(c.patientName)}
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-baseline gap-x-2">
									<Link
										to={portalPath(`/consultations/${c.id}`)}
										className="font-semibold after:absolute after:inset-0 after:content-['']"
									>
										{c.patientName ?? t.list.unlinkedPatient}
									</Link>
									<span className="text-xs text-muted-foreground">
										#{c.id} · {new Date(c.createdAt).toLocaleString()}
									</span>
									{c.patientId ? (
										<Link
											to={portalPath(`/patients/${c.patientId}`)}
											className="relative z-10 text-xs text-primary hover:underline"
										>
											{t.list.patientRecord}
										</Link>
									) : null}
								</div>
								<p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
									{c.chiefComplaint && !c.chiefComplaint.startsWith("A preencher")
										? c.chiefComplaint
										: c.transcript || t.common.noTranscript}
								</p>
								<div className="mt-2.5 flex flex-wrap items-center gap-1.5">
									{c.status === "live" ? <ToneBadge tone="red">● {t.list.live}</ToneBadge> : null}
									{c.hasAnamnesis ? (
										<ToneBadge tone="green">{t.common.anamnesis}</ToneBadge>
									) : (
										<ToneBadge tone="amber">{t.list.noAnamnesis}</ToneBadge>
									)}
									{c.consentAt ? <ToneBadge tone="green">{t.list.consent}</ToneBadge> : null}
									<ToneBadge>{sourceLabel(t, c.source)}</ToneBadge>
								</div>
							</div>
							<div className="relative z-10 flex shrink-0 items-center gap-1.5">
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
							</div>
						</article>
					),
				)}

				{consultations.length > 0 && shown.length === 0 ? (
					<Empty className="border">
						<EmptyDescription>{t.list.noMatch}</EmptyDescription>
					</Empty>
				) : null}

				{!consultations.length ? (
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
				) : null}
			</div>
		</div>
	);
}
