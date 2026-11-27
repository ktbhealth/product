import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
	ArrowLeftIcon,
	BrainIcon,
	ClipboardListIcon,
	CopyIcon,
	DownloadIcon,
	SparklesIcon,
} from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Dialog } from "@ktbhealth/ui/components/app-dialog";
import { Toast, type ToastData } from "@ktbhealth/ui/components/app-toast";
import { Alert } from "@ktbhealth/ui/components/alert";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button, buttonVariants } from "@ktbhealth/ui/components/button";
import { Card, CardContent, CardHeader } from "@ktbhealth/ui/components/card";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ktbhealth/ui/components/empty";
import { Field, FieldError, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import { Avatar, AvatarFallback } from "@ktbhealth/ui/components/avatar";
import {
	Dialog as PickerDialog,
	DialogContent as PickerDialogContent,
	DialogHeader as PickerDialogHeader,
	DialogTitle as PickerDialogTitle,
} from "@ktbhealth/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ktbhealth/ui/components/dropdown-menu";
import { Label } from "@ktbhealth/ui/components/label";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@ktbhealth/ui/components/sheet";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { ScrollArea } from "@ktbhealth/ui/components/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";
import { Textarea } from "@ktbhealth/ui/components/textarea";
import { anamnesisToText } from "@ktb/anamnesis";
import type { Anamnesis, AnamnesisSectionKey } from "@ktb/anamnesis";
import { SAMPLE_TRANSCRIPT } from "@ktb/anamnesis";
import { encryptToBlob } from "@ktb/crypto/stream";
import { birthDateFromAge, errorMessage, type PatientErrors } from "@ktb/patients/record";
import {
	type AccessChoice,
	type AccessStanding,
	defaultChoice,
	looksLikeEmail,
	NewPatientAccessQuestion,
	PatientAccessCard,
} from "./-patient-access.tsx";
import {
	needsServerFallback,
	type Transcriber,
	type TranscriptionBackend,
} from "@ktb/transcription";

import { BADGE_TONES, CONF_STYLE } from "./-ui.ts";
import {
	AnamnesisSection,
	EncryptionPill,
	ListeningIndicator,
	PatientContextBar,
	RecordingIndicator,
	SpeakerChatRow,
	TranscriptPanelHeader,
} from "./-chat.tsx";
import { consultationMessages, I18N_NAMESPACE } from "../i18n.ts";
import {
	ConsultationControlBar,
	LiveConsultationHeader,
	LiveStatusStrip,
	LiveTranscriptPanel,
	type LiveConsultationLabels,
	type LiveConsultationPatient,
} from "@ktbhealth/ui/components/live-consultation";
import {
	PreconsultationRoom,
	type PreconsultationModality,
	type PreconsultationRoomLabels,
} from "@ktbhealth/ui/components/preconsultation-room";
import {
	AudioTranscriptPanel,
	ConsultationAudioPlayer,
	useConsultationAudio,
	type ConsultationAudioInfo,
	type TranscriptView,
} from "./-transcript.tsx";
import { liveConsultationTurns } from "./-live-turns.ts";
import { patientDek, PATIENT_ENTITY_TYPE } from "@ktb/patients/zk";
import {
	consultationDek,
	encryptAnamnesis,
	encryptConsultationDraft,
	extractAnamnesisZk,
	newConsultationDek,
	signAnamnesis,
	type ConsultationZk,
	type GrantInput,
} from "../zk.ts";
import {
	defaultDraftStore,
	type RecordingDraft,
	type RecordingDraftStore,
} from "../recording-draft.ts";

/** Portal-access state for the save dialog — "ask" renders the retry form. */
type AccessOutcome = {
	readonly patientId: number;
	readonly email: string;
	readonly status: "ask" | "sending" | "sent" | "unsent";
	readonly error: string | null;
};

function fmtElapsed(totalSec: number) {
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

export interface NewConsultationApi {
	getLiveConsultation(input: { data: number }): Promise<{
		transcript: string;
		status: string | null;
	} | null>;
	/** Server-side extraction — refuses ZK tenants (returns null there;
	 * the ZK view path extracts locally instead). */
	extractAnamnesis(input: {
		data: { transcript: string; patientId?: number };
	}): Promise<{ anamnesis: Anamnesis; engine: string } | null>;
	attachAnamnesis(input: {
		data: {
			consultationId: number;
			/** Parsed document for plaintext writes; a `v1.` envelope for
			 * `ciphered: true` writes (T-145). */
			anamnesis: Anamnesis | string;
			engine: string;
			// Tri-state: undefined keeps the link, null clears it.
			patientId?: number | null;
			ciphered?: true;
			grants?: unknown[];
			version?: { contentHash: string; signature: string };
		};
	}): Promise<{ ok: boolean }>;
	/** null when the write is denied or the ZK payload is malformed. */
	saveConsultation(input: { data: unknown }): Promise<{ id: number; updated?: boolean } | null>;
	recordConsent(input: { data: number }): Promise<{ ok: boolean }>;
	/** Quick registration: name + approximate (year-only) birth date. */
	createPatient(input: {
		data: { name: string; birthDate: string };
	}): Promise<
		{ ok: true; patient: { id: number; name: string } } | { ok: false; errors: PatientErrors }
	>;
	/** Optional: refetch after audio upload to track server transcription. */
	getConsultation?(input: { data: number }): Promise<ConsultationAudioInfo | null>;
	/**
	 * Optional: where a patient stands on portal access — after saving,
	 * the doctor is asked whether to send the access email when the linked
	 * patient has none yet. `email` is the address on the patient record.
	 */
	patientAccess?(input: {
		data: number;
	}): Promise<{ email: string | null; hasAccess: boolean } | null>;
	/**
	 * Optional: give the patient portal access under `email` and send
	 * them the access email. `emailed` is false when access was granted
	 * but the message could not be sent.
	 */
	invitePatient?(input: {
		data: { patientId: number; email: string };
	}): Promise<{ ok: true; emailed: boolean } | { ok: false; error: string }>;
	/**
	 * Optional (ZK, T-148): registered portal-device pubkeys of users
	 * holding an active link to `patientId` — save wraps the record DEK
	 * to them so the portal can decrypt it at once.
	 */
	portalReaders?(input: { data: number }): Promise<{
		readonly readers: readonly { readonly readerId: string; readonly wrapPublicKey: string }[];
	} | null>;
}

export function NewConsultationPage({
	initialPatients,
	initialPatientId,
	resumeConsultationId,
	api,
	backend,
	i18n,

	locale = "en",
	portalBase,
	zk,
	physician,
	user,
	liveFlow = true,
}: {
	initialPatients: Array<{ id: number; name: string }>;
	/** Preselect a patient (e.g. "New consultation" from the patient record). */
	initialPatientId?: number;
	/** Pre-created record to fill instead of minting a new one — the
	 * agenda's "start consult" shell (T-257). The first save writes the
	 * transcript into it; ZK tenants skip it (the shell has no DEK). */
	resumeConsultationId?: number;
	api: NewConsultationApi;
	backend: TranscriptionBackend;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host (route loader / panel ctx). */
	locale?: string;
	/** Portal instance base path — internal links stay under it (P-081). */
	portalBase?: string;
	/** ZK context (T-145): present only on ZK tenants — extraction runs
	 * locally and the saved record is encrypted + client-signed before
	 * it leaves the browser. */
	zk?: ConsultationZk;
	/** Clinician display name for the live-flow surfaces (pre-consultation
	 * room avatar, transcript speaker turns). Falls back to the generic
	 * speaker label when the host has no name. */
	physician?: string;
	/** Signed-in account for the room's user menu (name/email + portal
	 * navigation). Absent on hosts that do not resolve a session. */
	user?: { readonly name?: string | null; readonly email: string } | null;
	/** New live-consultation flow: the pre-consultation room before the
	 * first record capture and the LiveConsultation screen while a
	 * record-source capture runs. `false` restores the legacy capture
	 * rail for every source. */
	liveFlow?: boolean;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const portalPath = (path: string) => (portalBase ? `${portalBase}${path}` : path);
	const nc = t.newConsultation;

	const [recording, setRecording] = useState(false);
	// `supported` probes browser APIs, so it differs between the SSR pass
	// (no window → unsupported) and hydration — resolve it after mount.
	const [supported, setSupported] = useState(false);
	const [transcript, setTranscript] = useState("");
	const [partial, setPartial] = useState("");
	const [anamnesis, setAnamnesis] = useState<Anamnesis | null>(null);
	const [engine, setEngine] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [savedId, setSavedId] = useState<number | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveDialog, setSaveDialog] = useState<
		{ kind: "ok"; id: number; updated: boolean } | { kind: "error"; message: string } | null
	>(null);
	// Portal access outcome shown in the save dialog: the up-front choice
	// lands here as sent/unsent, or as an "ask" retry form when the invite
	// failed or the up-front lookup was unavailable.
	const [access, setAccess] = useState<AccessOutcome | null>(null);
	// T-258: the access decision is made up front, per patient —
	// standings come from patientAccess, choices from the card.
	const accessEnabled =
		typeof api.patientAccess === "function" && typeof api.invitePatient === "function";
	const [standings, setStandings] = useState<Readonly<Record<number, AccessStanding>>>({});
	// Patients whose standing was already requested (or is known locally).
	const accessLookedUp = useRef(new Set<number>());
	const [choices, setChoices] = useState<Readonly<Record<number, AccessChoice>>>({});
	const [newPatientAccess, setNewPatientAccess] = useState<AccessChoice>({
		send: true,
		email: "",
	});
	const [error, setError] = useState<string | null>(null);
	const [meetUrl, setMeetUrl] = useState("");
	const [liveId, setLiveId] = useState<number | null>(null);
	const [liveStatus, setLiveStatus] = useState<string | null>(null);
	const [consented, setConsented] = useState(false);
	const [patientId, setPatientId] = useState<number | null>(() =>
		initialPatients.some((p) => p.id === initialPatientId) ? initialPatientId! : null,
	);
	const [patientName, setPatientName] = useState("");
	const [patientAge, setPatientAge] = useState("");
	const [patientError, setPatientError] = useState<string | null>(null);
	const [quickCreatedId, setQuickCreatedId] = useState<number | null>(null);
	const [patients, setPatients] = useState<Array<{ id: number; name: string }>>(() =>
		initialPatients.map((p: { id: number; name: string }) => ({
			id: p.id,
			name: p.name,
		})),
	);
	const transcriberRef = useRef<Transcriber | null>(null);
	const tabRef = useRef<Transcriber | null>(null);
	// Transcript length when each capture session started — lets the
	// server fallback splice out the low-confidence local output.
	const sessionSnapshot = useRef({ mic: 0, tab: 0, dict: 0 });
	const [tabRecording, setTabRecording] = useState(false);
	const [modelStatus, setModelStatus] = useState<string | null>(() => {
		const st = backend.status();
		return st.state === "ready" ? t.newConsultation.modelReady(st.device) : null;
	});
	const [toast, setToast] = useState<ToastData | null>(null);
	const [source, setSource] = useState<"record" | "bot" | "upload">("record");
	const [mode, setMode] = useState<"live" | "dictation">("live");
	const [dictating, setDictating] = useState(false);
	const [elapsedSec, setElapsedSec] = useState(0);
	// One clock for every capture mode — feeds the transcript-header
	// timer and the mm:ss stamps on the live chat rows.
	const captureStartRef = useRef(0);
	const live = recording || tabRecording || dictating;
	const [anamnesisOpen, setAnamnesisOpen] = useState(false);
	// Live-flow (liveFlow prop) stage state: the pre-consultation room
	// modality pick, the patient-picker strip it can reveal, and the
	// latch that keeps the room from reappearing once a session started.
	const [modality, setModality] = useState<PreconsultationModality>("in-person");
	const [roomDone, setRoomDone] = useState(false);
	const [patientPickerOpen, setPatientPickerOpen] = useState(false);
	// Room audio settings: the picked input device feeds both the audio
	// test and the real mic capture (`null` = system default). The mic
	// toggle is preview-only — nothing is captured before Start.
	const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
	const [audioDevices, setAudioDevices] = useState<{ id: string; label: string }[]>([]);
	const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
	const [micMuted, setMicMuted] = useState(false);
	// mm:ss stamps for transcript lines appended during capture —
	// parallel to the non-empty lines, trimmed when the text shrinks.
	const [rowTimes, setRowTimes] = useState<number[]>([]);
	const chatEndRef = useRef<HTMLDivElement>(null);
	// Ages of patients quick-created this session — the only age
	// metadata this page ever sees for the context bar.
	const [createdAges, setCreatedAges] = useState<Record<number, number>>({});
	// Fixed-height workspace frame — measured like the review mode.
	const frameRef = useRef<HTMLDivElement>(null);
	// Audio pipeline (P-015/P-018): after save, the session recording is
	// uploaded and the detail is polled for server/corrected transcripts.
	const [audioConsultId, setAudioConsultId] = useState<number | null>(null);
	const [viewedText, setViewedText] = useState<TranscriptView | null>(null);
	const uploadedAudioFor = useRef(new Set<number>());
	const pendingUploadBlob = useRef<Blob | null>(null);
	// T-222 draft persistence: refs mirror the latest values so the
	// recorder "end" handlers (closures captured at start) persist fresh
	// state; the store is lazily picked once per mount.
	const transcriptRef = useRef("");
	transcriptRef.current = transcript;
	const patientIdRef = useRef(patientId);
	patientIdRef.current = patientId;
	const draftStore = useMemo<RecordingDraftStore>(() => defaultDraftStore(), []);
	const [draft, setDraft] = useState<RecordingDraft | null>(null);
	// Object URLs for the draft blob — the banner previews it; after
	// restore the player moves next to the transcript so the doctor can
	// re-listen while reviewing (URL survives until save/discard/unmount).
	const [draftUrl, setDraftUrl] = useState<string | null>(null);
	const [restoredUrl, setRestoredUrl] = useState<string | null>(null);

	// The ASR engine stays lazy: `backend.load()` only runs when the
	// doctor actually starts a capture (mic / tab / dictation), so the
	// paste/sample path and the server-side upload/bot sources never
	// pay the ~50MB model download. `load` is idempotent — the shared
	// engine promise makes quick source switches race-free.
	useEffect(() => {
		const off = backend.subscribe((m) => {
			if (m.type === "progress") setModelStatus(m.message ?? null);
			if (m.type === "ready") setModelStatus(t.newConsultation.modelReady(m.device));
			if (m.type === "error" && !m.id)
				setModelStatus(t.newConsultation.modelUnavailable(m.message ?? ""));
		});
		return off;
	}, []);

	useEffect(() => {
		const tr = backend.tab();
		tabRef.current = tr;
		return () => tr.stop();
	}, []);

	// The mic transcriber is rebuilt when the room's device picker
	// changes — only reachable pre-capture, so no live session is lost.
	useEffect(() => {
		const tr = backend.mic({ deviceId: micDeviceId ?? undefined });
		transcriberRef.current = tr;
		setSupported(tr.supported);
		return () => {
			tr.stop();
			transcriberRef.current = null;
		};
	}, [micDeviceId]);

	// elapsed clock while any capture is live — header timer + row stamps
	useEffect(() => {
		if (!live) return;
		const i = setInterval(
			() => setElapsedSec(Math.floor((Date.now() - captureStartRef.current) / 1000)),
			500,
		);
		return () => clearInterval(i);
	}, [live]);

	// Chat-workspace frame: pin the page to the viewport (same measured
	// pattern as the review mode) — inner regions carry their own scroll.
	useEffect(() => {
		const el = frameRef.current;
		/* v8 ignore next -- the ref is attached to the always-rendered frame */
		if (!el) return;
		const fit = () => {
			const footer = document.querySelector("footer");
			const reserve = (footer?.getBoundingClientRect().height ?? 0) + 16;
			el.style.height = `${Math.max(320, window.innerHeight - el.getBoundingClientRect().top - reserve)}px`;
		};
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, []);

	// Drop the row stamps the transcript no longer covers — clearing,
	// the server-fallback splice and manual edits shorten the line list.
	useEffect(() => {
		const lines = transcript.split("\n").filter((l) => l.trim()).length;
		setRowTimes((prev) => (prev.length > lines ? prev.slice(0, lines) : prev));
	}, [transcript]);

	// The live chat keeps the newest row in view.
	useEffect(() => {
		// jsdom has no scrollIntoView — the optional call keeps tests quiet.
		chatEndRef.current?.scrollIntoView?.({ block: "nearest" });
	}, [transcript, partial, live]);

	// Look up the picked patient's portal standing once (T-258). Results
	// are keyed by patient, so a late answer for a patient the doctor
	// already switched away from is harmless; until it lands the card
	// stays hidden and a save asks after the fact.
	useEffect(() => {
		if (patientId === null || !accessEnabled || accessLookedUp.current.has(patientId)) return;
		accessLookedUp.current.add(patientId);
		void api.patientAccess!({ data: patientId })
			.then((r): AccessStanding =>
				r === null
					? { status: "unknown" }
					: r.hasAccess
						? { status: "has-access" }
						: { status: "none", email: r.email },
			)
			.catch((): AccessStanding => ({ status: "unknown" }))
			.then((standing) => setStandings((s) => ({ ...s, [patientId]: standing })));
	}, [patientId, accessEnabled, api]);

	// Poll a live bot consultation — transcript grows as events arrive.
	useEffect(() => {
		if (!liveId || liveStatus === "done") return;
		const interval = setInterval(async () => {
			const res = await api.getLiveConsultation({ data: liveId });
			if (!res) return;
			setTranscript(res.transcript);
			setLiveStatus(res.status);
		}, 1500);
		return () => clearInterval(interval);
	}, [liveId, liveStatus]);

	// Poll the saved consultation while the server pipeline works on the
	// uploaded audio (queued → processing → done/failed).
	const audioDetail = useConsultationAudio(
		audioConsultId !== null ? api.getConsultation : undefined,
		audioConsultId,
	);

	async function transcribeAudioBlob(blob: Blob, filename: string): Promise<string> {
		const form = new FormData();
		form.append("audio", blob, filename);
		const res = await fetch("/api/transcribe", { method: "POST", body: form });
		if (!res.ok) throw new Error(t.newConsultation.transcriptionFailedStatus(res.status));
		const { text } = (await res.json()) as { text: string };
		return text;
	}

	async function uploadAudio(file: File) {
		pendingUploadBlob.current = file;
		setBusy(true);
		setError(null);
		try {
			const text = await transcribeAudioBlob(file, file.name);
			setTranscript((t) => (t ? `${t}\n${text}` : text));
		} catch (e) {
			setError(e instanceof Error ? e.message : t.newConsultation.transcriptionFailed);
		} finally {
			setBusy(false);
		}
	}

	/**
	 * ADR-0002 fallback: when a finished capture session looks low-quality
	 * (little transcript per voiced second), re-transcribe the recorded
	 * audio on the server and splice the result in place of the local
	 * lines. No-op for transcribers without stats/recording support.
	 */
	async function maybeServerFallback(mode: "mic" | "tab" | "dict") {
		// T-145: ZK tenants never send audio/transcript to the server —
		// the reprocess fallback is a plaintext upload, so it is skipped.
		if (zk) return;
		const tr = mode === "tab" ? tabRef.current : transcriberRef.current;
		/* v8 ignore next -- refs are assigned in useEffect before any capture ends */
		if (!tr) return;
		const stats = tr.sessionStats?.();
		if (!stats || !needsServerFallback(stats)) return;
		const blob = await tr.recording?.();
		if (!blob) return;
		setModelStatus(t.newConsultation.lowConfidenceReprocessing);
		try {
			const text = await transcribeAudioBlob(blob, "session.webm");
			if (!text.trim()) return;
			const snap = sessionSnapshot.current[mode];
			const label =
				mode === "mic" ? `${t.speakers.doctor}:` : mode === "tab" ? `${t.speakers.patient}:` : "";
			setTranscript((prev) => {
				const base = prev.slice(0, snap).replace(/\s+$/, "");
				const line = label ? `${label} ${text}` : text;
				return base ? `${base}\n${line}` : line;
			});
			setModelStatus(t.newConsultation.transcriptionRedone);
		} catch {
			setModelStatus(null);
		}
	}

	async function sendBot() {
		/* v8 ignore next -- Send bot is disabled while meetUrl is empty */
		if (!meetUrl.trim()) return;
		setError(null);
		setSavedId(null);
		const res = await fetch("/api/bots", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ meetUrl }),
		});
		const data = (await res.json()) as {
			consultationId?: number;
			provider?: string;
			error?: string;
		};
		if (!res.ok || !data.consultationId) {
			setError(data.error ?? t.newConsultation.botFailed(res.status));
			return;
		}
		setLiveId(data.consultationId);
		setLiveStatus("live");
	}

	/** Persist the just-finished session as a draft: blob + transcript +
	 * patient context. `recording()` awaits the recorder's stop, so the
	 * "end" event ordering is safe. */
	const persistDraft = (tr: Transcriber | null) => {
		void tr?.recording?.().then((blob) => {
			if (!blob?.size) return;
			void draftStore.save({
				audio: blob,
				transcript: transcriptRef.current,
				patientId: patientIdRef.current,
				savedAt: Date.now(),
			});
		});
	};

	useEffect(() => {
		let cancelled = false;
		void draftStore.load().then((d: RecordingDraft | null) => {
			if (!cancelled && d) {
				setDraft(d);
				if (typeof URL.createObjectURL === "function") setDraftUrl(URL.createObjectURL(d.audio));
			}
		});
		return () => {
			cancelled = true;
		};
	}, [draftStore]);

	// Revoke object URLs on unmount — blobs can be tens of MB.
	useEffect(
		() => () => {
			for (const u of [draftUrl, restoredUrl])
				if (u && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(u);
		},
		[draftUrl, restoredUrl],
	);

	const restoreDraft = () => {
		/* v8 ignore next -- the restore button only renders while a draft is loaded */
		if (!draft) return;
		pendingUploadBlob.current = draft.audio;
		setTranscript(draft.transcript);
		if (patients.some((p) => p.id === draft.patientId)) setPatientId(draft.patientId);
		setRestoredUrl(draftUrl);
		setDraftUrl(null);
		setDraft(null);
	};

	const discardDraft = () => {
		setDraft(null);
		if (draftUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(draftUrl);
		setDraftUrl(null);
		void draftStore.clear();
	};

	function toggleRecording() {
		const tr = transcriberRef.current;
		/* v8 ignore next -- refs are assigned in useEffect before any click */
		if (!tr) return;
		if (recording) {
			tr.stop();
			setRecording(false);
			return;
		}
		setError(null);
		sessionSnapshot.current.mic = transcript.length;
		// Kick the model download now — it overlaps the mic-permission
		// prompt inside `start` instead of waiting for the stream.
		backend.load();
		// A second channel joining keeps the original clock going.
		if (!live) {
			captureStartRef.current = Date.now();
			setElapsedSec(0);
		}
		tr.start((ev) => {
			if (ev.type === "partial") setPartial(ev.text);
			if (ev.type === "final") {
				setRowTimes((prev) => [...prev, Math.floor((Date.now() - captureStartRef.current) / 1000)]);
				setTranscript((prev) => `${prev}${prev ? "\n" : ""}${t.speakers.doctor}: ${ev.text}`);
				setPartial("");
			}
			if (ev.type === "error") {
				setError(ev.message);
				setRecording(false);
			}
			if (ev.type === "end") {
				setRecording(false);
				setPartial("");
				persistDraft(tr);
				void maybeServerFallback("mic");
			}
		});
		setRecording(true);
	}

	function toggleTabCapture() {
		const tr = tabRef.current;
		/* v8 ignore next -- refs are assigned in useEffect before any click */
		if (!tr) return;
		if (tabRecording) {
			tr.stop();
			setTabRecording(false);
			return;
		}
		setError(null);
		sessionSnapshot.current.tab = transcript.length;
		backend.load();
		if (!live) {
			captureStartRef.current = Date.now();
			setElapsedSec(0);
		}
		tr.start((ev) => {
			if (ev.type === "partial") setPartial(ev.text);
			if (ev.type === "final") {
				setRowTimes((prev) => [...prev, Math.floor((Date.now() - captureStartRef.current) / 1000)]);
				setTranscript((prev) => `${prev}${prev ? "\n" : ""}${t.speakers.patient}: ${ev.text}`);
				setPartial("");
			}
			if (ev.type === "error") {
				setError(ev.message);
				setTabRecording(false);
			}
			if (ev.type === "end") {
				setTabRecording(false);
				setPartial("");
				persistDraft(tr);
				void maybeServerFallback("tab");
			}
		});
		setTabRecording(true);
	}

	/**
	 * Post-consultation dictation: same mic transcriber (Whisper), single
	 * speaker — finals land in the transcript without a speaker prefix
	 * since the narration already describes the whole consultation.
	 */
	function toggleDictation() {
		const tr = transcriberRef.current;
		/* v8 ignore next -- refs are assigned in useEffect before any click */
		if (!tr) return;
		if (dictating) {
			tr.stop();
			setDictating(false);
			return;
		}
		setError(null);
		captureStartRef.current = Date.now();
		setElapsedSec(0);
		sessionSnapshot.current.dict = transcript.length;
		backend.load();
		tr.start((ev) => {
			if (ev.type === "partial") setPartial(ev.text);
			if (ev.type === "final") {
				setRowTimes((prev) => [...prev, Math.floor((Date.now() - captureStartRef.current) / 1000)]);
				setTranscript((prev) => `${prev}${prev ? "\n" : ""}${ev.text}`);
				setPartial("");
			}
			if (ev.type === "error") {
				setError(ev.message);
				setDictating(false);
			}
			if (ev.type === "end") {
				setDictating(false);
				setPartial("");
				persistDraft(tr);
				void maybeServerFallback("dict");
			}
		});
		setDictating(true);
	}

	/**
	 * P-015 client half: push the session recording to R2 after the
	 * consultation exists. The endpoint keeps a single audio object per
	 * consultation, so only one blob is uploaded — the call-tab capture
	 * (both parties) wins over the mic, which wins over an uploaded file.
	 * Fire-and-forget: a failure surfaces as a toast, never blocks save.
	 */
	async function uploadSessionAudio(id: number) {
		if (uploadedAudioFor.current.has(id)) return;
		try {
			const [tabBlob, micBlob] = await Promise.all([
				tabRef.current?.recording?.() ?? Promise.resolve(null),
				transcriberRef.current?.recording?.() ?? Promise.resolve(null),
			]);
			const blob = tabBlob ?? micBlob ?? pendingUploadBlob.current;
			if (!blob || blob.size === 0) return;
			uploadedAudioFor.current.add(id);
			// T-147: under ZK the recording is chunked-encrypted with the
			// consultation DEK before upload — the server stores ciphertext
			// and the Whisper queue never sees it. Fail closed: no grant,
			// no upload.
			let body: Blob = blob;
			let contentType = (blob.type || "audio/webm").split(";")[0]!;
			if (zk) {
				const dek = await consultationDek(zk.keyring, zk.api, id);
				if (!dek) throw new Error("audio upload blocked — record is locked on this device");
				const encrypted = await encryptToBlob(dek, new Uint8Array(await blob.arrayBuffer()));
				// Fresh copy — the typed-array generic must resolve to
				// ArrayBuffer (not ArrayBufferLike) for fetch's BodyInit.
				body = new Blob([new Uint8Array(encrypted)]);
				contentType = "application/octet-stream";
			}
			const res = await fetch(`/api/consultations/${id}/audio`, {
				method: "POST",
				headers: { "content-type": contentType },
				body,
			});
			if (!res.ok) throw new Error(`audio upload failed (${res.status})`);
			setAudioConsultId(id);
		} catch (e) {
			showToast({
				text: t.newConsultation.audioUploadFailed(e instanceof Error ? e.message : "error"),
			});
		}
	}

	async function generate() {
		const text = viewedText?.text ?? transcript;
		/* v8 ignore next -- Generate anamnesis is disabled while transcript is empty */
		if (!text.trim()) return;
		setBusy(true);
		setError(null);
		setSavedId(null);
		try {
			// T-145/T-146: under ZK the transcript never leaves the
			// device for KTB — extraction runs locally through the
			// clinic-configured BYOK port or the heuristic fallback.
			const res = zk
				? await extractAnamnesisZk(text, zk.extractor)
				: await api.extractAnamnesis({
						data: { transcript: text, patientId: patientId ?? undefined },
					});
			if (res === null) {
				setError(t.newConsultation.transcriptionFailed);
				return;
			}
			setAnamnesis(res.anamnesis);
			setEngine(res.engine);
			// The draft lives in the drawer — open it for review.
			setAnamnesisOpen(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	function showToast(t: Omit<ToastData, "id">) {
		setToast({ id: Date.now(), ...t });
	}

	/**
	 * T-148: wrap `dek` to every registered portal device of the
	 * patient's active links (readerKind "patient") and — so the portal
	 * can render the record name — grant the patient-record DEK to the
	 * same readers. Best-effort: a failure never blocks the save; the
	 * portal-access page grant pass is the backstop.
	 */
	async function portalGrants(
		zkCtx: ConsultationZk,
		dek: CryptoKey,
		forPatientId: number | null,
	): Promise<GrantInput[]> {
		if (!api.portalReaders || forPatientId === null) return [];
		try {
			const plan = await api.portalReaders({ data: forPatientId });
			if (!plan || plan.readers.length === 0) return [];
			const wrapAll = async (key: CryptoKey): Promise<GrantInput[]> =>
				Promise.all(
					plan.readers.map(async (reader) => ({
						readerKind: "patient" as const,
						readerPubkey: reader.wrapPublicKey,
						readerId: reader.readerId,
						wrappedDek: await zkCtx.keyring.wrapKeyFor(key, reader.wrapPublicKey),
					})),
				);
			const pDek = await patientDek(zkCtx.keyring, zkCtx.api, forPatientId);
			if (pDek !== null) {
				await zkCtx.api.grant({
					entityType: PATIENT_ENTITY_TYPE,
					entityId: forPatientId,
					grants: await wrapAll(pDek),
				});
			}
			// `await` matters: an unawaited return would escape this try —
			// a bad portal pubkey must fail closed, never block the save.
			return await wrapAll(dek);
		} catch {
			// Best-effort: the portal-access grant pass is the backstop —
			// a failed reader lookup or unwrap must never block the save.
			return [];
		}
	}

	async function save() {
		/* v8 ignore next -- save button only renders with anamnesis and is disabled while saving */
		if (!anamnesis || saving) return;
		setSaving(true);
		try {
			// a consultation already saved/live is updated, never duplicated
			const resumeId = zk ? null : (resumeConsultationId ?? null);
			const existing = liveId ?? savedId ?? resumeId;
			let id: number | null = existing;
			if (existing) {
				let data: Parameters<NewConsultationApi["attachAnamnesis"]>[0]["data"];
				if (zk) {
					// T-145: encrypt the document under the record DEK and
					// sign the canonical hash with this device's key — the
					// server stores ciphertext + the signed version entry.
					const dek = await consultationDek(zk.keyring, zk.api, existing);
					if (dek === null) throw new Error(t.zk.decryptFailed);
					const version = await signAnamnesis(zk.keyring, anamnesis);
					data = {
						consultationId: existing,
						anamnesis: await encryptAnamnesis(dek, anamnesis),
						engine: engine ?? "unknown",
						patientId,
						ciphered: true,
						// T-148: attach may add readers — portal devices of the
						// linked patient ride the same grant wire.
						grants: await portalGrants(zk, dek, patientId),
						version,
					};
				} else {
					data = {
						consultationId: existing,
						anamnesis,
						engine: engine ?? "unknown",
						// null clears a previously linked patient; undefined
						// would keep it (tri-state on the wire).
						patientId,
						// The resumed shell holds no transcript yet — this
						// browser's is the record's (bot-fed rows keep theirs).
						...(existing === resumeId ? { transcript } : {}),
					};
				}
				const r = await api.attachAnamnesis({ data });
				if (!r.ok) throw new Error(t.newConsultation.saveSessionExpired);
			} else {
				let payload: Record<string, unknown>;
				if (zk) {
					// T-145: mint the record DEK, wrap it to every approved
					// clinic device, encrypt transcript + anamnesis and sign
					// the version — grants travel with the create.
					const { dek, grants } = await newConsultationDek(zk.keyring, zk.api);
					// T-148: portal devices of the linked patient join the
					// grant list at creation (readerKind "patient").
					grants.push(...(await portalGrants(zk, dek, patientId)));
					const encrypted = await encryptConsultationDraft(dek, { transcript, anamnesis });
					const version = await signAnamnesis(zk.keyring, anamnesis);
					payload = {
						...encrypted,
						engine: engine ?? "unknown",
						patientId: patientId ?? undefined,
						ciphered: true,
						grants,
						version,
					};
				} else {
					payload = {
						transcript,
						anamnesis,
						engine: engine ?? "unknown",
						patientId: patientId ?? undefined,
					};
				}
				const res = await api.saveConsultation({ data: payload });
				id = res?.id ?? null;
			}
			if (!id) throw new Error(t.newConsultation.saveFailed);
			if (consented) await api.recordConsent({ data: id });
			setSavedId(id);
			// T-145+T-147: the upload runs under ZK too — uploadSessionAudio
			// encrypts with the record DEK first, so no plaintext audio ever
			// leaves the device (fail-closed when the grant is missing).
			void uploadSessionAudio(id);
			// The consultation is saved either way: access only adds to it.
			setAccess(await accessAfterSave());
			setSaveDialog({ kind: "ok", id, updated: Boolean(existing) });
			void draftStore.clear();
			if (restoredUrl && typeof URL.revokeObjectURL === "function")
				URL.revokeObjectURL(restoredUrl);
			setRestoredUrl(null);
		} catch (e) {
			setSaveDialog({
				kind: "error",
				message: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setSaving(false);
		}
	}

	/** Grant portal access + send the email; a success marks the patient
	 * as having access so a re-save never invites twice. */
	async function invite(invitee: number, email: string): Promise<AccessOutcome> {
		const res = await api.invitePatient!({ data: { patientId: invitee, email } }).catch(() => ({
			ok: false as const,
			error: "failed",
		}));
		if (res.ok) setStandings((s) => ({ ...s, [invitee]: { status: "has-access" } }));
		return {
			patientId: invitee,
			email,
			status: res.ok ? (res.emailed ? "sent" : "unsent") : "ask",
			error: res.ok
				? null
				: res.error === "invalid_email"
					? nc.accessInvalidEmail
					: nc.accessFailed,
		};
	}

	/**
	 * Act on the up-front access decision (T-258): send when the doctor
	 * chose to, stay quiet when they declined. An unusable email or a
	 * failed invite comes back as the dialog's retry form; an unknown
	 * standing falls back to asking after the fact.
	 */
	async function accessAfterSave(): Promise<AccessOutcome | null> {
		if (patientId === null || !accessEnabled) return null;
		const standing = standings[patientId];
		if (standing?.status === "has-access") return null;
		if (standing?.status === "none") {
			const choice = choices[patientId] ?? defaultChoice(standing.email);
			if (!choice.send) return null;
			const email = choice.email.trim();
			if (!looksLikeEmail(email)) {
				return {
					patientId,
					email,
					status: "ask",
					error: email === "" ? null : nc.accessInvalidEmail,
				};
			}
			return invite(patientId, email);
		}
		const late = await api.patientAccess!({ data: patientId }).catch(() => null);
		return late && !late.hasAccess
			? { patientId, email: late.email ?? "", status: "ask", error: null }
			: null;
	}

	async function sendAccess(e: FormEvent) {
		e.preventDefault();
		/* v8 ignore next -- the form only renders with a pending question and an invite api */
		if (!access || !api.invitePatient) return;
		const email = access.email.trim();
		if (!email || access.status === "sending") return;
		setAccess({ ...access, status: "sending", error: null });
		setAccess(await invite(access.patientId, email));
	}

	function updateSection(key: AnamnesisSectionKey, content: string) {
		setAnamnesis((a) =>
			a
				? { ...a, [key]: { ...a[key], content } }
				: /* v8 ignore next -- textarea only exists with anamnesis */ a,
		);
	}

	function copyAnamnesis() {
		/* v8 ignore next -- Copy button only renders with anamnesis */
		if (!anamnesis) return;
		const text = anamnesisToText(anamnesis);
		void navigator.clipboard.writeText(text).then(
			() => showToast({ text: t.newConsultation.anamnesisCopied }),
			() => setError(t.newConsultation.copyFailed),
		);
	}

	/** Header stop control — ends every running capture channel. */
	function stopCapture() {
		if (recording) toggleRecording();
		if (tabRecording) toggleTabCapture();
		if (dictating) toggleDictation();
	}

	function copyTranscript() {
		void navigator.clipboard.writeText(transcript).then(
			() => showToast({ text: t.newConsultation.transcriptCopied }),
			() => setError(t.newConsultation.copyFailed),
		);
	}

	function exportTranscript() {
		/* v8 ignore next -- jsdom lacks createObjectURL; browsers always have it */
		if (typeof URL.createObjectURL !== "function") return;
		const url = URL.createObjectURL(new Blob([transcript], { type: "text/plain;charset=utf-8" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `consultation-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	}

	// Anamnesis is generated from the transcript version on screen —
	// the corrected/server text once the audio pipeline panel is up.
	const extractText = viewedText?.text ?? transcript;
	/* v8 ignore next -- patientId only comes from the patients list or createPatient */
	const dialogPatientName = patientId
		? (patients.find((p) => p.id === patientId)?.name ?? t.newConsultation.patientFallback)
		: null;
	/* v8 ignore next -- the access question only exists for a linked patient, who has a name */
	const accessPatientName = dialogPatientName ?? nc.patientFallback;

	const selectedPatient = patientId !== null ? patients.find((p) => p.id === patientId) : null;
	const selectedPatientAge = patientId !== null ? createdAges[patientId] : undefined;

	// Live chat rows: lines carry the capture-mode speaker hint as a
	// "Doctor:"/"Patient:" prefix (mic → doctor, tab → patient) —
	// diarized labels only exist after server-side diarization. Lines
	// without a prefix (dictation, pasted text, uploads) render
	// unattributed, with a provenance name and no role chip.
	const chatRows = transcript
		.split("\n")
		.filter((l) => l.trim())
		.map((line, i) => {
			const m = /^([\p{L} ]{2,20}):\s*(.*)$/u.exec(line);
			const speaker = m?.[1]?.trim();
			const stamp = rowTimes[i];
			return {
				speaker,
				name: !speaker
					? mode === "dictation"
						? t.sources.dictation
						: t.sources.browser
					: speaker === t.speakers.patient && selectedPatient
						? selectedPatient.name
						: speaker,
				text: m ? m[2]! : line,
				time: stamp === undefined ? undefined : fmtElapsed(stamp),
			};
		});
	// The in-flight partial is attributed by whichever channel is on.
	const partialSpeaker = recording
		? t.speakers.doctor
		: tabRecording
			? t.speakers.patient
			: undefined;
	const partialName = recording
		? t.speakers.doctor
		: tabRecording
			? (selectedPatient?.name ?? t.speakers.patient)
			: mode === "dictation"
				? t.sources.dictation
				: t.sources.browser;

	// ---- live-flow stages (liveFlow prop) ----
	// The green room gates the first record-source capture; once a
	// session starts (`roomDone`) the workspace stays mounted so the
	// finished transcript remains reviewable. While a record capture
	// runs, the LiveConsultation screen replaces the legacy chat card.
	// Dictation/upload/bot sources always keep the legacy workspace.
	const lf = t.liveFlow;
	const liveFlowEnabled = liveFlow !== false;
	const recordSource = mode === "live" && source === "record";
	const showRoom = liveFlowEnabled && recordSource && !live && !roomDone;
	const liveScreen = liveFlowEnabled && recordSource && live;

	// The room stage portals to document.body: any ancestor transform or
	// containing-block quirk would otherwise clip the fixed overlay and
	// leak the page chrome (sidebar/footer) underneath it.
	const [stageReady, setStageReady] = useState(false);
	useEffect(() => setStageReady(true), []);

	const roomLabels: Partial<PreconsultationRoomLabels> = {
		brandName: lf.brandName,
		roomTitle: lf.roomTitle,
		readyTitle: lf.readyTitle,
		consentTitle: lf.consentTitle,
		consentDescription: lf.consentDescription,
		changePatient: lf.changePatient,
		testAudio: lf.testAudio,
		testingAudio: lf.testingAudio,
		calibratedAudio: lf.calibratedAudio,
		startSession: lf.startSession,
		startingSession: lf.startingSession,
		secondaryAction: lf.secondaryAction,
		modalityInPerson: lf.modalityInPerson,
		modalityTelemedicine: lf.modalityTelemedicine,
		captureInPerson: lf.captureInPerson,
		captureTelemedicine: lf.captureTelemedicine,
		deviceInPerson: lf.deviceInPerson,
		deviceTelemedicine: lf.deviceTelemedicine,
		engineInPerson: lf.engineInPerson,
		engineTelemedicine: lf.engineTelemedicine,
		audioStatus: lf.audioStatus,
		networkStatus: lf.networkStatus,
		encryption: lf.encryption,
		connectionStable: lf.connectionStable,
	};
	const liveLabels: Partial<LiveConsultationLabels> = {
		live: lf.live,
		paused: lf.paused,
		ended: lf.ended,
		encryption: lf.encryption,
		anamnesis: lf.anamnesis,
		endConsultation: lf.endConsultation,
		transcriptTitle: lf.transcriptTitle,
		diarizationActive: lf.diarizationActive,
		diarizationPaused: lf.diarizationPaused,
		diarizationEnded: lf.diarizationEnded,
		copy: lf.copy,
		export: lf.export,
		listening: lf.listening,
		pausedListening: lf.pausedListening,
		endedListening: lf.endedListening,
		audioSourceInPerson: lf.audioSourceInPerson,
		audioSourceTelemedicine: lf.audioSourceTelemedicine,
		yearsOld: lf.yearsOld,
		recordPrefix: lf.recordPrefix,
	};
	const livePatient: LiveConsultationPatient = {
		name: selectedPatient?.name ?? nc.unlinked,
		...(selectedPatientAge !== undefined ? { age: selectedPatientAge } : {}),
		...(selectedPatient ? { recordNumber: selectedPatient.id } : {}),
	};
	// Enumerate audio inputs for the room's device picker — in-person
	// mic capture only; telemedicine captures the meeting tab instead.
	// Labels stay blank until mic permission is granted, so the list is
	// refreshed on `devicechange` (plug/unplug, permission grant).
	useEffect(() => {
		if (!showRoom || modality !== "in-person") return;
		// Effects never run during SSR — navigator is always defined here.
		const md = navigator.mediaDevices;
		if (!md?.enumerateDevices) return;
		let cancelled = false;
		const refresh = () => {
			void md
				.enumerateDevices()
				.then((list) => {
					if (cancelled) return;
					const mics = list
						.filter((d) => d.kind === "audioinput")
						.map((d, i) => ({
							id: d.deviceId,
							label: d.label || `Microphone ${i + 1}`,
						}));
					setAudioDevices([
						{ id: "default", label: lf.systemDefaultDevice },
						...mics.filter((d) => d.id !== "default"),
					]);
				})
				.catch(() => {});
		};
		refresh();
		md.addEventListener("devicechange", refresh);
		return () => {
			cancelled = true;
			md.removeEventListener("devicechange", refresh);
		};
	}, [showRoom, modality, lf.systemDefaultDevice]);

	const liveTurns = liveConsultationTurns(chatRows, {
		doctor: t.speakers.doctor,
		patient: t.speakers.patient,
		doctorName: physician,
	});
	const anamnesisTopicCount = anamnesis
		? Object.values(anamnesis).filter((s) => s?.content?.trim()).length
		: 0;
	const liveFooter = (
		<>
			{chatRows.length === 0 && !partial ? (
				<p className="text-sm text-muted-foreground">{nc.transcriptPlaceholder}</p>
			) : null}
			{partial ? (
				<p className="text-sm text-muted-foreground italic">
					{partialName}: {partial}…
				</p>
			) : null}
		</>
	);

	/** Green-room CTA: in-person captures the room mic (clinician
	 * channel), telemedicine captures the meeting tab (patient
	 * channel). Latches `roomDone` so the workspace — not the room —
	 * is what the doctor sees when the session ends. */
	function startFromRoom() {
		setRoomDone(true);
		setPatientPickerOpen(false);
		if (modality === "in-person") {
			if (!recording) toggleRecording();
		} else if (!tabRecording) {
			toggleTabCapture();
		}
	}

	// Capture-source tabs — shared by the capture rail and the
	// pre-consultation room strip so upload/bot stay reachable from the
	// green room. ZK tenants have no server audio/transcript path, so
	// the tabs stay hidden there (T-145/T-147).
	const sourceTabs =
		mode === "live" && !zk ? (
			<Tabs
				value={source}
				onValueChange={(v) => setSource(v as "record" | "upload" | "bot")}
				className="w-fit"
			>
				<TabsList className="text-xs">
					<TabsTrigger value="record">{nc.tabRecord}</TabsTrigger>
					<TabsTrigger value="upload">{nc.tabUpload}</TabsTrigger>
					<TabsTrigger value="bot">{nc.tabBot}</TabsTrigger>
				</TabsList>
			</Tabs>
		) : null;

	// Draft recovery notices — rendered above every workspace variant so
	// an interrupted session is never hidden behind a stage switch.
	const draftNotices = (
		<>
			{draft ? (
				<div
					role="status"
					className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-sm"
				>
					<span>
						{nc.draftRecovered(
							new Date(draft.savedAt).toLocaleTimeString(locale, {
								hour: "2-digit",
								minute: "2-digit",
							}),
						)}
					</span>
					<span className="flex gap-2">
						<Button type="button" size="sm" variant="outline" onClick={restoreDraft}>
							{nc.restoreDraft}
						</Button>
						<Button type="button" size="sm" variant="ghost" onClick={discardDraft}>
							{nc.discardDraft}
						</Button>
					</span>
					{draftUrl ? (
						<div className="w-full">
							<ConsultationAudioPlayer
								src={draftUrl}
								ariaLabel={nc.draftAudio}
								preload="metadata"
							/>
						</div>
					) : null}
				</div>
			) : null}
			{restoredUrl ? (
				<div className="shrink-0 rounded-lg border bg-muted/30 p-2">
					<p className="mb-1 text-[11px] font-medium text-muted-foreground">{nc.draftAudio}</p>
					<ConsultationAudioPlayer src={restoredUrl} ariaLabel={nc.draftAudio} preload="metadata" />
				</div>
			) : null}
		</>
	);

	// Real mic check for the room's "Test audio" — captures ~2.5s through
	// an AnalyserNode and feeds the room's VU meter; a silent/denied mic
	// surfaces as a toast instead of a fake "calibrated".
	const [audioTestLevel, setAudioTestLevel] = useState<number | undefined>(undefined);
	const audioTestActive = useRef(false);

	async function runAudioTest() {
		// Testing audio signals capture intent — warm the ASR engine so the
		// first real capture doesn't pay the model-load latency.
		backend.load();
		if (audioTestActive.current || !supported || typeof AudioContext === "undefined") return;
		audioTestActive.current = true;
		setAudioTestLevel(0);
		let stream: MediaStream | null = null;
		let audioCtx: AudioContext | null = null;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {}),
				},
			});
			audioCtx = new AudioContext();
			const source = audioCtx.createMediaStreamSource(stream);
			const analyser = audioCtx.createAnalyser();
			analyser.fftSize = 512;
			source.connect(analyser);
			const buf = new Uint8Array(analyser.frequencyBinCount);
			const started = Date.now();
			let peak = 0;
			while (Date.now() - started < 2500) {
				analyser.getByteTimeDomainData(buf);
				let sum = 0;
				for (const v of buf) {
					const d = (v - 128) / 128;
					sum += d * d;
				}
				const rms = Math.sqrt(sum / buf.length);
				peak = Math.max(peak, rms);
				setAudioTestLevel(Math.min(1, rms * 3));
				await new Promise((r) => setTimeout(r, 80));
			}
			if (peak < 0.015) {
				showToast({ text: "Audio test failed — no sound detected. Check your microphone." });
			}
		} catch {
			showToast({ text: "Audio test failed — microphone unavailable or permission denied." });
		} finally {
			stream?.getTracks().forEach((track) => track.stop());
			void audioCtx?.close();
			audioTestActive.current = false;
			setAudioTestLevel(undefined);
		}
	}

	// Quick-create a patient from the name+age fields — shared by the
	// capture rail and the room's change-patient dialog.
	async function createQuickPatient() {
		if (!patientName.trim()) return;
		const age = Number(patientAge);
		if (patientAge === "" || !Number.isInteger(age) || age < 0) {
			setPatientError(nc.ageRequired);
			return;
		}
		setPatientError(null);
		const res = await api.createPatient({
			data: { name: patientName, birthDate: birthDateFromAge(age) },
		});
		if (!res.ok) {
			// Validation comes back as codes; this view is English-only (T-025).
			const code = Object.values(res.errors)[0];
			setPatientError(code ? errorMessage(code, locale) : nc.patientCreateFailed);
			return;
		}
		const p = res.patient;
		setPatients((prev) => [...prev, { id: p.id, name: p.name }]);
		setPatientId(p.id);
		setQuickCreatedId(p.id);
		setCreatedAges((m) => ({ ...m, [p.id]: age }));
		// A brand-new patient has no portal access — carry the
		// quick-create answer into their access card (T-258);
		// "Yes" without a usable email stays undecided.
		const email = newPatientAccess.email.trim();
		accessLookedUp.current.add(p.id);
		setStandings((s) => ({ ...s, [p.id]: { status: "none", email: null } }));
		setChoices((c) => ({
			...c,
			[p.id]: { send: newPatientAccess.send && looksLikeEmail(email), email },
		}));
		setNewPatientAccess({ send: true, email: "" });
		setPatientName("");
		setPatientAge("");
		setPatientPickerOpen(false);
	}

	// Name + age + create button (+ access question, error, record link)
	// — rendered by the capture rail and the room's patient dialog.
	const patientCreateControls = (
		<>
			<Input
				value={patientName}
				onChange={(e) => setPatientName(e.target.value)}
				placeholder={nc.newPatientPlaceholder}
				aria-label={nc.newPatientNameLabel}
				className="w-40"
			/>
			<Input
				type="number"
				min={0}
				max={130}
				inputMode="numeric"
				value={patientAge}
				onChange={(e) => setPatientAge(e.target.value)}
				placeholder={nc.agePlaceholder}
				aria-label={nc.newPatientAgeLabel}
				className="w-20"
			/>
			<Button type="button" variant="outline" size="sm" onClick={() => void createQuickPatient()}>
				{nc.addPatient}
			</Button>
			{accessEnabled && patientName.trim() !== "" ? (
				<div className="basis-full">
					<NewPatientAccessQuestion
						choice={newPatientAccess}
						onChange={setNewPatientAccess}
						nc={nc}
					/>
				</div>
			) : null}
			{patientError ? <FieldError className="text-xs">{patientError}</FieldError> : null}
			{quickCreatedId !== null && quickCreatedId === patientId ? (
				<Link
					to={portalPath(`/patients/${quickCreatedId}/edit`)}
					className="text-xs font-medium underline"
				>
					{nc.completeRecord}
				</Link>
			) : null}
		</>
	);

	// Compact patient picker revealed by the room's "Change" action —
	// rendered as a real dialog from the fullscreen stage.
	const patientPicker = (
		<div className="flex flex-wrap items-center gap-3">
			<Label
				id="patient-label"
				className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
			>
				{nc.patientLabel}
			</Label>
			<Select
				value={patientId === null ? "" : String(patientId)}
				onValueChange={(v) => setPatientId(v ? Number(v) : null)}
				items={[
					{ label: nc.unlinked, value: "" },
					...patients.map((p) => ({ label: p.name, value: String(p.id) })),
				]}
			>
				<SelectTrigger aria-labelledby="patient-label" className="border-border">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="">{nc.unlinked}</SelectItem>
					{patients.map((p) => (
						<SelectItem key={p.id} value={String(p.id)}>
							{p.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Button type="button" variant="ghost" size="sm" onClick={() => setPatientPickerOpen(false)}>
				{lf.pickerDone}
			</Button>
		</div>
	);

	// Account menu for the room header — the fullscreen stage hides the
	// portal shell, so session info + portal navigation live here.
	// SPA navigations (same mechanism the portal sidebar uses) — a full
	// reload through location.assign lands on the error boundary.
	const navigate = useNavigate();
	const userMenu = user ? (
		<DropdownMenu>
			<DropdownMenuTrigger className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground">
				<Avatar size="sm">
					<AvatarFallback className="bg-muted text-[11px] font-semibold uppercase">
						{user.name?.[0] ?? user.email[0] ?? "?"}
					</AvatarFallback>
				</Avatar>
				<span className="max-w-32 truncate">{user.name ?? user.email}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				{/* Base UI requires group parts (label/items) inside a
				 * DropdownMenuGroup — a bare label crashes the menu. */}
				<DropdownMenuGroup>
					<DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
						<span className="text-sm font-medium text-foreground">{user.name ?? user.email}</span>
						{user.name ? (
							<span className="truncate text-xs text-muted-foreground">{user.email}</span>
						) : null}
					</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={() => void navigate({ to: portalPath("") })}>
						Portal home
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => void navigate({ to: portalPath("/patients") })}>
						Patients
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => void navigate({ to: portalPath("/consultations") })}>
						Consultations
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => void navigate({ to: portalPath("/review") })}>
						Review queue
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	) : null;

	// Change-patient modal for the room — select an existing patient or
	// quick-create one, same controls as the capture rail.
	const patientPickerDialog = (
		<PickerDialog
			open={patientPickerOpen}
			onOpenChange={(open) => {
				if (!open) setPatientPickerOpen(false);
			}}
		>
			<PickerDialogContent className="sm:max-w-md">
				<PickerDialogHeader>
					<PickerDialogTitle>{nc.patientLabel}</PickerDialogTitle>
				</PickerDialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-wrap items-center gap-3">{patientPicker}</div>
					<div className="flex flex-wrap items-center gap-2 border-t pt-3">
						{patientCreateControls}
					</div>
				</div>
			</PickerDialogContent>
		</PickerDialog>
	);

	// Gear button in the room's preview strip — input device picker plus
	// a shortcut into the real mic test. Only meaningful for in-person
	// mic capture; telemedicine hears the meeting tab instead.
	const audioSettingsDialog = (
		<PickerDialog
			open={audioSettingsOpen}
			onOpenChange={(open) => {
				if (!open) setAudioSettingsOpen(false);
			}}
		>
			<PickerDialogContent className="sm:max-w-md">
				<PickerDialogHeader>
					<PickerDialogTitle>{lf.audioSettingsTitle}</PickerDialogTitle>
				</PickerDialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label
							id="audio-device-label"
							className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
						>
							{lf.inputDevice}
						</Label>
						<Select
							value={micDeviceId ?? "default"}
							onValueChange={(v) => setMicDeviceId(v === "default" ? null : String(v))}
							items={audioDevices.map((d) => ({ label: d.label, value: d.id }))}
						>
							<SelectTrigger aria-labelledby="audio-device-label" className="border-border">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{audioDevices.map((d) => (
									<SelectItem key={d.id} value={d.id}>
										{d.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex justify-end">
						<Button
							type="button"
							size="sm"
							onClick={() => {
								setAudioSettingsOpen(false);
								void runAudioTest();
							}}
						>
							{lf.testAudio}
						</Button>
					</div>
				</div>
			</PickerDialogContent>
		</PickerDialog>
	);

	return (
		<PageContainer ref={frameRef} className="max-w-none flex min-h-0 flex-col overflow-hidden">
			<PageHeader
				className="shrink-0"
				title={nc.title}
				description={nc.subtitle}
				actions={
					<Link
						to={portalPath("/consultations")}
						className={buttonVariants({ variant: "outline", size: "sm" })}
					>
						<ArrowLeftIcon />
						{t.detail.back}
					</Link>
				}
			/>

			{!showRoom ? (
				<PatientContextBar
					className="shrink-0"
					name={selectedPatient?.name ?? nc.unlinked}
					meta={[
						...(selectedPatient ? [`${t.list.patientRecord} #${selectedPatient.id}`] : []),
						...(selectedPatientAge !== undefined ? [nc.yearsOld(selectedPatientAge)] : []),
					]}
					chips={
						<>
							<Badge
								variant="secondary"
								className={`text-[10px] ring-1 ${consented ? BADGE_TONES.green : BADGE_TONES.neutral}`}
							>
								{consented ? t.list.consent : t.detail.consentNotRecorded}
							</Badge>
							{live ? (
								<Badge variant="destructive" className="text-[10px]">
									<span className="size-1.5 animate-pulse rounded-full bg-destructive-foreground" />
									{fmtElapsed(elapsedSec)}
								</Badge>
							) : null}
							{anamnesis ? (
								<Badge variant="secondary" className={`text-[10px] ring-1 ${BADGE_TONES.blue}`}>
									{t.common.anamnesis}
								</Badge>
							) : null}
						</>
					}
					actions={
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setAnamnesisOpen(true)}
						>
							<SparklesIcon data-icon="inline-start" />
							{nc.anamnesisDrawer}
						</Button>
					}
				/>
			) : null}

			{showRoom ? (
				stageReady ? (
					createPortal(
						/* ---- pre-consultation room: standalone fullscreen
						 * stage portaled to <body> — covers the portal chrome
						 * like the catalog demo. The single header carries
						 * source tabs + notices; patient, consent and the
						 * audio test live inside the room itself. ---- */
						<div className="fixed inset-0 z-50 overflow-hidden bg-background">
							{/* floating chrome — the room itself stays full-bleed
							 * exactly like the catalog demo; navigation + account
							 * live in the room header's actions slot */}
							{patientPickerDialog}
							{audioSettingsDialog}
							{draft || restoredUrl ? (
								<div className="absolute top-20 right-3 z-10 flex w-80 flex-col gap-2">
									{draftNotices}
								</div>
							) : null}
							{!supported ? (
								<p className="absolute right-3 bottom-3 z-10 rounded-md bg-background/80 px-2 py-1 text-xs text-info backdrop-blur">
									{nc.unsupportedBrowser}
								</p>
							) : null}
							<PreconsultationRoom
								className="h-full"
								physician={{ name: physician ?? t.speakers.doctor }}
								patient={{
									name: selectedPatient?.name ?? nc.unlinked,
									...(selectedPatientAge !== undefined ? { age: selectedPatientAge } : {}),
									...(selectedPatient ? { recordNumber: selectedPatient.id } : {}),
								}}
								modality={modality}
								onModalityChange={setModality}
								consentChecked={consented}
								onConsentChange={(checked) => setConsented(checked)}
								onStart={startFromRoom}
								onPostpone={() => setMode("dictation")}
								onChangePatient={() => setPatientPickerOpen(true)}
								onAudioTest={() => void runAudioTest()}
								onAudioSettings={() => setAudioSettingsOpen(true)}
								micMuted={micMuted}
								onMicToggle={() => setMicMuted((m) => !m)}
								devices={
									modality === "in-person" && audioDevices.length > 0 ? audioDevices : undefined
								}
								selectedDeviceId={micDeviceId ?? "default"}
								onDeviceChange={(id) => setMicDeviceId(!id || id === "default" ? null : id)}
								vuLevel={audioTestLevel}
								telemetry={{ encryptionLabel: lf.encryption }}
								headerActions={
									<>
										{/* the account menu already carries the user
										 * identity — hide the room's physician block so
										 * the header doesn't show the same person twice */}
										<Link
											to={portalPath("/consultations")}
											className={buttonVariants({ variant: "outline", size: "sm" })}
										>
											<ArrowLeftIcon />
											{t.detail.back}
										</Link>
										{userMenu}
									</>
								}
								showPhysicianHeader={false}
								labels={roomLabels}
							/>
						</div>,
						document.body,
					)
				) : null
			) : liveScreen ? (
				/* ---- live consultation screen: leaf composition of the ui
				 * LiveConsultation blocks — header, diarized-turn transcript
				 * (channel attribution, honest copy), status strip and the
				 * anamnesis control bar. The legacy Sheet drawer stays the
				 * anamnesis surface. ---- */
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					{/* engine status + transcript utilities stay reachable
					 * while the capture runs */}
					<div className="flex shrink-0 flex-wrap items-center gap-2 px-1 pb-2">
						{modelStatus ? (
							<Badge variant="secondary" className="min-w-0 font-normal text-muted-foreground">
								<BrainIcon className="size-3.5 shrink-0" />
								<span className="truncate">{modelStatus}</span>
							</Badge>
						) : null}
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-[11px]"
							onClick={() => setTranscript(SAMPLE_TRANSCRIPT)}
						>
							{nc.useSample}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-[11px]"
							onClick={() => setTranscript("")}
							disabled={!transcript}
						>
							{nc.clear}
						</Button>
						{error ? (
							<Alert variant="destructive" className="px-3 py-2 text-xs">
								{error}
							</Alert>
						) : null}
					</div>
					{draftNotices}
					<LiveConsultationHeader
						patient={livePatient}
						status="live"
						elapsedSeconds={elapsedSec}
						modality={modality}
						anamnesisCount={anamnesisTopicCount}
						anamnesisOpen={anamnesisOpen}
						onToggleAnamnesis={() => setAnamnesisOpen((o) => !o)}
						onEndConsultation={stopCapture}
						labels={liveLabels}
					/>
					<div className="flex min-h-0 flex-1 flex-col px-4 py-3 md:px-8">
						<div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
							<LiveTranscriptPanel
								turns={liveTurns}
								status="live"
								onCopyTranscript={transcript.trim() ? copyTranscript : undefined}
								onExportTranscript={transcript.trim() ? exportTranscript : undefined}
								footer={liveFooter}
								labels={liveLabels}
								className="rounded-b-none border-b-0"
							/>
							<LiveStatusStrip
								status="live"
								modality={modality}
								audioSource={
									modality === "telemedicine" ? lf.audioSourceTelemedicine : lf.audioSourceInPerson
								}
								labels={liveLabels}
								className="rounded-b-2xl border-x border-b"
							/>
						</div>
					</div>
					<ConsultationControlBar
						status="live"
						anamnesisOpen={anamnesisOpen}
						anamnesisCount={anamnesisTopicCount}
						onToggleAnamnesis={() => setAnamnesisOpen((o) => !o)}
						labels={liveLabels}
					/>
				</div>
			) : (
				/* ---- Workspace: the page itself never scrolls — the capture rail
				 * and the transcript panel carry their own scroll instead. ---- */
				<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:flex-row lg:overflow-hidden">
					{/* ---- capture rail: mode tabs, patient + consent, controls ---- */}
					<Card className="w-full shrink-0 lg:w-[330px] xl:w-[360px]">
						<CardHeader className="shrink-0 border-b">
							{/* mode: live consultation vs post-consultation dictation */}
							<Tabs
								value={mode}
								onValueChange={(v) => setMode(v as "live" | "dictation")}
								className="w-fit"
							>
								<TabsList aria-label={nc.modeLabel}>
									<TabsTrigger value="live" disabled={live}>
										{nc.modeLive}
									</TabsTrigger>
									<TabsTrigger value="dictation" disabled={live}>
										{nc.modeDictation}
									</TabsTrigger>
								</TabsList>
							</Tabs>
						</CardHeader>
						<CardContent className="space-y-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
							{/* 1. prepare: patient + consent */}
							<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
								<div className="flex items-center gap-2">
									<Label
										id="patient-label"
										className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
									>
										{nc.patientLabel}
									</Label>
									<Select
										value={patientId === null ? "" : String(patientId)}
										onValueChange={(v) => setPatientId(v ? Number(v) : null)}
										items={[
											{ label: nc.unlinked, value: "" },
											...patients.map((p) => ({ label: p.name, value: String(p.id) })),
										]}
									>
										<SelectTrigger aria-labelledby="patient-label" className="border-border">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="">{nc.unlinked}</SelectItem>
											{patients.map((p) => (
												<SelectItem key={p.id} value={String(p.id)}>
													{p.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="flex flex-wrap items-center gap-2">{patientCreateControls}</div>
								<label
									className={`ml-auto flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs ${
										consented
											? "bg-primary/10 text-primary ring-1 ring-primary/20"
											: "bg-info/10 text-info ring-1 ring-info/20"
									}`}
								>
									<Checkbox
										checked={consented}
										onCheckedChange={(checked) => setConsented(checked === true)}
									/>
									{nc.consentDeclaration}
								</label>
							</div>
							{patientId !== null && standings[patientId] !== undefined ? (
								<PatientAccessCard
									patientName={accessPatientName}
									standing={standings[patientId]}
									choice={
										choices[patientId] ??
										defaultChoice(
											standings[patientId].status === "none" ? standings[patientId].email : null,
										)
									}
									onChange={(choice) => setChoices((c) => ({ ...c, [patientId]: choice }))}
									nc={nc}
								/>
							) : null}

							{/* capture source — ZK tenants have no server audio/transcript
							 * path, so upload and the meet bot stay hidden (T-145/T-147). */}
							{sourceTabs}
							{mode === "dictation" ? (
								<div className="flex flex-col items-center gap-3 rounded-xl border border-border px-6 py-8 text-center">
									<p className="max-w-md text-sm text-muted-foreground">
										{nc.dictationDescription}
									</p>
									<Button
										type="button"
										onClick={toggleDictation}
										disabled={!supported || !consented}
										className={`h-auto gap-3 rounded-full px-6 py-3 text-sm font-semibold ${
											dictating
												? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
												: ""
										}`}
									>
										<span
											className={`size-3 rounded-full ${dictating ? "animate-pulse bg-destructive-foreground" : "bg-destructive-foreground/70"}`}
										/>
										{dictating ? nc.stopDictation(fmtElapsed(elapsedSec)) : nc.startDictation}
									</Button>
									{dictating ? (
										<p className="text-xs text-muted-foreground">
											{nc.dictatingHint(fmtElapsed(elapsedSec))}
										</p>
									) : null}
									{!consented ? (
										<Alert className="border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
											{nc.consentRequiredDictation}
										</Alert>
									) : null}
									{!supported ? <p className="text-xs text-info">{nc.unsupportedBrowser}</p> : null}
								</div>
							) : source === "upload" ? (
								<label className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground transition hover:border-foreground/20">
									<input
										type="file"
										accept="audio/*"
										className="hidden"
										disabled={busy}
										onChange={(e) => {
											const f = e.target.files?.[0];
											if (f) void uploadAudio(f);
											e.target.value = "";
										}}
									/>
									<span className="font-medium text-foreground">
										{busy ? nc.uploading : nc.uploadRecording}
									</span>
									<span className="text-[11px]">{nc.uploadHint}</span>
								</label>
							) : source === "record" ? (
								<>
									<div className="grid gap-3 sm:grid-cols-2">
										<Button
											type="button"
											variant="outline"
											onClick={toggleRecording}
											disabled={!supported || !consented}
											className={`h-auto flex-col items-start rounded-xl p-3 text-left ${
												recording ? "border-destructive/30 bg-destructive/10" : ""
											}`}
										>
											<span className="flex items-center gap-2 text-sm font-medium">
												{recording ? (
													<span className="size-2.5 animate-pulse rounded-full bg-destructive" />
												) : (
													<span className="size-2.5 rounded-full bg-muted-foreground" />
												)}
												{recording ? nc.stopMic : nc.recordMic}
											</span>
											<span className="mt-1 text-[11px] text-muted-foreground">
												{nc.micHint(t.speakers.doctor)}
											</span>
										</Button>
										<Button
											type="button"
											variant="outline"
											onClick={toggleTabCapture}
											disabled={!consented}
											className={`h-auto flex-col items-start rounded-xl p-3 text-left ${
												tabRecording ? "border-destructive/30 bg-destructive/10" : ""
											}`}
										>
											<span className="flex items-center gap-2 text-sm font-medium">
												{tabRecording ? (
													<span className="size-2.5 animate-pulse rounded-full bg-destructive" />
												) : (
													<span className="size-2.5 rounded-full bg-muted-foreground" />
												)}
												{tabRecording ? nc.stopTab : nc.captureTab}
											</span>
											<span className="mt-1 text-[11px] text-muted-foreground">
												{nc.tabHint(t.speakers.patient)}
											</span>
										</Button>
									</div>
									{!consented ? (
										<Alert className="border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
											{nc.consentRequiredRecording}
										</Alert>
									) : (
										<p className="text-[11px] text-muted-foreground">{nc.recordingTip}</p>
									)}
									{!supported ? <p className="text-xs text-info">{nc.unsupportedBrowser}</p> : null}
								</>
							) : (
								<div>
									<div className="flex items-center gap-2">
										<Badge
											variant="secondary"
											className="text-[10px] ring-1 ring-primary/20 bg-primary/10 text-primary"
										>
											{nc.channelsBadge}
										</Badge>
									</div>
									<p className="mt-2 text-xs text-muted-foreground">{nc.botDescription}</p>
									<div className="mt-3 flex gap-2">
										<Input
											type="url"
											value={meetUrl}
											onChange={(e) => setMeetUrl(e.target.value)}
											aria-label={nc.teleconsultLinkLabel}
											placeholder="https://meet.google.com/xxx-xxxx-xxx"
										/>
										<Button
											type="button"
											onClick={sendBot}
											disabled={!meetUrl.trim() || liveStatus === "live"}
											className="shrink-0"
										>
											{liveStatus === "live" ? nc.botInCall : nc.sendBot}
										</Button>
									</div>
									{liveId ? (
										<p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
											{liveStatus === "live" ? (
												<span className="size-2 animate-pulse rounded-full bg-destructive" />
											) : (
												<span className="size-2 rounded-full bg-primary" />
											)}
											{nc.consultationLive(
												liveId,
												liveStatus === "live" ? nc.transcribingLive : nc.callEnded,
											)}
										</p>
									) : null}
								</div>
							)}

							{/* state: recording (model status lives in the transcript header) */}
							<div className="flex flex-wrap items-center gap-2 text-xs">
								{live ? (
									<Badge variant="destructive">
										<span className="size-2 animate-pulse rounded-full bg-destructive" />
										{nc.recordingSpeak}
									</Badge>
								) : null}
							</div>
						</CardContent>
					</Card>

					{/* ---- transcript workspace: chat while capturing ---- */}
					<Card className="min-h-[420px] min-w-0 flex-1 gap-0 p-0 lg:min-h-0">
						<TranscriptPanelHeader live={live} title={t.common.transcript}>
							{live ? (
								<RecordingIndicator
									elapsed={fmtElapsed(elapsedSec)}
									onStop={stopCapture}
									stopLabel={nc.stopCapture}
								/>
							) : null}
							{modelStatus ? (
								<Badge variant="secondary" className="min-w-0 font-normal text-muted-foreground">
									<BrainIcon className="size-3.5 shrink-0" />
									<span className="truncate">{modelStatus}</span>
								</Badge>
							) : null}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-[11px]"
								onClick={() => setTranscript(SAMPLE_TRANSCRIPT)}
							>
								{nc.useSample}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-[11px]"
								onClick={() => setTranscript("")}
								disabled={!transcript}
							>
								{nc.clear}
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 gap-1 px-2 text-[11px]"
								onClick={copyTranscript}
								disabled={!transcript.trim()}
							>
								<CopyIcon className="size-3" />
								{nc.copyTranscript}
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 gap-1 px-2 text-[11px]"
								onClick={exportTranscript}
								disabled={!transcript.trim()}
							>
								<DownloadIcon className="size-3" />
								{nc.exportTranscript}
							</Button>
						</TranscriptPanelHeader>
						<CardContent className="flex min-h-0 flex-1 flex-col gap-3">
							{draftNotices}
							{/* While a capture runs the transcript renders as chat
							 * rows (auto-scrolled); the editable text stays mounted so
							 * the value keeps mirroring the transcript. */}
							{live ? (
								<ScrollArea className="min-h-0 flex-1 rounded-lg border border-input bg-muted/20">
									<div className="space-y-4 p-4">
										<EncryptionPill>{t.transcriptPanel.encryptionNote}</EncryptionPill>
										{chatRows.map((row, i) => (
											<SpeakerChatRow
												// biome-ignore lint/suspicious/noArrayIndexKey: static, ordered transcript lines
												key={i}
												speaker={row.speaker}
												name={row.name}
												time={row.time}
												roleLabel={row.speaker}
											>
												{row.text}
											</SpeakerChatRow>
										))}
										{partial ? (
											<SpeakerChatRow
												speaker={partialSpeaker}
												name={partialName}
												time={fmtElapsed(elapsedSec)}
												roleLabel={partialSpeaker}
												bubbleClassName="text-muted-foreground italic"
											>
												{partial}…
											</SpeakerChatRow>
										) : null}
										{chatRows.length === 0 && !partial ? (
											<p className="text-sm text-muted-foreground">{nc.transcriptPlaceholder}</p>
										) : null}
										<ListeningIndicator>{nc.listening}</ListeningIndicator>
										<div ref={chatEndRef} />
									</div>
								</ScrollArea>
							) : null}
							<Field className={live ? "hidden" : "flex min-h-0 flex-1 flex-col gap-1.5"}>
								<FieldLabel
									htmlFor="transcript"
									className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
								>
									{nc.consultationText}
								</FieldLabel>
								<ScrollArea className="min-h-0 flex-1 rounded-lg border border-input">
									<Textarea
										id="transcript"
										value={transcript}
										onChange={(e) => setTranscript(e.target.value)}
										placeholder={nc.transcriptPlaceholder}
										className="field-sizing-content min-h-full resize-none border-0 text-sm leading-relaxed focus-visible:border-transparent focus-visible:ring-0"
									/>
								</ScrollArea>
							</Field>

							{audioDetail || audioConsultId !== null ? (
								<div className="max-h-[45%] shrink-0 overflow-y-auto rounded-xl border border-border p-3">
									<p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
										{nc.serverTranscript}
									</p>
									<AudioTranscriptPanel
										i18n={i18n}
										locale={locale}
										consultationId={audioConsultId}
										audioStatus={audioDetail?.audioStatus ?? "queued"}
										hasAudio={Boolean(audioDetail?.audioKey)}
										browserText={transcript}
										serverText={audioDetail?.serverTranscript}
										correctedText={audioDetail?.correctedTranscript}
										onActiveText={setViewedText}
									/>
								</div>
							) : null}

							<div className="shrink-0 space-y-3">
								<Button
									type="button"
									onClick={generate}
									disabled={busy || !extractText.trim()}
									className="h-auto w-full px-4 py-2.5"
								>
									{busy ? <Spinner /> : null}
									{busy ? nc.generating : nc.generate}
								</Button>
								{viewedText ? (
									<p className="text-[11px] text-muted-foreground">
										{nc.generatedFrom(viewedText.source)}
									</p>
								) : null}
								{error ? (
									<Alert variant="destructive" className="px-3 py-2 text-xs">
										{error}
									</Alert>
								) : null}
							</div>
						</CardContent>
					</Card>
				</div>
			)}

			{/* Anamnese drawer: the structured draft lives off-canvas so
			 * the workspace stays a pure capture + transcript surface. */}
			<Sheet open={anamnesisOpen} onOpenChange={setAnamnesisOpen}>
				<SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
					<SheetHeader className="shrink-0 border-b border-border">
						<SheetTitle className="flex items-center gap-2">
							<SparklesIcon className="size-4" />
							{nc.anamnesisDrawer}
						</SheetTitle>
						<SheetDescription className="flex items-center gap-2">
							{nc.anamnesisDrawerDescription}
							{engine ? (
								<Badge
									variant="secondary"
									className="shrink-0 font-normal text-muted-foreground ring-1 ring-border"
								>
									{t.common.engine(engine)}
								</Badge>
							) : null}
						</SheetDescription>
					</SheetHeader>
					{!anamnesis ? (
						<Empty className="min-h-0 flex-1 py-14">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ClipboardListIcon />
								</EmptyMedia>
								<EmptyTitle>{nc.waitingTitle}</EmptyTitle>
								<EmptyDescription className="max-w-xs">{nc.waitingDescription}</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button
									type="button"
									size="sm"
									onClick={generate}
									disabled={busy || !extractText.trim()}
								>
									{busy ? <Spinner /> : null}
									{busy ? nc.generating : nc.generate}
								</Button>
							</EmptyContent>
						</Empty>
					) : (
						<>
							<ScrollArea className="min-h-0 flex-1 px-4">
								<div className="space-y-3.5 py-4 pr-3">
									<EncryptionPill>{t.transcriptPanel.encryptionNote}</EncryptionPill>
									{anamnesis.historico ? (
										<AnamnesisSection title={t.sections.historico}>
											<p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
												{anamnesis.historico.content}
											</p>
										</AnamnesisSection>
									) : null}
									{(
										Object.keys(t.sections).filter(
											(k) => k !== "historico",
										) as AnamnesisSectionKey[]
									).map((key) => {
										const sec = anamnesis[key];
										return (
											<AnamnesisSection
												key={key}
												title={t.sections[key]}
												status={
													<Badge
														variant="secondary"
														className={`text-[10px] ring-1 ${CONF_STYLE[sec.confidence]}`}
													>
														{t.confidence[sec.confidence]}
													</Badge>
												}
											>
												<Field className="gap-1.5">
													<FieldLabel htmlFor={`sec-${key}`} className="sr-only">
														{t.sections[key]}
													</FieldLabel>
													<Textarea
														id={`sec-${key}`}
														value={sec.content}
														onChange={(e) => updateSection(key, e.target.value)}
														rows={Math.min(5, Math.max(2, Math.ceil(sec.content.length / 70)))}
														className="resize-y text-sm leading-relaxed"
													/>
												</Field>
												{sec.evidence.length ? (
													<details className="mt-1.5">
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
											</AnamnesisSection>
										);
									})}
								</div>
							</ScrollArea>
							<SheetFooter className="shrink-0 flex-row gap-2 border-t border-border">
								<Button type="button" variant="outline" size="sm" onClick={copyAnamnesis}>
									{t.common.copy}
								</Button>
								<Button type="button" size="sm" onClick={save} disabled={saving}>
									{saving ? <Spinner /> : null}
									{saving ? nc.saving : savedId ? nc.updateConsultation : nc.saveConsultation}
								</Button>
							</SheetFooter>
						</>
					)}
				</SheetContent>
			</Sheet>
			<Toast toast={toast} onClose={() => setToast(null)} />
			<Dialog
				open={saveDialog !== null}
				onClose={() => setSaveDialog(null)}
				tone={saveDialog?.kind === "error" ? "error" : "success"}
				title={
					saveDialog?.kind === "error"
						? nc.dialogErrorTitle
						: saveDialog?.updated
							? nc.dialogUpdatedTitle
							: nc.dialogSavedTitle
				}
				actions={
					saveDialog?.kind === "ok" ? (
						<>
							{/* Server-side PDF reads plaintext columns — hidden
							 * under ZK until T-146's client-side renderer. */}
							{!zk ? (
								<a
									href={`/api/consultations/${saveDialog.id}/pdf`}
									download
									className={buttonVariants({ variant: "outline", size: "sm" })}
								>
									<DownloadIcon className="mr-1.5 inline size-4 -translate-y-px" />
									{t.common.downloadPdf}
								</a>
							) : null}
							<Link
								to={portalPath(`/consultations/${saveDialog.id}`)}
								className={buttonVariants({ variant: "outline", size: "sm" })}
							>
								{nc.viewConsultation}
							</Link>
							<Button type="button" size="sm" onClick={() => setSaveDialog(null)}>
								{access && access.status !== "sent" && access.status !== "unsent"
									? nc.accessNotNow
									: nc.confirm}
							</Button>
						</>
					) : (
						<Button type="button" size="sm" onClick={() => setSaveDialog(null)}>
							{nc.gotIt}
						</Button>
					)
				}
			>
				{saveDialog?.kind === "ok" ? (
					<>
						<p>
							{nc.dialogSavedBody({
								id: saveDialog.id,
								patientName: dialogPatientName,
								updated: saveDialog.updated,
								consented,
							})}
						</p>
						{access?.status === "sent" ? (
							<p className="mt-3 text-foreground">{nc.accessSent(access.email)}</p>
						) : access?.status === "unsent" ? (
							<p className="mt-3 text-foreground">{nc.accessUnsent(access.email)}</p>
						) : access ? (
							<form
								onSubmit={sendAccess}
								className="mt-4 flex flex-col gap-2 border-t border-border pt-4"
							>
								<Label htmlFor="access-email" className="font-medium text-foreground">
									{nc.accessQuestion(accessPatientName)}
								</Label>
								<div className="flex gap-2">
									<Input
										id="access-email"
										type="email"
										autoComplete="off"
										required
										placeholder={nc.accessEmailPlaceholder}
										value={access.email}
										onChange={(e) => setAccess({ ...access, email: e.target.value })}
									/>
									<Button type="submit" size="sm" disabled={access.status === "sending"}>
										{access.status === "sending" ? <Spinner /> : null}
										{nc.accessSend}
									</Button>
								</div>
								{access.error ? <p className="text-xs text-destructive">{access.error}</p> : null}
								<p className="text-xs">{nc.accessHint}</p>
							</form>
						) : null}
					</>
				) : (
					<p>{saveDialog?.kind === "error" ? saveDialog.message : ""}</p>
				)}
			</Dialog>
		</PageContainer>
	);
}
