import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type Ref,
	type RefObject,
} from "react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { FastForwardIcon, PencilIcon } from "lucide-react";

import { sentenceDiff, type SentencePair } from "@ktb/transcript-diff";

import {
	AudioPlayer,
	AudioPlayerControlBar,
	AudioPlayerDurationDisplay,
	AudioPlayerElement,
	AudioPlayerMuteButton,
	AudioPlayerPlayButton,
	AudioPlayerSeekBackwardButton,
	AudioPlayerSeekForwardButton,
	AudioPlayerTimeDisplay,
	AudioPlayerTimeRange,
	AudioPlayerVolumeRange,
} from "@ktbhealth/ui/components/ai-elements/audio-player";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";

import { BADGE_TONES, speakerNumber, speakerTone } from "./-ui.ts";
import { SpeakerChatRow } from "./-chat.tsx";
import { consultationMessages, I18N_NAMESPACE } from "../i18n.ts";
import type { TranscriptSegment } from "../segments.ts";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fmtTime = (s: number) =>
	`${Math.floor(s / 60)}:${Math.floor(s % 60)
		.toString()
		.padStart(2, "0")}`;

/**
 * Builds a case-insensitive matcher for verbatim evidence sentences.
 * Whitespace runs become `\s+` so a stored sentence still matches when
 * the rendered transcript wraps or collapses spacing differently; the
 * matched (original) text is what renders inside the <mark>.
 */
const DIACRITIC_CLASSES: Record<string, string> = {
	a: "aàáâãä",
	e: "eéèêë",
	i: "iíìîï",
	o: "oóòôõö",
	u: "uúùûü",
	c: "cç",
	n: "nñ",
};

/** One source char → a matching pattern: letters become the
 * diacritic-insensitive class of their base form ("à" and "a" both
 * fold to "a" → `[aàáâãä…]`), everything else stays literal. The
 * LLM's evidence text normalizes accents the ASR dropped — and the
 * raw segment keeps them — so a literal match misses the mark. */
const charPattern = (ch: string): string => {
	const base = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	const cls = DIACRITIC_CLASSES[base];
	return cls ? `[${cls}${cls.toUpperCase()}]` : escapeRegex(ch);
};

function evidenceRegex(sentences: readonly string[] | undefined): RegExp | null {
	const parts = (sentences ?? [])
		.map((s) =>
			s
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.map((w) => [...w].map(charPattern).join(""))
				.join("\\s+"),
		)
		.filter((s) => s.length > 0);
	return parts.length ? new RegExp(`(${parts.join("|")})`, "gi") : null;
}

/** Splits `text` on every evidence match; captures become <mark> nodes. */
function markedText(text: string, re: RegExp): ReactNode[] {
	return text.split(re).map((part, i) =>
		i % 2 === 1 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: static split parts
			<mark key={i} className="rounded bg-info/15 px-0.5 text-info ring-1 ring-inset ring-info/25">
				{part}
			</mark>
		) : (
			part
		),
	);
}

/** "Doctor: text" lines become chat-style bubbles. */
function Transcript({
	text,
	emptyLabel,
	highlight,
}: {
	text: string;
	emptyLabel: string;
	/** Evidence sentences to mark up in the rendered text. */
	highlight?: readonly string[];
}) {
	const lines = text.split("\n").filter((l) => l.trim());
	const markRe = evidenceRegex(highlight);
	if (!lines.length) return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
	return (
		<div className="space-y-2.5">
			{lines.map((line, i) => {
				const m = line.match(/^([\p{L} ]{2,20}):\s*(.*)$/u);
				const speaker = m?.[1];
				const body = m ? m[2] : line;
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static, ordered transcript lines
						key={i}
						className="text-sm leading-relaxed"
					>
						{speaker ? (
							<Badge
								variant="secondary"
								className={`mr-2 align-baseline ring-1 ${speakerTone(speaker)}`}
							>
								{speaker}
							</Badge>
						) : null}
						<span className="text-foreground">{markRe ? markedText(body, markRe) : body}</span>
					</div>
				);
			})}
		</div>
	);
}

// ---------- audio pipeline (P-015..P-018) ----------

/** Subset of the consultation detail the transcript panel needs. */
export interface AudioPipelineInfo {
	audioStatus?: string | null;
	audioKey?: string | null;
	serverTranscript?: string | null;
	correctedTranscript?: string | null;
}

