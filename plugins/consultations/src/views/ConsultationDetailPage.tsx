import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
	ArrowLeftIcon,
	CalendarIcon,
	CheckIcon,
	ClipboardListIcon,
	DownloadIcon,
	LockIcon,
	QuoteIcon,
} from "lucide-react";
import type { Locale as CalendarLocale } from "react-day-picker";
import { enUS, es, ptBR } from "react-day-picker/locale";

import { IntegrityBadge } from "@ktb/integrity/badge";
import { anamnesisToText, factContent } from "@ktb/anamnesis";
import type { Anamnesis, AnamnesisSectionKey, PatientHistory } from "@ktb/anamnesis";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Toast, type ToastData } from "@ktbhealth/ui/components/app-toast";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ktbhealth/ui/components/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ktbhealth/ui/components/empty";
import { Calendar } from "@ktbhealth/ui/components/calendar";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Popover, PopoverContent, PopoverTrigger } from "@ktbhealth/ui/components/popover";
import { ScrollArea } from "@ktbhealth/ui/components/scroll-area";

import type { ConsultationIntegrityReport } from "../index.ts";
import { BADGE_TONES, CONF_STYLE } from "./-ui.ts";
import { consultationMessages, sourceLabel, I18N_NAMESPACE } from "../i18n.ts";
import { decryptBlob } from "@ktb/crypto/stream";
import { LocalDateTime } from "@ktb/views/views";

import {
	consultationDek,
	decryptConsultation,
	decryptConsultations,
	isEnvelope,
	parseAnamnesis,
	type ConsultationZk,
} from "../zk.ts";
import {
	AudioTranscriptPanel,
	useConsultationAudio,
	type ConsultationAudioInfo,
} from "./-transcript.tsx";
import { parseTranscriptSegments } from "../segments.ts";

function Chip({
	children,
	tone = "neutral",
}: {
	children: React.ReactNode;
	tone?: "neutral" | "green" | "blue";
}) {
	return (
		<Badge variant="secondary" className={`ring-1 ${BADGE_TONES[tone]}`}>
			{children}
		</Badge>
	);
}

export interface ConsultationDetail {
	id: number;
	userId: string | null;
	patientId: number | null;
	transcript: string;
	anamnesis: Anamnesis | null;
	engine: string | null;
	source: string | null;
	status: string;
	botId: string | null;
	consentAt: Date | null;
	createdAt: Date;
	patientName: string | null;
	/** Raw stored `anamnesis` column (T-145): a `v1.` envelope under ZK —
	 * `anamnesis` stays null there until the client decrypts it. */
	anamnesisRaw?: string | null;
	/** Audio pipeline fields (P-015..P-017) — null/none on older rows. */
	audioKey: string | null;
	audioStatus: string;
	audioError: string | null;
	serverTranscript: string | null;
	correctedTranscript: string | null;
	enhancementEngine: string | null;
	/** Review stamps (PL-022) — absent on rows from older callers. */
	anamnesisVersion?: number | null;
	transcriptReviewedAt?: Date | null;
	anamnesisReviewedAt?: Date | null;
	anamnesisReviewedVersion?: number | null;
	deferredUntil?: Date | null;
	/** Review-mode payloads (PL-023): whisper segments for karaoke, the
	 * Loro edit log + pinned base, and the op-count the transcript
	 * confirmation stamped. Envelopes under ZK — decrypted client-side. */
	transcriptSegments?: string | null;
	transcriptEdits?: string | null;
	transcriptEditsBase?: string | null;
	transcriptReviewedEdits?: number | null;
}

/** Raw history rows for the client-side ZK history build (T-145). */
export interface ConsultationHistoryRows {
	readonly count: number;
	readonly rows: readonly {
		readonly id: number;
		readonly createdAt: Date | string;
		readonly anamnesis: string | null;
	}[];
}

/** Optional live refetch — enables polling while the audio pipeline runs. */
export interface ConsultationDetailApi {
	getConsultation(input: { data: number }): Promise<ConsultationAudioInfo | null>;
	/** Integrity re-verification for the anamnesis badge (T-139). */
	verifyIntegrity?(input: { data: number }): Promise<ConsultationIntegrityReport | null>;
	/** Review stamps (PL-022). */
	reviewTranscript?(input: { data: number }): Promise<{ ok: boolean }>;
	approveAnamnesis?(input: { data: number }): Promise<{ ok: boolean }>;
	deferConsultation?(input: {
		data: { id: number; until: Date | string | null };
	}): Promise<{ ok: boolean }>;
	/** "Approve & next" — the next unsigned record in the queue. */
	nextPendingReview?(input: { data: number }): Promise<{ id: number | null }>;
	/** Persist the Loro transcript-edit log (PL-023). */
	saveTranscriptEdits?(input: { data: { id: number; edits: string } }): Promise<{ ok: boolean }>;
	/** Draft + attach an anamnesis for a transcript-only record. */
	generateAnamnesis?(input: {
		data: { consultationId: number; transcript: string; patientId?: number };
	}): Promise<{ ok: boolean }>;
}

