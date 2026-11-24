import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ClipboardListIcon, DownloadIcon, LockIcon, QuoteIcon } from "lucide-react";

import { IntegrityBadge } from "@ktb/integrity/badge";
import { anamnesisToText, factContent } from "@ktb/anamnesis";
import type { Anamnesis, AnamnesisSectionKey, PatientHistory } from "@ktb/anamnesis";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Toast, type ToastData } from "@ktbhealth/ui/components/app-toast";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ktbhealth/ui/components/empty";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { ScrollArea } from "@ktbhealth/ui/components/scroll-area";

import type { ConsultationIntegrityReport } from "../index.ts";
import { BADGE_TONES, CONF_BAR, CONF_STYLE } from "./-ui.ts";
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

/** Sections that read better side by side. */
const WIDE: AnamnesisSectionKey[] = ["queixa_principal", "hda", "hipoteses", "conduta"];

function Chip({
	children,
	tone = "neutral",
}: {
	children: React.ReactNode;
	tone?: "neutral" | "green" | "amber";
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
}

const PIPELINE_IN_FLIGHT = new Set(["stored", "queued", "processing"]);

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
	const [toast, setToast] = useState<ToastData | null>(null);

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
	const v = { ...c, ...(live ?? {}), ...(dec ?? {}) };
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
		<PageContainer>
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
						<Chip tone="amber">{t.detail.consentNotRecorded}</Chip>
					)}
					{c.status === "live" ? <Chip tone="amber">{t.detail.inProgress}</Chip> : null}
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
				<section>
					<h2 className="mb-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
						{t.common.anamnesis}
					</h2>
					{v.anamnesis ? (
						<div className="grid gap-3 sm:grid-cols-2">
							{(
								Object.keys(t.sections).filter((k) => k !== "historico") as AnamnesisSectionKey[]
							).map((key) => {
								const sec = v.anamnesis?.[key];
								if (!sec) return null;
								const pending = sec.content.startsWith("A preencher pelo médico");
								return (
									<Card
										key={key}
										size="sm"
										className={`border-l-4 ${CONF_BAR[sec.confidence]} ${
											WIDE.includes(key) ? "sm:col-span-2" : ""
										}`}
									>
										<CardHeader>
											<CardTitle>{t.sections[key]}</CardTitle>
											<CardAction>
												{sec.evidence.length ? (
													<Button
														type="button"
														variant="ghost"
														size="sm"
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
											</CardAction>
										</CardHeader>
										<CardContent>
											<p
												className={`text-sm leading-relaxed whitespace-pre-wrap ${
													pending ? "text-warning italic" : "text-foreground"
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
										</CardContent>
									</Card>
								);
							})}
						</div>
					) : (
						<Empty className="border bg-card px-6 py-14">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ClipboardListIcon />
								</EmptyMedia>
								<EmptyTitle>{t.detail.noAnamnesisTitle}</EmptyTitle>
								<EmptyDescription>{t.detail.noAnamnesisDescription}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					)}
				</section>

				{/* ---------- side: transcript ---------- */}
				<Card className="lg:sticky lg:top-20">
					<CardHeader className="border-b">
						<CardTitle>{t.common.transcript}</CardTitle>
					</CardHeader>
					<CardContent>
						<ScrollArea className="[&_[data-slot=scroll-area-viewport]]:max-h-[70vh]">
							<div className="pr-3" ref={transcriptRef}>
								<AudioTranscriptPanel
									i18n={i18n}
									locale={locale}
									consultationId={c.id}
									audioStatus={v.audioStatus}
									audioSrc={zkAudioUrl ?? undefined}
									hasAudio={Boolean(v.audioKey)}
									browserText={v.transcript}
									serverText={v.serverTranscript}
									correctedText={v.correctedTranscript}
									highlight={evidence?.sentences}
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