/** Loose shape returned by `getConsultation` fns — extra fields ignored. */
export interface ConsultationAudioInfo extends AudioPipelineInfo {
	id?: number;
	transcript?: string | null;
}

const IN_FLIGHT = new Set(["stored", "queued", "processing"]);
const TERMINAL = new Set(["none", "done", "failed"]);
const POLL_MS = 3000;
/** Extra polls after "done" — the LLM cleanup lands just after the ASR pass. */
const SETTLE_POLLS = 3;

const nonEmpty = (s: string | null | undefined): s is string =>
	typeof s === "string" && s.trim().length > 0;

/**
 * Poll `getConsultation` while the audio pipeline is in flight, and a
 * few extra ticks after "done" so the corrected transcript (written by
 * the same job, right after the server transcript) is picked up.
 * Returns the latest fetched detail, retained after polling stops.
 */
export function useConsultationAudio<T extends AudioPipelineInfo>(
	fetcher: ((input: { data: number }) => Promise<T | null>) | undefined,
	consultationId: number | null,
): T | null {
	const [state, setState] = useState<{ id: number; data: T } | null>(null);
	useEffect(() => {
		if (!fetcher || consultationId === null) return;
		let cancelled = false;
		let settleLeft = SETTLE_POLLS;
		let timer: ReturnType<typeof setInterval> | undefined;
		// clearInterval(undefined) is a no-op, so no guard is needed.
		const stop = () => clearInterval(timer);
		const tick = async () => {
			try {
				const d = await fetcher({ data: consultationId });
				if (cancelled || !d) return;
				setState({ id: consultationId, data: d });
				const status = d.audioStatus ?? "none";
				if (IN_FLIGHT.has(status)) {
					settleLeft = SETTLE_POLLS;
					return;
				}
				if (TERMINAL.has(status)) {
					// "done" still awaits the LLM cleanup pass; give it a
					// few ticks, then stop. failed/none stop immediately.
					const awaitingCorrected =
						status === "done" && nonEmpty(d.serverTranscript) && !nonEmpty(d.correctedTranscript);
					if (awaitingCorrected && settleLeft-- > 0) return;
					stop();
				}
			} catch {
				// transient fetch failure — keep polling
			}
		};
		void tick();
		timer = setInterval(() => void tick(), POLL_MS);
		return () => {
			cancelled = true;
			stop();
		};
	}, [fetcher, consultationId]);
	return state !== null && state.id === consultationId ? state.data : null;
}

// ---------- original vs corrected transcript view (P-018) ----------

export interface TranscriptView {
	text: string;
	/** Short provenance caption, e.g. "server · whisper large-v3-turbo". */
	source: string;
}

interface TranscriptSourceLabels {
	readonly server: string;
	readonly browser: string;
	readonly corrected: string;
}

/**
 * Raw ASR outputs, server first. The browser transcript joins as a
 * second labeled block when it differs — both are unedited evidence.
 * Captions come localized from the caller's catalog.
 */
function originalBlocks(
	browser: string | null,
	server: string | null,
	labels: TranscriptSourceLabels,
): TranscriptView[] {
	const blocks: TranscriptView[] = [];
	if (nonEmpty(server)) blocks.push({ text: server, source: labels.server });
	if (nonEmpty(browser) && (!nonEmpty(server) || browser.trim() !== server.trim())) {
		blocks.push({ text: browser, source: labels.browser });
	}
	return blocks;
}

function SourceBlock({
	view,
	emptyLabel,
	highlight,
}: {
	view: TranscriptView;
	emptyLabel: string;
	highlight?: readonly string[];
}) {
	return (
		<div>
			<p className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
				{view.source}
			</p>
			<Transcript text={view.text} emptyLabel={emptyLabel} highlight={highlight} />
		</div>
	);
}

/** Inline segment editing for the karaoke view (detail page): when
 * `editing` is provided each row gains a pencil on hover and the row
 * being edited swaps to a textarea.
 */
export interface SegmentEditing {
	/** Per-segment edited text (index → replacement). */
	readonly segEdits: ReadonlyMap<number, string>;
	/** Index currently being edited (null = none). */
	readonly editing: number | null;
	readonly draft: string;
	readonly busy?: boolean;
	readonly onStart: (index: number) => void;
	readonly onDraft: (text: string) => void;
	readonly onSave: () => void;
	readonly onCancel: () => void;
	readonly labels: {
		readonly edit: string;
		readonly save: string;
		readonly cancel: string;
		readonly editedTag: string;
	};
}