const PIPELINE_IN_FLIGHT = new Set(["stored", "queued", "processing"]);

/** react-day-picker locales per app locale (PL-022 defer calendar). */
const CALENDAR_LOCALES: Record<string, CalendarLocale> = {
	en: enUS,
	"pt-BR": ptBR,
	es,
};

export function ConsultationDetailPage({
	c,
	history: historyProp,
	historyRows,
	api,
	i18n,

	locale = "en",
	portalBase,
	zk,
}: {
	c: ConsultationDetail;
	history: PatientHistory | null;
	/** Raw history rows — the ZK path (T-145); the view decrypts each
	 * row's `anamnesis` and derives the visit facts itself. */
	historyRows?: ConsultationHistoryRows | null;
	api?: ConsultationDetailApi;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host (route loader / panel ctx). */
	locale?: string;
	/** Portal instance base path — internal links stay under it (P-081). */
	portalBase?: string;
	/** ZK context (T-145): present only on ZK tenants — `c` arrives with
	 * `v1.` envelopes and is decrypted in the browser; without a grant
	 * the page renders the locked state. */
	zk?: ConsultationZk;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const portalPath = (path: string) => (portalBase ? `${portalBase}${path}` : path);
	const navigate = useNavigate();
	const router = useRouter();
	const [toast, setToast] = useState<ToastData | null>(null);

	// Review stamps (PL-022) — optimistic local overrides applied after
	// each mutation; the row's columns are the server-side truth.
	const [review, setReview] = useState({
		transcriptAt: c.transcriptReviewedAt ?? null,
		anamnesisAt: c.anamnesisReviewedAt ?? null,
		anamnesisVersion: c.anamnesisReviewedVersion ?? null,
		deferredUntil: c.deferredUntil ?? null,
	});
	const [busy, setBusy] = useState(false);
	const [deferOpen, setDeferOpen] = useState(false);
	const isDeferred = review.deferredUntil !== null && new Date(review.deferredUntil) > new Date();
	const anamnesisApproved =
		review.anamnesisVersion !== null && review.anamnesisVersion === c.anamnesisVersion;
	const anamnesisStale =
		!anamnesisApproved && review.anamnesisAt !== null && c.anamnesisVersion !== null;
	const shortDate = (d: Date | string) =>
		new Date(d).toLocaleDateString(locale, { day: "numeric", month: "short" });

	const run = async (fn: () => Promise<{ ok: boolean }>, done: () => void) => {
		/* v8 ignore next -- every caller is disabled while busy; this is belt-and-braces */
		if (busy) return;
		setBusy(true);
		try {
			if ((await fn()).ok) done();
		} finally {
			setBusy(false);
		}
	};

	const confirmTranscript = () =>
		void run(
			() => api!.reviewTranscript!({ data: c.id }),
			() => setReview((s) => ({ ...s, transcriptAt: new Date() })),
		);

	const approveAnamnesis = (goNext: boolean) =>
		void run(
			() => api!.approveAnamnesis!({ data: c.id }),
			() => {
				setReview((s) => ({
					...s,
					anamnesisAt: new Date(),
					anamnesisVersion: c.anamnesisVersion ?? null,
				}));
				setToast({ id: Date.now(), text: t.detail.approvedToast });
				if (goNext && api?.nextPendingReview) {
					void api.nextPendingReview({ data: c.id }).then((next) => {
						if (next.id !== null) {
							void navigate({ to: portalPath(`/consultations/${next.id}`) });
						} else {
							setToast({ id: Date.now(), text: t.detail.queueDoneToast });
							void navigate({ to: portalPath("/consultations") });
						}
					});
				}
			},
		);

	const defer = (until: Date | null) =>
		void run(
			() =>
				api!.deferConsultation!({
					// ISO on the wire — Date instances may not survive the fn
					// serializer as a `DateFromString`-decodable input.
					data: { id: c.id, until: until === null ? null : until.toISOString() },
				}),
			() => setReview((s) => ({ ...s, deferredUntil: until })),
		);

	const generateAnamnesis = () =>
		void run(
			() =>
				api!.generateAnamnesis!({
					data: {
						consultationId: c.id,
						// Non-null: the button only renders when v.transcript?.trim().
						transcript: v.transcript!,
						...(v.patientId === null ? {} : { patientId: v.patientId }),
					},
				}),
			() => void router.invalidate(),
		);

	// Client-side decrypt under ZK (T-145): the stored envelopes become
	// plaintext fields; a missing/failed grant renders the locked page.
	const [dec, setDec] = useState<{
		anamnesis: Anamnesis | null;
		transcript: string;
		patientName: string | null;
		serverTranscript: string | null;
		correctedTranscript: string | null;
	} | null>(null);
	const [locked, setLocked] = useState(false);
	useEffect(() => {
		if (!zk) return;
		let live = true;
		decryptConsultation(zk.keyring, zk.api, { ...c, anamnesis: c.anamnesisRaw ?? null })
			.then((row) => {
				if (!live) return;
				if (row === null) {
					setLocked(true);
					return;
				}
				// Envelopes that failed to decrypt never render — they stay
				// opaque instead of leaking `v1.` strings into the page.
				const plain = (x: unknown): string | null =>
					typeof x === "string" && isEnvelope(x) ? null : ((x as string | null) ?? null);
				setDec({
					anamnesis: parseAnamnesis(row.anamnesis) ?? c.anamnesis,
					transcript: row.transcript,
					patientName: row.patientName,
					serverTranscript: plain(row.serverTranscript),
					correctedTranscript: plain(row.correctedTranscript),
				});
			})
			.catch(() => {
				if (live) setLocked(true);
			});
		return () => {
			live = false;
		};
	}, [zk, c]);

	// Client-side history build under ZK (T-145): decrypt each prior
	// consultation's anamnesis and derive the visit facts locally.
	const [decHistory, setDecHistory] = useState<PatientHistory | null>(null);
	useEffect(() => {
		if (!zk || !historyRows) return;
		let live = true;
		decryptConsultations(zk.keyring, zk.api, historyRows.rows)
			.then((rows) => {
				if (!live) return;
				setDecHistory({
					count: historyRows.count,
					visits: rows.map((r) => {
						const parsed = parseAnamnesis(r.anamnesis);
						return {
							id: r.id,
							date: new Date(r.createdAt).toISOString(),
							chiefComplaint: factContent(parsed?.queixa_principal.content),
							plan: factContent(parsed?.conduta.content),
						};
					}),
				});
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [zk, historyRows]);
	const history = zk ? decHistory : historyProp;
	// ZK audio playback (T-147): the stored object is framed ciphertext —
	// fetch it, unwrap the consultation DEK, decrypt in the browser and
	// hand the <audio> element an object URL. Locked/missing grant → no
	// player, exactly like the rest of the record.
	const [zkAudioUrl, setZkAudioUrl] = useState<string | null>(null);
	useEffect(() => {
		if (!zk || !c.audioKey) return;
		let live = true;
		let url: string | null = null;
		void (async () => {
			const dek = await consultationDek(zk.keyring, zk.api, c.id);
			if (!dek) return;
			const res = await fetch(`/api/consultations/${c.id}/audio`);
			if (!res.ok) return;
			const plain = await decryptBlob(dek, new Uint8Array(await res.arrayBuffer()));
			url = URL.createObjectURL(
				// The recorded/uploaded type is not part of the detail
				// wire shape — browsers sniff the decrypted bytes anyway.
				new Blob([plain as Uint8Array<ArrayBuffer>], { type: "audio/webm" }),
			);
			if (live) setZkAudioUrl(url);
			else URL.revokeObjectURL(url);
		})().catch(() => {});
		return () => {
			live = false;
			if (url !== null) URL.revokeObjectURL(url);
		};
	}, [zk, c]);
	// Poll only when the loader data says the pipeline may still be
	// running (or the LLM cleanup is pending); the hook stops itself
	// once the job reaches a terminal state.
	const pipelineActive =
		PIPELINE_IN_FLIGHT.has(c.audioStatus) ||
		(c.audioStatus === "done" && Boolean(c.serverTranscript) && !c.correctedTranscript);
	const live = useConsultationAudio(api && pipelineActive ? api.getConsultation : undefined, c.id);
	// `dec` overlays the client-decrypted fields under ZK; `live` the
	// polled audio-pipeline state — never active under ZK (T-147).
	const v = { ...c, ...live, ...dec };
	const segments = parseTranscriptSegments(v.transcriptSegments);
	// Clickable transcript evidence: at most one section's grounding
	// sentences are marked up in the transcript at a time; turning a
	// section on also scrolls the ScrollArea to the first match.
	const [evidence, setEvidence] = useState<{
		section: AnamnesisSectionKey;
		sentences: readonly string[];
	} | null>(null);
	const transcriptRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!evidence) return;
		// jsdom has no scrollIntoView — the optional call keeps tests quiet.
		transcriptRef.current?.querySelector("mark")?.scrollIntoView?.({ block: "nearest" });
	}, [evidence, v.transcript, v.serverTranscript, v.correctedTranscript]);
	// Tamper-evidence badge (T-139): re-verify the anamnesis version
	// chain once on mount — only meaningful when an anamnesis exists.
	const [integrity, setIntegrity] = useState<ConsultationIntegrityReport | null>(null);
	useEffect(() => {
		if (!api?.verifyIntegrity || !v.anamnesis) return;
		let alive = true;
		void api
			.verifyIntegrity({ data: c.id })
			.then((report) => {
				if (alive) setIntegrity(report);
			})
			// A failed verification must never break the record view.
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [api, c.id, v.anamnesis]);

	function copy() {
		/* v8 ignore next -- copy button only renders when anamnesis exists */
		if (!v.anamnesis) return;
		void navigator.clipboard
			.writeText(anamnesisToText(v.anamnesis))
			.then(() => setToast({ id: Date.now(), text: t.detail.anamnesisCopied }));
	}

	// Locked record (T-145): the device holds no grant for this
	// consultation's DEK — nothing clinical is rendered.
	if (locked) {
		return (
			<PageContainer>
				<PageHeader
					title={t.zk.lockedRecord}
					actions={
						<Button
							variant="ghost"
							size="sm"
							nativeButton={false}
							render={<Link to={portalPath("/consultations")} />}
						>
							<ArrowLeftIcon data-icon="inline-start" />
							{t.detail.back}
						</Button>
					}
				/>
				<Empty className="border bg-card px-6 py-16">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<LockIcon />
						</EmptyMedia>
						<EmptyDescription>{t.zk.lockedHint}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</PageContainer>
		);
	}

	return (
		<PageContainer className="max-w-none">
			{/* PageHeader renders any ReactNode, but its `title` prop type
			    collides with the HTML `title` attribute upstream — cast the
			    h1 so the page keeps a single heading landmark. */}
			<PageHeader
				title={
					(
						<h1>
							{v.patientId && v.patientName ? (
								<Link
									to={portalPath(`/patients/${v.patientId}`)}
									className="hover:underline"
									title={t.detail.openPatientRecord}
								>
									{v.patientName}
								</Link>
							) : (
								(v.patientName ?? t.common.consultationId(c.id))
							)}
						</h1>
					) as never
				}
				description={
					<>
						{t.common.consultationId(c.id)} ·{" "}
						<LocalDateTime
							value={c.createdAt}
							locale={locale}
							options={{ dateStyle: "long", timeStyle: "short" }}
						/>
					</>
				}
				actions={
					<>
						<Button
							variant="ghost"
							size="sm"
							nativeButton={false}
							render={<Link to={portalPath("/consultations")} />}
						>
							<ArrowLeftIcon data-icon="inline-start" />
							{t.detail.back}
						</Button>
						{api?.deferConsultation ? (
							<Popover open={deferOpen} onOpenChange={setDeferOpen}>
								<PopoverTrigger render={<Button variant="outline" size="sm" />}>
									<CalendarIcon data-icon="inline-start" />
									{isDeferred
										? t.detail.deferredUntil(shortDate(review.deferredUntil!))
										: t.detail.deferLabel}
								</PopoverTrigger>
								<PopoverContent className="w-auto p-0" align="end">
									<Calendar
										mode="single"
										locale={CALENDAR_LOCALES[locale]}
										selected={isDeferred ? new Date(review.deferredUntil!) : undefined}
										disabled={{ before: new Date() }}
										onSelect={(date) => {
											if (date) {
												defer(date);
												setDeferOpen(false);
											}
										}}
									/>
									{isDeferred ? (
										<div className="border-t border-border p-2">
											<Button
												type="button"
												variant="ghost"
												size="sm"
												disabled={busy}
												onClick={() => {
													defer(null);
													setDeferOpen(false);
												}}
											>
												{t.detail.deferResume}
											</Button>
										</div>
									) : null}
								</PopoverContent>
							</Popover>
						) : null}
						{v.anamnesis ? (
							<>
								<Button type="button" variant="outline" onClick={copy}>
									{t.common.copy}
								</Button>
								{/* T-146: the server-side PDF reads plaintext columns —
								 * impossible under ZK. The export is gated (not hidden):
								 * a disabled control states why instead of silently
								 * dropping the affordance. */}
								{!zk ? (
									<Button
										nativeButton={false}
										render={<a href={`/api/consultations/${c.id}/pdf`} download />}
									>
										<DownloadIcon data-icon="inline-start" />
										{t.common.downloadPdf}
									</Button>
								) : (
									<Button type="button" variant="outline" disabled title={t.zk.exportLocked}>
										<LockIcon data-icon="inline-start" />
										{t.zk.exportLocked}
									</Button>
								)}
							</>
						) : null}
					</>
				}
			/>

			{/* ---------- meta ---------- */}
			<Card>
				<CardHeader>
					<CardTitle>{t.detail.metaTitle}</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-wrap items-center gap-1.5">
					<Chip>{sourceLabel(t, c.source)}</Chip>
					{c.engine ? <Chip>{t.common.engine(c.engine)}</Chip> : null}
					{c.consentAt ? (
						<Chip tone="green">
							{t.detail.consentLabel}{" "}
							<LocalDateTime
								value={c.consentAt}
								locale={locale}
								options={{ year: "numeric", month: "numeric", day: "numeric" }}
							/>
						</Chip>
					) : (
						<Chip tone="blue">{t.detail.consentNotRecorded}</Chip>
					)}
					{c.status === "live" ? <Chip tone="blue">{t.detail.inProgress}</Chip> : null}
					{isDeferred ? (
						<Chip tone="blue">{t.detail.deferredUntil(shortDate(review.deferredUntil!))}</Chip>
					) : null}
					{v.anamnesis ? <IntegrityBadge report={integrity} labels={t.detail.integrity} /> : null}
					{history && history.count > 0 ? (
						<Chip>{t.detail.previousConsultations(history.count)}</Chip>
					) : null}
				</CardContent>
			</Card>

			{history && history.count > 0 ? (
				<details className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
					<summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
						{t.sections.historico} · {t.detail.previousConsultations(history.count)}
					</summary>
					<ul className="space-y-2 border-t border-border px-4 py-3 text-sm">
						{history.visits.map((v) => (
							<li key={v.id}>
								<span className="text-muted-foreground">
									<LocalDateTime value={v.date} locale={locale} options={{ dateStyle: "medium" }} />{" "}
									· {t.common.consultationId(v.id).toLowerCase()}
								</span>
								{v.chiefComplaint ? <div>{t.detail.complaint(v.chiefComplaint)}</div> : null}
								{v.plan ? <div>{t.detail.plan(v.plan)}</div> : null}
							</li>
						))}
					</ul>
					<p className="px-4 pb-3 text-[11px] text-muted-foreground">{t.detail.historyNote}</p>
				</details>
			) : null}

			<div className="grid items-start gap-6 lg:grid-cols-[1.35fr_1fr]">
				{/* ---------- anamnesis ---------- */}
				<Card>
					<CardHeader className="border-b">
						<div className="flex items-center justify-between gap-2">
							<CardTitle>{t.common.anamnesis}</CardTitle>
							<span className="flex items-center gap-2">
								{anamnesisStale ? (
									<Chip tone="blue">{t.detail.anamnesisStale(c.anamnesisVersion!)}</Chip>
								) : null}
								{anamnesisApproved ? (
									<Chip tone="green">{t.detail.anamnesisApproved(review.anamnesisVersion!)}</Chip>
								) : v.anamnesis && api?.approveAnamnesis ? (
									<>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={busy}
											onClick={() => approveAnamnesis(false)}
										>
											<CheckIcon data-icon="inline-start" />
											{t.detail.approveAnamnesis}
										</Button>
										{api.nextPendingReview ? (
											<Button
												type="button"
												size="sm"
												disabled={busy}
												onClick={() => approveAnamnesis(true)}
											>
												{t.detail.approveAndNext}
											</Button>
										) : null}
									</>
								) : null}
							</span>
						</div>
					</CardHeader>
					<CardContent>
						{v.anamnesis ? (
							<ScrollArea className="h-[70vh]">
								<div className="divide-y divide-border pr-4">
									{(
										Object.keys(t.sections).filter(
											(k) => k !== "historico",
										) as AnamnesisSectionKey[]
									).map((key) => {
										const sec = v.anamnesis?.[key];
										if (!sec) return null;
										const pending = sec.content.startsWith("A preencher pelo médico");
										return (
											<div key={key} className="py-4 first:pt-1 last:pb-1">
												<div className="flex items-start justify-between gap-2">
													<h3 className="text-sm font-semibold">{t.sections[key]}</h3>
													<div className="flex shrink-0 items-center gap-1.5">
														{sec.evidence.length ? (
															<Button
																type="button"
																variant="ghost"
																size="sm"
																className="aria-pressed:bg-info/10 aria-pressed:text-info"
																aria-pressed={evidence?.section === key}
																title={t.detail.evidenceTitle}
																onClick={() =>
																	setEvidence(
																		evidence?.section === key
																			? null
																			: { section: key, sentences: sec.evidence },
																	)
																}
															>
																<QuoteIcon data-icon="inline-start" />
																{evidence?.section === key
																	? t.detail.hideEvidence
																	: t.detail.showEvidence}
															</Button>
														) : null}
														<Badge
															variant="secondary"
															className={`text-[10px] ring-1 ${CONF_STYLE[sec.confidence]}`}
														>
															{t.confidence[sec.confidence]}
														</Badge>
													</div>
												</div>
												<p
													className={`mt-2 text-sm leading-relaxed whitespace-pre-wrap ${
														pending ? "text-muted-foreground italic" : "text-foreground"
													}`}
												>
													{sec.content || t.detail.notReported}
												</p>
												{sec.evidence.length ? (
													<details className="mt-2">
														<summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
															{t.detail.evidence(sec.evidence.length)}
														</summary>
														<ul className="mt-1 list-inside list-disc text-[11px] text-muted-foreground">
															{sec.evidence.map((ev) => (
																<li key={ev.slice(0, 40)}>“{ev}”</li>
															))}
														</ul>
													</details>
												) : null}
											</div>
										);
									})}
								</div>
							</ScrollArea>
						) : (
							<Empty className="border bg-card px-6 py-14">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<ClipboardListIcon />
									</EmptyMedia>
									<EmptyTitle>{t.detail.noAnamnesisTitle}</EmptyTitle>
									<EmptyDescription>{t.detail.noAnamnesisDescription}</EmptyDescription>
								</EmptyHeader>
								{/* ZK extract is the client-side BYOK path (T-146) —
								 * the server adapter is non-ZK only. */}
								{!zk && api?.generateAnamnesis && v.transcript?.trim() ? (
									<EmptyContent>
										<Button type="button" size="sm" disabled={busy} onClick={generateAnamnesis}>
											{t.detail.generateAnamnesis}
										</Button>
									</EmptyContent>
								) : null}
							</Empty>
						)}
					</CardContent>
				</Card>

				{/* ---------- side: transcript ---------- */}
				<Card className="lg:sticky lg:top-20">
					<CardHeader className="border-b">
						<div className="flex items-center justify-between gap-2">
							<CardTitle>{t.common.transcript}</CardTitle>
							{review.transcriptAt ? (
								<Chip tone="green">
									{t.detail.transcriptConfirmed(shortDate(review.transcriptAt))}
								</Chip>
							) : api?.reviewTranscript ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={confirmTranscript}
								>
									<CheckIcon data-icon="inline-start" />
									{t.detail.confirmTranscript}
								</Button>
							) : null}
						</div>
					</CardHeader>
					<CardContent>
						<ScrollArea className="h-[70vh]">
							<div className="pr-3" ref={transcriptRef}>
								<AudioTranscriptPanel
									i18n={i18n}
									locale={locale}
									consultationId={c.id}
									audioStatus={v.audioStatus}
									audioSrc={zk ? zkAudioUrl : undefined}
									hasAudio={Boolean(v.audioKey)}
									browserText={v.transcript}
									serverText={v.serverTranscript}
									correctedText={v.correctedTranscript}
									highlight={evidence?.sentences}
									segments={segments}
								/>
							</div>
						</ScrollArea>
					</CardContent>
				</Card>
			</div>
			<Toast toast={toast} onClose={() => setToast(null)} />
		</PageContainer>
	);
}
