import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	ArrowLeftIcon,
	CalendarIcon,
	CheckIcon,
	ClipboardCheckIcon,
	PencilIcon,
	QuoteIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import type { Locale as CalendarLocale } from "react-day-picker";
import { enUS, es, ptBR } from "react-day-picker/locale";

import type { Anamnesis, AnamnesisSectionKey } from "@ktb/anamnesis";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { LocalDateTime } from "@ktb/views/views";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ktbhealth/ui/components/card";
import { Calendar } from "@ktbhealth/ui/components/calendar";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ktbhealth/ui/components/empty";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Popover, PopoverContent, PopoverTrigger } from "@ktbhealth/ui/components/popover";
import { ScrollArea } from "@ktbhealth/ui/components/scroll-area";

import { parseTranscriptSegments, resolveSegmentStart, type TranscriptSegment } from "../segments.ts";
import {
	parseTranscriptEdits,
	serializeTranscriptEdits,
	type TranscriptEditEntry,
	type TranscriptEditsBase,
} from "../transcript-edits.ts";
import { bytesToB64, projectTranscript, TranscriptEditSession } from "../transcript-projection.ts";
import { consultationMessages, I18N_NAMESPACE } from "../i18n.ts";
import { isDeferred, reviewDone, type ConsultationListItem } from "./ConsultationsPage.tsx";
import type { ConsultationDetail, ConsultationDetailApi } from "./ConsultationDetailPage.tsx";
import { AudioTranscriptPanel, ConsultationAudioPlayer } from "./-transcript.tsx";
import { BADGE_TONES, CONF_STYLE } from "./-ui.ts";
import { decryptConsultation, isEnvelope, parseAnamnesis, type ConsultationZk } from "../zk.ts";

/** Whisper `avg_logprob` below this marks a segment as uncertain — the
 * "conflict markers" of the PR-review metaphor. */
const UNCERTAIN_LOGPROB = -0.5;

const CALENDAR_LOCALES: Record<string, CalendarLocale> = {
	en: enUS,
	"pt-BR": ptBR,
	es,
};

type Step = "transcript" | "anamnesis";

/** Which stored column the edit log projects over — the pin written on
 * the first save wins so late pipeline stages never rebase old ops. */
function baseText(c: ConsultationDetail): string {
	const pick = (b: TranscriptEditsBase) =>
		b === "corrected"
			? (c.correctedTranscript ?? c.serverTranscript ?? c.transcript)
			: b === "server"
				? (c.serverTranscript ?? c.transcript)
				: c.transcript;
	if (c.transcriptEditsBase === "corrected") return pick("corrected");
	if (c.transcriptEditsBase === "server") return pick("server");
	if (c.transcriptEditsBase === "transcript") return pick("transcript");
	return c.correctedTranscript ?? c.serverTranscript ?? c.transcript;
}

const fmtTime = (s: number) =>
	`${Math.floor(s / 60)}:${Math.floor(s % 60)
		.toString()
		.padStart(2, "0")}`;

/**
 * Guided end-of-day review (PL-023): a PR-review-style shell where the
 * physician clears the pending queue item by item — transcript step
 * (karaoke + inline corrections over a Loro edit log) then anamnesis
 * step (evidence on click, approve & next). Viewing stays on the
 * detail page; this screen is for *working*.
 */