/**
 * Karaoke transcript view (PL-023), chat-row style: consecutive
 * same-speaker segments group under one `SpeakerChatRow` (avatar +
 * name header), and each segment keeps its own mm:ss stamp inside the
 * bubble — the line under the playhead highlights live, every line
 * click-seeks. Evidence `highlight` sentences still render as <mark>
 * inside the segment text.
 */
function SegmentsKaraoke({
	segments,
	active,
	highlight,
	onSeek,
	editing,
	speakerLabel,
	unknownSpeaker,
}: {
	segments: readonly TranscriptSegment[];
	/** Index of the segment under the playhead (-1 = none yet). */
	active: number;
	highlight?: readonly string[];
	onSeek: (index: number) => void;
	editing?: SegmentEditing;
	/** Formats `speaker` for the row header (P-118). */
	speakerLabel: (speaker: string) => string;
	/** Header name for segments with no diarized speaker. */
	unknownSpeaker: string;
}) {
	const markRe = evidenceRegex(highlight);
	const activeRef = useRef<HTMLButtonElement>(null);
	const activeRowRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest" });
		activeRowRef.current?.scrollIntoView({ block: "nearest" });
	}, [active]);
	// Speaker-turn grouping: consecutive segments attributed to the
	// same speaker collapse into one avatar/name row — a monologue
	// reads as a single chat turn instead of repeating the speaker on
	// every ASR split.
	const runs = useMemo(() => {
		const out: { speaker?: string; items: { s: TranscriptSegment; i: number }[] }[] = [];
		segments.forEach((s, i) => {
			const last = out[out.length - 1];
			if (last && last.speaker === s.speaker) last.items.push({ s, i });
			else out.push({ speaker: s.speaker, items: [{ s, i }] });
		});
		return out;
	}, [segments]);
	return (
		<div className="space-y-4">
			{runs.map((run) => (
				<SpeakerChatRow
					key={run.items[0]!.i}
					speaker={run.speaker}
					name={run.speaker ? speakerLabel(run.speaker) : unknownSpeaker}
				>
					<div className="space-y-1.5">
						{run.items.map(({ s, i }) => {
							const edited = editing?.segEdits.get(i);
							const shown = edited ?? s.text;
							// Editing adds buttons inside each line — it becomes a
							// div with clickable spans instead of one button (no
							// nested interactives).
							return editing ? (
								<div
									key={i}
									ref={i === active ? activeRowRef : undefined}
									className={`-mx-1 flex gap-2 rounded-md px-1 py-0.5 transition-colors ${
										i === active ? "bg-primary/10" : ""
									}`}
								>
									<button
										type="button"
										onClick={() => onSeek(i)}
										className="shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground tabular-nums hover:text-foreground"
									>
										{fmtTime(s.start)}
									</button>
									{editing.editing === i ? (
										<div className="flex-1 space-y-2">
											<textarea
												className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
												rows={2}
												value={editing.draft}
												onChange={(e) => editing.onDraft(e.target.value)}
											/>
											<div className="flex gap-2">
												<Button
													type="button"
													size="sm"
													disabled={editing.busy}
													onClick={editing.onSave}
												>
													{editing.labels.save}
												</Button>
												<Button type="button" variant="ghost" size="sm" onClick={editing.onCancel}>
													{editing.labels.cancel}
												</Button>
											</div>
										</div>
									) : (
										<>
											<span className="min-w-0 flex-1 cursor-pointer" onClick={() => onSeek(i)}>
												{markRe ? markedText(shown, markRe) : shown}
												{edited != null ? (
													<span className="ml-2 align-middle">
														<Badge
															variant="secondary"
															className={`text-[9px] ring-1 ${BADGE_TONES.blue}`}
															title={s.text}
														>
															{editing.labels.editedTag}
														</Badge>
													</span>
												) : null}
											</span>
											<button
												type="button"
												className="invisible shrink-0 pt-0.5 text-muted-foreground group-hover:visible hover:text-foreground"
												title={editing.labels.edit}
												onClick={() => editing.onStart(i)}
											>
												<PencilIcon className="size-3.5" />
											</button>
										</>
									)}
								</div>
							) : (
								<button
									key={i}
									ref={i === active ? activeRef : undefined}
									type="button"
									onClick={() => onSeek(i)}
									className={`-mx-1 flex w-full gap-2 rounded-md px-1 py-0.5 text-left transition-colors ${
										i === active ? "bg-primary/10" : "hover:bg-muted/50"
									}`}
								>
									<span className="shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
										{fmtTime(s.start)}
									</span>
									<span className="min-w-0">{markRe ? markedText(s.text, markRe) : s.text}</span>
								</button>
							);
						})}
					</div>
				</SpeakerChatRow>
			))}
		</div>
	);
}

const PLAYBACK_RATES: readonly number[] = [1, 1.25, 1.5, 2];
/** Gaps below this are natural speech pauses — only longer ones are
 * treated as silence worth skipping. */
const SILENCE_MIN_GAP = 1.5;
const RATE_PREF_KEY = "ktb.audio.playbackRate";
const SKIP_PREF_KEY = "ktb.audio.skipSilence";

const readPref = (key: string): string | null => {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
};
const writePref = (key: string, value: string) => {
	try {
		globalThis.localStorage?.setItem(key, value);
	} catch {
		/* storage unavailable (private mode / SSR) — preference just resets */
	}
};

interface SilenceGap {
	/** Gap start (= previous segment end). */
	readonly from: number;
	/** Next segment start — the jump target. */
	readonly to: number;
}

/**
 * Consecutive-segment gaps >= SILENCE_MIN_GAP — the silences the
 * auto-skip feature jumps over. Sorted by construction.
 */
function silenceGaps(segments: readonly TranscriptSegment[] | undefined): readonly SilenceGap[] {
	if (!segments || segments.length < 2) return [];
	const gaps: SilenceGap[] = [];
	for (let i = 0; i + 1 < segments.length; i++) {
		const cur = segments[i]!;
		const next = segments[i + 1]!;
		if (next.start - cur.end >= SILENCE_MIN_GAP) {
			gaps.push({ from: cur.end, to: next.start });
		}
	}
	return gaps;
}

const refEl = (ref: Ref<HTMLAudioElement> | undefined): HTMLAudioElement | null =>
	ref && typeof ref !== "function" ? ref.current : null;

/**
 * Consultation playback bar (PL-023): the design-system media-chrome
 * player — play, ±10s seek, time range, duration, volume. The inner
 * <audio> is exposed through `audioRef` so karaoke views can read the
 * playhead and seek programmatically; `onTimeUpdate` feeds the live
 * segment highlight. With `segments`, a silence-skip toggle jumps
 * speech gaps during playback (never while paused or scrubbing); the
 * rate button cycles playback speed. Both prefs persist per browser.
 */
export function ConsultationAudioPlayer({
	src,
	audioRef,
	onTimeUpdate,
	ariaLabel,
	preload = "metadata",
	segments,
	rateLabel = "Playback speed",
	skipSilenceLabel = "Skip silence",
}: {
	src: string;
	/** Ref to the underlying <audio> element (seek/playhead). */
	audioRef?: Ref<HTMLAudioElement>;
	onTimeUpdate?: (currentTime: number) => void;
	ariaLabel?: string;
	preload?: "none" | "metadata" | "auto";
	/** Segment timestamps — enables the silence-skip control. */
	segments?: readonly TranscriptSegment[];
	rateLabel?: string;
	skipSilenceLabel?: string;
}) {
	const gaps = useMemo(() => silenceGaps(segments), [segments]);
	const [rate, setRate] = useState(1);
	const [skipSilence, setSkipSilence] = useState(true);

	// Load persisted prefs after mount (server render can't see
	// localStorage — fixed defaults keep hydration stable).
	useEffect(() => {
		const r = Number(readPref(RATE_PREF_KEY));
		if (PLAYBACK_RATES.includes(r)) setRate(r);
		const s = readPref(SKIP_PREF_KEY);
		if (s !== null) setSkipSilence(s === "1");
	}, []);

	useEffect(() => {
		const a = refEl(audioRef);
		if (a) a.playbackRate = rate;
	}, [audioRef, rate]);

	const cycleRate = () =>
		setRate((r) => {
			const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(r) + 1) % PLAYBACK_RATES.length]!;
			writePref(RATE_PREF_KEY, String(next));
			return next;
		});
	const toggleSkip = () =>
		setSkipSilence((on) => {
			writePref(SKIP_PREF_KEY, on ? "0" : "1");
			return !on;
		});

	return (
		<AudioPlayer className="w-full">
			<AudioPlayerElement
				src={src}
				ref={audioRef}
				preload={preload}
				aria-label={ariaLabel}
				onTimeUpdate={(e) => {
					const a = e.currentTarget;
					if (skipSilence && !a.paused) {
						const t = a.currentTime;
						for (const g of gaps) {
							if (g.from > t) break;
							if (t < g.to) {
								a.currentTime = g.to;
								break;
							}
						}
					}
					onTimeUpdate?.(a.currentTime);
				}}
			/>
			<AudioPlayerControlBar className="flex-wrap">
				<AudioPlayerPlayButton />
				<AudioPlayerSeekBackwardButton />
				<AudioPlayerSeekForwardButton />
				<AudioPlayerTimeDisplay />
				<AudioPlayerTimeRange className="min-w-0 flex-1" />
				<AudioPlayerDurationDisplay />
				<AudioPlayerMuteButton />
				<AudioPlayerVolumeRange className="w-24" />
				<button
					type="button"
					onClick={cycleRate}
					title={rateLabel}
					aria-label={rateLabel}
					className="px-1.5 font-medium text-xs tabular-nums hover:text-foreground"
				>
					{rate}×
				</button>
				{gaps.length > 0 ? (
					<button
						type="button"
						onClick={toggleSkip}
						aria-pressed={skipSilence}
						title={skipSilenceLabel}
						aria-label={skipSilenceLabel}
						className={`px-1 ${skipSilence ? "text-foreground" : "text-muted-foreground/60"} hover:text-foreground`}
					>
						<FastForwardIcon className="size-3.5" />
					</button>
				) : null}
			</AudioPlayerControlBar>
		</AudioPlayer>
	);
}