export function ReviewModePage({
	queue,
	c,
	author,
	api,
	i18n,
	locale = "en",
	portalBase,
	zk,
}: {
	/** Pending + deferred queue rows for the rail (PL-022 list shape). */
	queue: readonly ConsultationListItem[];
	/** Current item; null renders the queue overview / session summary. */
	c: ConsultationDetail | null;
	/** Author id stamped into new edit-log entries. */
	author?: string | null;
	api?: ConsultationDetailApi;
	i18n?: PageI18nSlice;
	locale?: string;
	portalBase: string;
	zk?: ConsultationZk;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const navigate = useNavigate();
	const router = useRouter();
	const now = Date.now();
	const [doneIds, setDoneIds] = useState<readonly number[]>([]);
	const pending = queue.filter(
		(q) => !isDeferred(q, now) && !reviewDone(q) && !doneIds.includes(q.id),
	);
	const deferred = queue.filter(
		(q) => isDeferred(q, now) && !reviewDone(q) && !doneIds.includes(q.id),
	);
	const markDone = (id: number) => setDoneIds((ids) => [...ids, id]);
	const reviewHref = (id: number | null) =>
		id === null ? `${portalBase}/review` : `${portalBase}/review/${id}`;
	/** Next pending id in rail order (id DESC — same traversal as
	 * `nextPendingReviewId`), excluding the row just finished. */
	const nextAfter = (id: number | null) => pending.find((q) => q.id !== id)?.id ?? null;
	const goNext = (id: number | null) => void navigate({ to: reviewHref(nextAfter(id)) });

	// ---- queue overview / session summary (no item selected) ----
	if (c === null) {
		return (
			<PageContainer className="max-w-none">
				<PageHeader
					title={t.review.title}
					actions={
						<Button
							variant="ghost"
							size="sm"
							nativeButton={false}
							render={<Link to={`${portalBase}/consultations`} />}
						>
							<ArrowLeftIcon data-icon="inline-start" />
							{t.review.backToConsultations}
						</Button>
					}
				/>
				{pending.length === 0 ? (
					<Empty className="border bg-card px-6 py-16">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<ClipboardCheckIcon />
							</EmptyMedia>
							<EmptyTitle>{t.review.queueEmptyTitle}</EmptyTitle>
							<EmptyDescription>
								{t.review.queueEmptyDescription}
								{doneIds.length > 0 ? ` · ${t.review.sessionDone(doneIds.length)}` : ""}
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								variant="outline"
								size="sm"
								nativeButton={false}
								render={<Link to={`${portalBase}/consultations`} />}
							>
								{t.review.backToConsultations}
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<Card>
						<CardHeader>
							<CardTitle className="text-base">{t.review.queueLabel}</CardTitle>
							<span className="text-xs text-muted-foreground">
								{t.review.pendingCount(pending.length)}
							</span>
						</CardHeader>
						<CardContent className="p-0">
							<QueueList items={pending} href={reviewHref} t={t} />
							{deferred.length > 0 ? (
								<QueueList items={deferred} href={reviewHref} t={t} dimmed />
							) : null}
						</CardContent>
					</Card>
				)}
			</PageContainer>
		);
	}

	// ---- item view ----
	const transcriptOk = c.transcriptReviewedAt != null;
	const anamnesisOk =
		c.anamnesisReviewedVersion != null && c.anamnesisReviewedVersion === c.anamnesisVersion;

	return (
		<PageContainer className="max-w-none">
			<PageHeader
				title={c.patientName ?? `#${c.id}`}
				actions={
					<div className="flex items-center gap-2">
						{api?.deferConsultation ? (
							<DeferControl
								c={c}
								api={api}
								locale={locale}
								label={t.detail.deferLabel}
								onDone={() => void router.invalidate()}
							/>
						) : null}
						<Button
							variant="ghost"
							size="sm"
							nativeButton={false}
							render={<Link to={reviewHref(null)} />}
						>
							<ArrowLeftIcon data-icon="inline-start" />
							{t.review.queueLabel}
						</Button>
					</div>
				}
			/>
			<div className="grid gap-6 lg:grid-cols-[280px_1fr]">
				<aside className="space-y-1">
					<p className="px-2 pb-2 text-xs font-medium text-muted-foreground">
						{t.review.queueLabel} · {t.review.pendingCount(pending.length)}
						{doneIds.length > 0 ? ` · ${t.review.sessionDone(doneIds.length)}` : ""}
					</p>
					<QueueList items={pending} href={reviewHref} t={t} currentId={c.id} />
					{deferred.length > 0 ? (
						<QueueList items={deferred} href={reviewHref} t={t} currentId={c.id} dimmed />
					) : null}
				</aside>
				<ReviewItem
					key={c.id}
					c={c}
					api={api}
					t={t}
					i18n={i18n}
					locale={locale}
					author={author}
					zk={zk}
					transcriptOk={transcriptOk}
					anamnesisOk={anamnesisOk}
					onFinish={() => {
						markDone(c.id);
						goNext(c.id);
					}}
				/>
			</div>
		</PageContainer>
	);
}

type Slice = ReturnType<typeof consultationMessages>;

const AUDIO_IN_FLIGHT = new Set(["stored", "queued", "processing"]);

/** Steps still owed on a queue row — mirrors `reviewDone`: transcript
 * unstamped, and anamnesis whose approved version is missing or stale. */
const pendingSteps = (q: ConsultationListItem, t: Slice): string[] => {
	const steps: string[] = [];
	if (q.transcriptReviewedAt == null) steps.push(t.review.stepTranscript);
	if (q.hasAnamnesis && q.anamnesisReviewedVersion !== q.anamnesisVersion) {
		steps.push(t.review.stepAnamnesis);
	}
	return steps;
};

/** One rail/overview row: patient, chief complaint, recording duration
 * and the pending steps — the doctor picks what fits the time they
 * have (a 4-min item vs a 30-min one). */
function QueueList({
	items,
	href,
	t,
	currentId,
	dimmed,
}: {
	items: readonly ConsultationListItem[];
	href: (id: number | null) => string;
	t: Slice;
	currentId?: number;
	dimmed?: boolean;
}) {
	return (
		<ul className={`divide-y divide-border ${dimmed ? "opacity-60" : ""}`}>
			{items.map((q) => {
				const chips: { label: string; tone: string }[] = pendingSteps(q, t).map((s) => ({
					label: s,
					tone: BADGE_TONES.blue,
				}));
				if (q.audioKey === null)
					chips.push({ label: t.review.noAudioTag, tone: BADGE_TONES.neutral });
				else if (AUDIO_IN_FLIGHT.has(q.audioStatus ?? "")) {
					chips.push({ label: t.review.audioProcessingTag, tone: BADGE_TONES.blue });
				}
				if (dimmed) chips.push({ label: t.review.deferredTag, tone: BADGE_TONES.neutral });
				return (
					<li key={q.id}>
						<Link
							to={href(q.id)}
							className={`flex items-start gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-muted/60 ${
								q.id === currentId ? "bg-muted" : ""
							}`}
						>
							<div className="min-w-0 flex-1 space-y-1">
								<div className="flex items-center gap-2">
									<span className={`truncate ${q.id === currentId ? "font-medium" : ""}`}>
										{q.patientName ?? `#${q.id}`}
									</span>
									{q.audioDurationSec != null ? (
										<span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
											{fmtTime(q.audioDurationSec)}
										</span>
									) : null}
								</div>
								{q.chiefComplaint ? (
									<p className="truncate text-xs text-muted-foreground">{q.chiefComplaint}</p>
								) : null}
								{chips.length > 0 ? (
									<div className="flex flex-wrap items-center gap-1">
										{chips.map((chip) => (
											<Badge
												key={chip.label}
												variant="secondary"
												className={`text-[10px] ring-1 ${chip.tone}`}
											>
												{chip.label}
											</Badge>
										))}
									</div>
								) : null}
							</div>
							<span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
								<LocalDateTime value={q.createdAt} />
							</span>
						</Link>
					</li>
				);
			})}
		</ul>
	);
}

/** The two-step work surface for the selected consultation. */
function ReviewItem({
	c,
	api,
	t,
	i18n,
	locale,
	author,
	zk,
	transcriptOk,
	anamnesisOk,
	onFinish,
}: {
	c: ConsultationDetail;
	api?: ConsultationDetailApi;
	t: Slice;
	i18n?: PageI18nSlice;
	locale: string;
	author?: string | null;
	zk?: ConsultationZk;
	transcriptOk: boolean;
	anamnesisOk: boolean;
	/** Stamp + advance: the item is fully reviewed. */
	onFinish: () => void;
}) {
	const [step, setStep] = useState<Step>(transcriptOk ? "anamnesis" : "transcript");
	const [localTranscriptOk, setLocalTranscriptOk] = useState(transcriptOk);
	const [localAnamnesisOk, setLocalAnamnesisOk] = useState(anamnesisOk);
	// Edits made in this mounted view — feeds the projection + the
	// "unconfirmed edits" chip without waiting for a refetch.
	const [newEdits, setNewEdits] = useState<readonly TranscriptEditEntry[]>([]);

	// ZK overlay: decrypted ciphered fields (transcript, segments,
	// edits). Non-ZK rows arrive plaintext and skip this entirely.
	const [dec, setDec] = useState<Partial<ConsultationDetail>>({});
	useEffect(() => {
		if (!zk) return;
		let live = true;
		void decryptConsultation(zk.keyring, zk.api, { ...c, anamnesis: c.anamnesisRaw ?? null })
			.then((row) => {
				if (!live || row === null) return;
				const plain = (x: unknown): string | null =>
					typeof x === "string" && isEnvelope(x) ? null : ((x as string | null) ?? null);
				setDec({
					transcript: typeof row.transcript === "string" ? row.transcript : c.transcript,
					serverTranscript: plain(row.serverTranscript),
					correctedTranscript: plain(row.correctedTranscript),
					transcriptSegments: plain(row.transcriptSegments),
					transcriptEdits: plain(row.transcriptEdits),
					anamnesis: parseAnamnesis(row.anamnesis) ?? c.anamnesis,
				});
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [zk, c]);
	const v = { ...c, ...dec };

	const storedEdits = useMemo(() => parseTranscriptEdits(v.transcriptEdits), [v.transcriptEdits]);
	const entries = useMemo(() => [...storedEdits, ...newEdits], [storedEdits, newEdits]);
	const base = baseText(v);
	const projected = useMemo(() => projectTranscript(base, entries), [base, entries]);
	const segments = useMemo(
		() => parseTranscriptSegments(v.transcriptSegments),
		[v.transcriptSegments],
	);
	// The stamp binds the op-count at confirm time (PL-023): edits made
	// after the last confirmation surface as "unconfirmed", never as a
	// silent new truth.
	const reviewedOps = localTranscriptOk ? entries.length : (v.transcriptReviewedEdits ?? 0);
	const unconfirmedEdits = Math.max(0, entries.length - reviewedOps);
	const stamped = v.transcriptReviewedAt != null || localTranscriptOk;
	const confirmed = stamped && unconfirmedEdits === 0;
	const anamnesis = v.anamnesis;

	return (
		<div className="space-y-4">
			{/* Step tabs — order suggested, never gated. */}
			<div className="flex items-center gap-1 rounded-lg border bg-card p-1 w-fit">
				{(["transcript", "anamnesis"] as const).map((s) => (
					<button
						key={s}
						type="button"
						onClick={() => setStep(s)}
						className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
							step === s
								? "bg-primary/10 text-primary font-medium"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						{(s === "transcript" ? confirmed : localAnamnesisOk) ? (
							<CheckIcon className="size-3.5 text-success" />
						) : null}
						{s === "transcript" ? t.review.stepTranscript : t.review.stepAnamnesis}
					</button>
				))}
			</div>

			{step === "transcript" ? (
				<TranscriptStep
					c={v}
					api={api}
					t={t}
					author={author}
					entries={entries}
					base={base}
					projected={projected}
					segments={segments}
					unconfirmedEdits={unconfirmedEdits}
					onEdit={(entry) => setNewEdits((e) => [...e, entry])}
					onConfirmed={() => {
						setLocalTranscriptOk(true);
						if (anamnesis !== null) {
							setStep("anamnesis");
						} else {
							onFinish();
						}
					}}
				/>
			) : (
				<AnamnesisStep
					c={v}
					api={api}
					t={t}
					i18n={i18n}
					locale={locale}
					projected={projected}
					segments={segments}
					hasEdits={entries.length > 0}
					onApproved={() => {
						setLocalAnamnesisOk(true);
						onFinish();
					}}
				/>
			)}
		</div>
	);
}

/** Step 1 — confer the transcript against the audio. Rich class gets
 * karaoke + uncertainty jumps + per-segment inline edits; legacy and
 * audio-less rows degrade to player/reader + optional full-text edit. */
function TranscriptStep({
	c,
	api,
	t,
	author,
	entries,
	base,
	projected,
	segments,
	unconfirmedEdits,
	onEdit,
	onConfirmed,
}: {
	c: ConsultationDetail;
	api?: ConsultationDetailApi;
	t: Slice;
	author?: string | null;
	entries: readonly TranscriptEditEntry[];
	base: string;
	projected: string;
	segments: readonly TranscriptSegment[];
	unconfirmedEdits: number;
	onEdit: (entry: TranscriptEditEntry) => void;
	onConfirmed: () => void;
}) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [activeIdx, setActiveIdx] = useState(-1);
	const activeRowRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		activeRowRef.current?.scrollIntoView({ block: "nearest" });
	}, [activeIdx]);
	const [editing, setEditing] = useState<number | "full" | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const sessionRef = useRef<TranscriptEditSession | null>(null);

	const hasAudio = c.audioKey != null;
	const rich = hasAudio && segments.length > 0;
	const uncertainIdxs = useMemo(
		() =>
			segments
				.map((s, i) => ({ s, i }))
				.filter(({ s }) => (s.avgLogprob ?? 0) < UNCERTAIN_LOGPROB)
				.map(({ i }) => i),
		[segments],
	);
	const uncertainSet = useMemo(() => new Set(uncertainIdxs), [uncertainIdxs]);
	// Triage state (PL-023): a passage counts as checked once the
	// playhead actually reaches it or the doctor edits it — both mean
	// it was heard. `unverify` reopens a chip checked by a stray seek.
	const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
	const checkedCount = uncertainIdxs.reduce((n, i) => n + (checked.has(i) ? 1 : 0), 0);
	const markChecked = (i: number) =>
		setChecked((prev) => (prev.has(i) ? prev : new Set(prev).add(i)));
	const unverify = (i: number) =>
		setChecked((prev) => {
			const next = new Set(prev);
			next.delete(i);
			return next;
		});

	/** Latest per-segment replacement text from entry metadata. */
	const segEdits = useMemo(() => {
		const m = new Map<number, string>();
		for (const e of entries) if (e.seg != null && e.text != null) m.set(e.seg, e.text);
		return m;
	}, [entries]);

	/** Char offset of each segment in the BASE text — sequential
	 * `indexOf`, tolerant to drift (falls back to the previous end). */
	const baseOffsets = useMemo(() => {
		const out: number[] = [];
		let from = 0;
		for (const s of segments) {
			const at = base.indexOf(s.text, from);
			out.push(at === -1 ? from : at);
			from = (at === -1 ? from : at) + s.text.length;
		}
		return out;
	}, [segments, base]);

	/** Offset of segment `i` inside the *projected* doc — base offset
	 * plus the length deltas of earlier segment rewrites. */
	const projOffset = (i: number): number => {
		// `i` is always a rendered segment index, so baseOffsets[i] exists.
		let off = baseOffsets[i];
		for (const e of entries) {
			if (e.seg != null && e.text != null && e.seg < i) {
				const orig = segments[e.seg]?.text;
				if (orig != null) off += e.text.length - orig.length;
			}
		}
		return off;
	};

	const session = () => (sessionRef.current ??= new TranscriptEditSession(entries, base));

	const save = async () => {
		/* v8 ignore next -- save only fires from the edit UI, which requires api.saveTranscriptEdits and a non-null editing target */
		if (!api?.saveTranscriptEdits || editing === null) return;
		setBusy(true);
		try {
			const ses = session();
			const delta =
				editing === "full"
					? ses.edit((tx) => {
							tx.delete(0, ses.text().length);
							tx.insert(0, draft);
						})
					: ses.edit((tx) => {
							const i = editing;
							const oldLen = (segEdits.get(i) ?? segments[i].text).length;
							tx.delete(projOffset(i), oldLen);
							tx.insert(projOffset(i), draft);
						});
			const entry: TranscriptEditEntry = {
				at: new Date().toISOString(),
				by: author ?? "local",
				u: bytesToB64(delta),
				...(editing === "full" ? {} : { seg: editing, text: draft }),
			};
			const res = await api.saveTranscriptEdits({
				data: { id: c.id, edits: serializeTranscriptEdits([...entries, entry]) },
			});
			if (res.ok) {
				onEdit(entry);
				if (editing !== "full") markChecked(editing);
				setEditing(null);
			}
		} finally {
			setBusy(false);
		}
	};

	const seek = (i: number) => {
		const el = audioRef.current;
		/* v8 ignore next -- seek is only wired to rendered segments while the player is mounted */
		if (!el || !segments[i]) return;
		el.currentTime = segments[i].start;
		void el.play().catch(() => {});
	};

	const nextUncertain = () => {
		// Unchecked first — the triage drains; wrap to any uncertain once done.
		const next =
			uncertainIdxs.find((i) => i > activeIdx && !checked.has(i)) ??
			uncertainIdxs.find((i) => !checked.has(i)) ??
			uncertainIdxs.find((i) => i > activeIdx) ??
			uncertainIdxs[0];
		if (next != null) seek(next);
	};

	const confirm = () =>
		void (async () => {
			if (!api?.reviewTranscript) return;
			setBusy(true);
			try {
				const res = await api.reviewTranscript({ data: c.id });
				if (res.ok) onConfirmed();
			} finally {
				setBusy(false);
			}
		})();

	// Keyboard flow: space toggles playback, → jumps to the next
	// uncertain segment, C confirms. Skipped while typing in inputs.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement | null;
			if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)) {
				return;
			}
			if (e.key === " ") {
				e.preventDefault();
				const a = audioRef.current;
				if (a) void (a.paused ? a.play().catch(() => {}) : a.pause());
			} else if (e.key === "ArrowLeft") {
				const a = audioRef.current;
				if (a) a.currentTime = Math.max(0, a.currentTime - 10);
			} else if (e.key === "ArrowRight") {
				nextUncertain();
			} else if (e.key === "c" || e.key === "C") {
				confirm();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
			<Card>
				<CardHeader className="flex-row items-center justify-between gap-2">
					<CardTitle className="text-base">{t.review.stepTranscript}</CardTitle>
					<div className="flex items-center gap-2">
						{hasAudio && !rich ? (
							<Badge variant="secondary" className={`text-[10px] ring-1 ${BADGE_TONES.neutral}`}>
								{t.review.legacyAudioBadge}
							</Badge>
						) : null}
						{!hasAudio ? (
							<Badge variant="secondary" className={`text-[10px] ring-1 ${BADGE_TONES.neutral}`}>
								{t.review.noAudioBadge}
							</Badge>
						) : null}
						{unconfirmedEdits > 0 ? (
							<Badge variant="secondary" className={`text-[10px] ring-1 ${BADGE_TONES.blue}`}>
								{t.review.pendingEdits(unconfirmedEdits)}
							</Badge>
						) : null}
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					{rich || hasAudio ? (
						<ConsultationAudioPlayer
							src={`/api/consultations/${c.id}/audio`}
							audioRef={audioRef}
							ariaLabel={t.transcriptPanel.audioLabel}
							segments={segments}
							rateLabel={t.transcriptPanel.playbackRate}
							skipSilenceLabel={t.transcriptPanel.skipSilence}
							onTimeUpdate={(now) => {
								const idx = segments.findIndex((s) => now >= s.start && now < s.end);
								if (idx !== -1) {
									setActiveIdx(idx);
									if (uncertainSet.has(idx)) markChecked(idx);
								}
							}}
						/>
					) : null}

					{rich ? (
						<>
							{/* One stable frame across items — the box is always
							 * here, only its contents vary: chips to drain, or
							 * the high-confidence note. */}
							<div className="space-y-2 rounded-md border p-2.5">
								<div className="flex items-center justify-between gap-2">
									<span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
										<TriangleAlertIcon className="size-3" />
										{t.review.uncertainQueue}
									</span>
									{uncertainIdxs.length > 0 ? (
										<span className="text-[10px] text-muted-foreground tabular-nums">
											{t.review.uncertainProgress(checkedCount, uncertainIdxs.length)}
										</span>
									) : null}
								</div>
								{uncertainIdxs.length === 0 ? (
									<p className="flex items-center gap-2 text-sm text-muted-foreground">
										<CheckIcon className="size-4 shrink-0 text-success" />
										<span>
											<span className="font-medium text-foreground">{t.review.highConfTitle}</span>
											{" — "}
											{t.review.highConfHint}
										</span>
									</p>
								) : (
									<div className="flex flex-wrap items-center gap-1">
										{uncertainIdxs.map((i) => {
											const verified = checked.has(i);
											return (
												<span key={i} className="inline-flex items-center">
													<button
														type="button"
														onClick={() => seek(i)}
														title={segments[i]?.text}
														className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] tabular-nums transition-colors ${
															verified
																? "bg-success/10 text-success ring-1 ring-inset ring-success/25 hover:bg-success/20"
																: "bg-warning/15 text-warning ring-1 ring-inset ring-warning/40 hover:bg-warning/25"
														}`}
													>
														{verified ? <CheckIcon className="size-2.5" /> : null}
														{fmtTime(segments[i].start)}
													</button>
													{verified ? (
														<button
															type="button"
															title={t.review.unverifySegment}
															onClick={() => unverify(i)}
															className="ml-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
														>
															<XIcon className="size-3" />
														</button>
													) : null}
												</span>
											);
										})}
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="ml-auto h-7"
											onClick={nextUncertain}
										>
											{t.review.nextUncertain}
										</Button>
									</div>
								)}
							</div>
							<ScrollArea className="h-[52vh]">
								<div className="space-y-0.5 pr-4">
									{segments.map((s, i) => {
										const edited = segEdits.get(i);
										const shown = edited ?? s.text;
										const uncertain = (s.avgLogprob ?? 0) < UNCERTAIN_LOGPROB;
										return (
											<div
												key={i}
												ref={i === activeIdx ? activeRowRef : undefined}
												className={`group flex gap-2 rounded-md px-2 py-1.5 text-sm leading-relaxed ${
													i === activeIdx ? "bg-primary/10" : ""
												} ${
													uncertain
														? checked.has(i)
															? "ring-1 ring-inset ring-warning/20"
															: "ring-1 ring-inset ring-warning/40"
														: ""
												}`}
											>
												<button
													type="button"
													onClick={() => seek(i)}
													className="shrink-0 font-mono text-[10px] text-muted-foreground hover:text-foreground pt-1"
													title={fmtTime(s.start)}
												>
													{fmtTime(s.start)}
												</button>
												{editing === i ? (
													<div className="flex-1 space-y-2">
														<textarea
															className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
															rows={2}
															value={draft}
															onChange={(e) => setDraft(e.target.value)}
														/>
														<div className="flex gap-2">
															<Button type="button" size="sm" disabled={busy} onClick={save}>
																{t.review.saveEdit}
															</Button>
															<Button
																type="button"
																variant="ghost"
																size="sm"
																onClick={() => setEditing(null)}
															>
																{t.review.cancelEdit}
															</Button>
														</div>
													</div>
												) : (
													<>
														<span className="min-w-0 flex-1 cursor-pointer" onClick={() => seek(i)}>
															{shown}
															{edited != null ? (
																<span className="ml-2 align-middle">
																	<Badge
																		variant="secondary"
																		className={`text-[9px] ring-1 ${BADGE_TONES.blue}`}
																		title={s.text}
																	>
																		{t.review.editedTag}
																	</Badge>
																</span>
															) : null}
														</span>
														{api?.saveTranscriptEdits ? (
															<button
																type="button"
																className="invisible shrink-0 pt-0.5 text-muted-foreground hover:text-foreground group-hover:visible"
																title={t.review.editSegment}
																onClick={() => {
																	setDraft(shown);
																	setEditing(i);
																}}
															>
																<PencilIcon className="size-3.5" />
															</button>
														) : null}
													</>
												)}
											</div>
										);
									})}
								</div>
							</ScrollArea>
						</>
					) : (
						// Legacy / audio-less: read the projected transcript; a
						// whole-doc correction still lands in the same edit log.
						<div className="space-y-2">
							{editing === "full" ? (
								<>
									<textarea
										className="min-h-48 w-full rounded-md border bg-background px-3 py-2 text-sm leading-relaxed"
										value={draft}
										onChange={(e) => setDraft(e.target.value)}
									/>
									<div className="flex gap-2">
										<Button type="button" size="sm" disabled={busy} onClick={save}>
											{t.review.saveEdit}
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => setEditing(null)}
										>
											{t.review.cancelEdit}
										</Button>
									</div>
								</>
							) : (
								<>
									<ScrollArea className="h-[42vh]">
										<p className="whitespace-pre-wrap pr-4 text-sm leading-relaxed">{projected}</p>
									</ScrollArea>
									{api?.saveTranscriptEdits ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => {
												setDraft(projected);
												setEditing("full");
											}}
										>
											<PencilIcon data-icon="inline-start" />
											{t.review.editFullText}
										</Button>
									) : null}
								</>
							)}
						</div>
					)}

					{api?.reviewTranscript ? (
						<div className="border-t pt-4">
							<Button type="button" disabled={busy} onClick={confirm}>
								<CheckIcon data-icon="inline-start" />
								{t.review.confirmAndContinue}
							</Button>
						</div>
					) : null}

					<ShortcutLegend t={t} />
				</CardContent>
			</Card>
		</div>
	);
}

function Kbd({ children }: { children: string }) {
	return (
		<kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
			{children}
		</kbd>
	);
}

function ShortcutLegend({ t }: { t: Slice }) {
	const items: [string, string][] = [
		[t.review.shortcutKeySpace, t.review.shortcutPlayPause],
		["←", t.review.shortcutSeekBack],
		["→", t.review.nextUncertain],
		["C", t.review.shortcutConfirm],
	];
	return (
		<div
			className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground"
			aria-label={t.review.shortcutsTitle}
		>
			<span className="font-medium">{t.review.shortcutsTitle}</span>
			{items.map(([key, label]) => (
				<span key={key} className="flex items-center gap-1.5">
					<Kbd>{key}</Kbd>
					{label}
				</span>
			))}
		</div>
	);
}

/** Step 2 — approve the anamnesis. Sections order by confidence (low
 * first — the "files with conflicts"); clicking one marks its evidence
 * sentences in the transcript pane automatically. */
function AnamnesisStep({
	c,
	api,
	t,
	i18n,
	locale,
	projected,
	segments,
	hasEdits,
	onApproved,
}: {
	c: ConsultationDetail;
	api?: ConsultationDetailApi;
	t: Slice;
	i18n?: PageI18nSlice;
	locale: string;
	projected: string;
	segments: readonly TranscriptSegment[];
	hasEdits: boolean;
	onApproved: () => void;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [evidence, setEvidence] = useState<{
		section: AnamnesisSectionKey;
		sentences: readonly string[];
	} | null>(null);
	const audioRef = useRef<HTMLAudioElement>(null);
	const doc: Anamnesis | null = c.anamnesis;

	const CONF_ORDER: Record<string, number> = { baixa: 0, media: 1, alta: 2 };
	const confRank = (confidence: string): number => {
		// v8 ignore next -- Confidence is a closed union; the fallback only guards malformed stored docs.
		return CONF_ORDER[confidence] ?? 3;
	};
	const sectionKeys = (
		Object.keys(t.sections).filter((k) => k !== "historico") as AnamnesisSectionKey[]
	)
		.filter((k) => doc?.[k])
		.sort((a, b) => confRank(doc![a].confidence) - confRank(doc![b].confidence));

	// Chapter index — each section anchors to its first evidence
	// sentence that resolves to a segment timestamp; chronological.
	const chapters = useMemo(() => {
		if (!doc) return [];
		const list: { key: AnamnesisSectionKey; label: string; time: number }[] = [];
		for (const key of sectionKeys) {
			for (const sentence of doc[key].evidence) {
				const at = resolveSegmentStart(sentence, segments);
				if (at !== undefined) {
					list.push({ key, label: t.sections[key], time: at });
					break;
				}
			}
		}
		return list.sort((a, b) => a.time - b.time);
	}, [doc, segments, t]);

	const seekChapter = (time: number) => {
		const el = audioRef.current;
		if (!el) return;
		el.currentTime = time;
		void el.play().catch(() => {});
	};

	const approve = () =>
		void (async () => {
			/* v8 ignore next -- the approve button only renders when api.approveAnamnesis exists */
			if (!api?.approveAnamnesis) return;
			setBusy(true);
			try {
				const res = await api.approveAnamnesis({ data: c.id });
				if (res.ok) onApproved();
			} finally {
				setBusy(false);
			}
		})();

	const regenerate = () =>
		void (async () => {
			/* v8 ignore next -- both regenerate entry points are gated on api.generateAnamnesis */
			if (!api?.generateAnamnesis) return;
			setBusy(true);
			try {
				const res = await api.generateAnamnesis({
					data: {
						consultationId: c.id,
						transcript: projected,
						...(c.patientId === null ? {} : { patientId: c.patientId }),
					},
				});
				if (res.ok) void router.invalidate();
			} finally {
				setBusy(false);
			}
		})();

	if (doc === null) {
		return (
			<Empty className="border bg-card px-6 py-14">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<QuoteIcon />
					</EmptyMedia>
					<EmptyTitle>{t.detail.noAnamnesisTitle}</EmptyTitle>
					<EmptyDescription>{t.detail.noAnamnesisDescription}</EmptyDescription>
				</EmptyHeader>
				{api?.generateAnamnesis && projected.trim() ? (
					<EmptyContent>
						<Button type="button" size="sm" disabled={busy} onClick={regenerate}>
							{t.detail.generateAnamnesis}
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}

	return (
		<div className="grid gap-4 xl:grid-cols-2">
			<Card>
				<CardHeader>
					<CardTitle className="text-base">{t.review.stepTranscript}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{chapters.length > 0 ? (
						<div
							className="flex flex-wrap gap-1.5"
							aria-label={t.review.chapters}
						>
							{chapters.map((ch) => (
								<button
									key={ch.key}
									type="button"
									onClick={() => seekChapter(ch.time)}
									className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									{ch.label} · {fmtTime(ch.time)}
								</button>
							))}
						</div>
					) : null}
					<AudioTranscriptPanel
						consultationId={c.id}
						audioStatus={c.audioStatus}
						hasAudio={c.audioKey != null}
						browserText={c.transcript}
						serverText={c.serverTranscript}
						correctedText={projected}
						i18n={i18n}
						locale={locale}
						highlight={evidence?.sentences}
						segments={segments}
						audioRef={audioRef}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="flex-row items-center justify-between gap-2">
					<CardTitle className="text-base">{t.review.stepAnamnesis}</CardTitle>
					{hasEdits ? (
						<span className="flex items-center gap-2">
							<span className="text-[11px] text-muted-foreground">{t.review.staleAnamnesis}</span>
							{api?.generateAnamnesis ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={regenerate}
								>
									{t.review.regenerateAnamnesis}
								</Button>
							) : null}
						</span>
					) : null}
				</CardHeader>
				<CardContent>
					<ScrollArea className="h-[58vh]">
						<div className="divide-y divide-border pr-4">
							{sectionKeys.map((key) => {
								const sec = doc[key];
								const pending = sec.content.startsWith("A preencher pelo médico");
								const active = evidence?.section === key;
								return (
									<div
										key={key}
										className={`cursor-pointer py-4 first:pt-1 last:pb-1 rounded-md px-2 -mx-2 transition-colors ${
											active ? "bg-info/10" : "hover:bg-muted/50"
										}`}
										onClick={() =>
											setEvidence(active ? null : { section: key, sentences: sec.evidence })
										}
									>
										<div className="flex items-start justify-between gap-2">
											<h3 className="text-sm font-semibold">{t.sections[key]}</h3>
											<Badge
												variant="secondary"
												className={`text-[10px] ring-1 ${CONF_STYLE[sec.confidence]}`}
											>
												{t.confidence[sec.confidence]}
											</Badge>
										</div>
										<p
											className={`mt-2 text-sm leading-relaxed whitespace-pre-wrap ${
												pending ? "text-muted-foreground italic" : "text-foreground"
											}`}
										>
											{sec.content || t.detail.notReported}
										</p>
										{sec.evidence.length ? (
											<p className="mt-1 text-[11px] text-muted-foreground">
												<QuoteIcon className="mr-1 inline size-3" />
												{t.detail.evidence(sec.evidence.length)}
											</p>
										) : null}
									</div>
								);
							})}
						</div>
					</ScrollArea>
					{api?.approveAnamnesis ? (
						<div className="border-t pt-4">
							<Button type="button" disabled={busy} onClick={approve}>
								<CheckIcon data-icon="inline-start" />
								{t.detail.approveAndNext}
							</Button>
						</div>
					) : null}
				</CardContent>
			</Card>
		</div>
	);
}

/** Defer popover — same calendar pattern as the detail page, kept here
 * so parking an item works without leaving the queue. */
function DeferControl({
	c,
	api,
	locale,
	label,
	onDone,
}: {
	c: ConsultationDetail;
	api: ConsultationDetailApi;
	locale: string;
	label: string;
	onDone: () => void;
}) {
	const [open, setOpen] = useState(false);
	const defer = (until: Date) =>
		void api.deferConsultation!({
			data: { id: c.id, until: until.toISOString() },
		}).then((res) => {
			if (res.ok) {
				setOpen(false);
				onDone();
			}
		});
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger render={<Button variant="outline" size="sm" />}>
				<CalendarIcon data-icon="inline-start" />
				{label}
			</PopoverTrigger>
			<PopoverContent className="w-auto p-0" align="end">
				<Calendar
					mode="single"
					locale={CALENDAR_LOCALES[locale] ?? enUS}
					disabled={{ before: new Date() }}
					onSelect={(d) => {
						/* v8 ignore next -- rdp single mode re-fires the same day; undefined only arrives via keyboard nav edge cases */
						if (d) defer(d);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}