/** Renders one aligned word — ref struck on del/sub, hyp highlighted
 * on ins/sub, plain on ok. */
function DiffWord({ op }: { op: SentencePair["ops"][number] }) {
	if (op.op === "sub") {
		return (
			<>
				<del className="rounded bg-destructive/10 px-0.5 text-destructive/80">{op.ref}</del>{" "}
				<ins className="rounded bg-success/15 px-0.5 text-success no-underline">{op.hyp}</ins>{" "}
			</>
		);
	}
	if (op.op === "del") {
		return (
			<>
				<del className="rounded bg-destructive/10 px-0.5 text-destructive/80">{op.ref}</del>{" "}
			</>
		);
	}
	if (op.op === "ins") {
		return (
			<>
				<ins className="rounded bg-success/15 px-0.5 text-success no-underline">{op.hyp}</ins>{" "}
			</>
		);
	}
	return <>{op.ref} </>;
}

/** "Only differences" view (T-225): the review audits what the LLM
 * cleanup actually changed — unchanged sentences are filtered out,
 * so a long transcript reduces to its real edit surface. */
function ChangesView({
	pairs,
	emptyLabel,
}: {
	pairs: readonly SentencePair[];
	emptyLabel: string;
}) {
	const changed = pairs.filter((p) => p.ops.some((o) => o.op !== "ok"));
	if (changed.length === 0) {
		return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
	}
	return (
		<div className="space-y-3">
			{changed.map((p, i) => (
				<p key={i} className="text-sm leading-relaxed">
					{p.ops.map((o, j) => (
						<DiffWord key={j} op={o} />
					))}
				</p>
			))}
		</div>
	);
}

/**
 * Transcript area for consultations with (or pending) server-side
 * audio processing: status chip, optional audio playback, and
 * Corrected/Original tabs once an LLM-cleaned transcript exists.
 * Without server data it degrades to the plain browser transcript.
 */
export function AudioTranscriptPanel({
	consultationId,
	audioStatus,
	hasAudio,
	browserText,
	serverText,
	correctedText,
	onActiveText,
	i18n,
	audioSrc,
	highlight,
	locale = "en",
	segments,
	audioRef: audioRefProp,
	segmentEditing,
}: {
	consultationId: number | null;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale — resolves the panel's copy and source captions. */
	locale?: string;
	audioStatus?: string | null;
	hasAudio?: boolean;
	browserText?: string | null;
	serverText?: string | null;
	correctedText?: string | null;
	/** Reports the text currently on screen so callers (anamnesis
	 *  generation) use exactly what the doctor is viewing. */
	onActiveText?: (view: TranscriptView) => void;
	/** Pre-resolved playback URL — the ZK path (T-147) fetches the
	 * ciphertext, decrypts it in the browser and hands an object URL.
	 * `undefined` = fall back to the authenticated endpoint; `null` =
	 * explicitly unavailable (ZK ciphertext that never unlocks must
	 * never fall back to the endpoint). */
	audioSrc?: string | null;
	/** Active evidence sentences — matched substrings render as <mark>. */
	highlight?: readonly string[];
	/** ASR segments (PL-023): when present with audio, the body becomes
	 * a karaoke view — timestamped rows, live playhead highlight,
	 * click-to-seek — instead of the prose blocks. */
	segments?: readonly TranscriptSegment[];
	/** External ref for the inner <audio> — callers that need to seek
	 * programmatically (chapter index, review shortcuts) pass their own;
	 * otherwise the panel owns one. */
	audioRef?: RefObject<HTMLAudioElement | null>;
	/** Inline segment editing (detail page, PL-023) — pencil per karaoke
	 * row + textarea; each save lands in the Loro edit log via the
	 * caller's `onSave`. */
	segmentEditing?: SegmentEditing;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	// Speaker badges (P-118): SPEAKER_NN → localized "Speaker N";
	// named speakers (Doctor/Médico…) keep their label as-is.
	const speakerLabel = (speaker: string): string => {
		const n = speakerNumber(speaker);
		return n !== null ? t.transcriptPanel.speakerN(n) : speaker;
	};
	const [tab, setTab] = useState<"corrected" | "original" | "changes">("corrected");
	const internalRef = useRef<HTMLAudioElement>(null);
	const audioRef = audioRefProp ?? internalRef;
	const [activeIdx, setActiveIdx] = useState(-1);
	const karaoke = useMemo(() => (hasAudio === true ? (segments ?? []) : []), [hasAudio, segments]);
	const seek = (i: number) => {
		const el = audioRef.current;
		if (!el || !karaoke[i]) return;
		el.currentTime = karaoke[i].start;
		void el.play().catch(() => {});
	};
	const status = audioStatus ?? "none";
	const sourceLabels: TranscriptSourceLabels = {
		server: t.transcriptPanel.sourceServer,
		browser: t.transcriptPanel.sourceBrowser,
		corrected: t.transcriptPanel.sourceCorrected,
	};
	const originals = originalBlocks(browserText ?? null, serverText ?? null, sourceLabels);
	const correctedView: TranscriptView | null = nonEmpty(correctedText)
		? { text: correctedText, source: sourceLabels.corrected }
		: null;
	const primaryOriginal = originals[0] ?? null;
	// Tabs only earn their keep when a corrected text exists AND differs
	// from the raw ASR output; otherwise a single pane is clearer.
	const tabbed =
		correctedView !== null &&
		primaryOriginal !== null &&
		correctedView.text.trim() !== primaryOriginal.text.trim()
			? { corrected: correctedView, original: primaryOriginal }
			: null;
	// "Changes" view — sentence-level diff of original vs corrected; only
	// pairs containing a real op are rendered below, so the reviewer
	// audits what the cleanup changed instead of re-reading everything.
	const changes = useMemo(
		() => (tabbed ? sentenceDiff(tabbed.original.text, tabbed.corrected.text) : []),
		[tabbed?.original.text, tabbed?.corrected.text],
	);

	const active: TranscriptView | null = tabbed
		? tab === "original"
			? tabbed.original
			: tabbed.corrected
		: (correctedView ?? primaryOriginal);
	const lastReported = useRef("");
	useEffect(() => {
		if (!active || !onActiveText) return;
		const key = `${active.source}\n${active.text}`;
		if (key === lastReported.current) return;
		lastReported.current = key;
		onActiveText(active);
	}, [active?.text, active?.source, onActiveText]);

	const inFlight = IN_FLIGHT.has(status);
	const statusBadge =
		status === "failed" ? "failed" : inFlight ? "inflight" : correctedView ? "enhanced" : null;
	// `undefined` audioSrc resolves the default endpoint; `null` means
	// the caller knows playback is impossible (ZK locked) — no fallback.
	const playSrc =
		audioSrc === undefined
			? consultationId !== null
				? `/api/consultations/${consultationId}/audio`
				: undefined
			: (audioSrc ?? undefined);

	return (
		<div className="space-y-3">
			{statusBadge ? (
				<div className="flex flex-wrap items-center gap-2">
					{statusBadge === "failed" ? (
						<Badge variant="secondary" className={`ring-1 ${BADGE_TONES.red}`}>
							{t.transcriptPanel.enhancementFailed}
						</Badge>
					) : statusBadge === "inflight" ? (
						<Badge variant="secondary" className={`ring-1 ${BADGE_TONES.blue}`}>
							<span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-info" />
							{status === "stored" ? t.transcriptPanel.audioStored : t.transcriptPanel.enhancing}
						</Badge>
					) : (
						// Reaching this branch means correctedView is non-null
						// (the outer guard requires it when nothing else matched).
						<Badge variant="secondary" className={`ring-1 ${BADGE_TONES.green}`}>
							{t.transcriptPanel.enhanced}
						</Badge>
					)}
				</div>
			) : null}
			{hasAudio && playSrc ? (
				<ConsultationAudioPlayer
					src={playSrc}
					audioRef={audioRef}
					ariaLabel={t.transcriptPanel.audioLabel}
					preload="none"
					segments={segments}
					rateLabel={t.transcriptPanel.playbackRate}
					skipSilenceLabel={t.transcriptPanel.skipSilence}
					onTimeUpdate={(now) => {
						setActiveIdx(karaoke.findIndex((s) => now >= s.start && now < s.end));
					}}
				/>
			) : null}

			{karaoke.length > 0 ? (
				tabbed ? (
					<Tabs
						value={tab === "changes" ? "changes" : "transcript"}
						onValueChange={(v) => setTab(v === "changes" ? "changes" : "corrected")}
						className="w-full"
					>
						<TabsList className="text-xs">
							<TabsTrigger value="transcript">{t.transcriptPanel.tabTranscript}</TabsTrigger>
							<TabsTrigger value="changes">{t.transcriptPanel.tabChanges}</TabsTrigger>
						</TabsList>
						<TabsContent value="transcript" className="pt-2">
							<SegmentsKaraoke
								segments={karaoke}
								active={activeIdx}
								highlight={highlight}
								onSeek={seek}
								editing={segmentEditing}
								speakerLabel={speakerLabel}
								unknownSpeaker={t.transcriptPanel.speakerUnknown}
							/>
						</TabsContent>
						<TabsContent value="changes" className="space-y-3 pt-2">
							<ChangesView pairs={changes} emptyLabel={t.transcriptPanel.noChanges} />
						</TabsContent>
					</Tabs>
				) : (
					<SegmentsKaraoke
						segments={karaoke}
						active={activeIdx}
						highlight={highlight}
						onSeek={seek}
						editing={segmentEditing}
						speakerLabel={speakerLabel}
						unknownSpeaker={t.transcriptPanel.speakerUnknown}
					/>
				)
			) : tabbed ? (
				<Tabs
					value={tab}
					onValueChange={(v) => setTab(v as "corrected" | "original" | "changes")}
					className="w-full"
				>
					<TabsList className="text-xs">
						<TabsTrigger value="corrected">{t.transcriptPanel.tabCorrected}</TabsTrigger>
						<TabsTrigger value="original">{t.transcriptPanel.tabOriginal}</TabsTrigger>
						<TabsTrigger value="changes">{t.transcriptPanel.tabChanges}</TabsTrigger>
					</TabsList>
					<TabsContent value="corrected" className="pt-2">
						<SourceBlock
							view={tabbed.corrected}
							emptyLabel={t.common.noTranscript}
							highlight={highlight}
						/>
					</TabsContent>
					<TabsContent value="original" className="space-y-4 pt-2">
						{originals.map((b) => (
							<SourceBlock
								key={b.source}
								view={b}
								emptyLabel={t.common.noTranscript}
								highlight={highlight}
							/>
						))}
					</TabsContent>
					<TabsContent value="changes" className="space-y-3 pt-2">
						<ChangesView pairs={changes} emptyLabel={t.transcriptPanel.noChanges} />
					</TabsContent>
				</Tabs>
			) : originals.length ? (
				<div className="space-y-4">
					{originals.map((b) => (
						<SourceBlock
							key={b.source}
							view={b}
							emptyLabel={t.common.noTranscript}
							highlight={highlight}
						/>
					))}
				</div>
			) : correctedView ? (
				<SourceBlock
					view={correctedView}
					emptyLabel={t.common.noTranscript}
					highlight={highlight}
				/>
			) : (
				<Transcript text="" emptyLabel={t.common.noTranscript} />
			)}
		</div>
	);
}
