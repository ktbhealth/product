/**
 * Consultations plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint), so the host passes the
 * active locale in (route loader data / panel ctx / header-action prop)
 * and every view resolves its strings here. A locale catalog must
 * implement `ConsultationMessages` in full — a missing key is a type
 * error, not an English fallback at runtime.
 *
 * Pure module (no React): also used by -ui.ts-style label lookups.
 */
import type { AnamnesisSectionKey, Confidence } from "@ktb/anamnesis";
import { paramMessage } from "@ktb/i18n";

/** Locales with a catalog; the host asserts it covers every app locale. */
export const CONSULTATION_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "consultations";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): ConsultationMessages =>
	consultationMessages(locale);
export type ConsultationLocale = (typeof CONSULTATION_LOCALES)[number];
export const BASE_LOCALE: ConsultationLocale = "en";

export interface ConsultationMessages {
	/** Capture-source labels (also used for notification bodies upstream). */
	readonly sources: Record<"browser" | "bot" | "dictation" | "upload", string>;
	/** Speaker labels written into transcripts and matched back for styling. */
	readonly speakers: { readonly doctor: string; readonly patient: string };
	/** Anamnesis section headings, keyed by the persisted section ids. */
	readonly sections: Record<AnamnesisSectionKey, string> & { readonly historico: string };
	readonly confidence: Record<Confidence, string>;
	readonly common: {
		readonly consultations: string;
		readonly anamnesis: string;
		readonly transcript: string;
		readonly noTranscript: string;
		readonly copy: string;
		readonly downloadPdf: string;
		readonly engine: (engine: string) => string;
		readonly consultationId: (id: number | string) => string;
	};
	readonly list: {
		readonly title: string;
		readonly none: string;
		readonly count: (n: number) => string;
		readonly newConsultation: string;
		readonly searchPlaceholder: string;
		readonly searchLabel: string;
		readonly filterLabel: string;
		readonly filters: {
			readonly all: string;
			readonly anamnesis: string;
			readonly pending: string;
		};
		readonly unlinkedPatient: string;
		readonly patientRecord: string;
		readonly live: string;
		readonly noAnamnesis: string;
		readonly consent: string;
		readonly downloadPdfTitle: string;
		readonly open: string;
		readonly noMatch: string;
		readonly emptyTitle: string;
		readonly emptyDescription: string;
		readonly startConsultation: string;
		/** Table column headers (list view). */
		readonly colPatient: string;
		readonly colDate: string;
		readonly colStatus: string;
		readonly colActions: string;
		/** Faceted-filter Selects in the list toolbar. */
		readonly filterAll: string;
		readonly filterLive: string;
		readonly filterDone: string;
		readonly filterSourceAll: string;
		readonly filterAnamnesisAll: string;
		readonly filterAnamnesisWith: string;
		readonly filterAnamnesisWithout: string;
		/** Physician review-state facet (PL-022). */
		readonly filterReviewAll: string;
		readonly filterReviewPending: string;
		readonly filterReviewDone: string;
		readonly filterReviewDeferred: string;
		/** Visible facet labels on the toolbar selects — the facet name
		 * sits next to the current value so filters are discoverable
		 * without opening each dropdown. */
		readonly facetStatus: string;
		readonly facetSource: string;
		readonly facetAnamnesis: string;
		readonly facetReview: string;
		/** Review badges on the status column (PL-022). */
		readonly deferredBadge: (date: string) => string;
		readonly reviewedBadge: (version: number) => string;
		readonly staleBadge: (version: number) => string;
		readonly transcriptReviewedBadge: string;
		/** Sidebar badge aria-label/tooltip — pending-review count (PL-023). */
		readonly sidebarPendingReview: (count: number) => string;
		/** Pulsing badge on in-progress rows. */
		readonly liveNow: string;
		/** Needs-review badge — count of `baixa`-confidence sections. */
		readonly needsReview: (n: number) => string;
		/** Stats strip labels above the list table. */
		readonly statsToday: string;
		readonly statsReviewed: string;
		readonly statsNeedsReview: string;
		/** Row hover-preview field labels. */
		readonly previewComplaint: string;
		readonly previewPlan: string;
	};
	readonly detail: {
		readonly back: string;
		readonly metaTitle: string;
		readonly openPatientRecord: string;
		readonly consentLabel: string;
		readonly consentNotRecorded: string;
		readonly inProgress: string;
		readonly previousConsultations: (n: number) => string;
		readonly anamnesisCopied: string;
		readonly complaint: (text: string) => string;
		readonly plan: (text: string) => string;
		readonly historyNote: string;
		readonly notReported: string;
		readonly evidence: (n: number) => string;
		/** Transcript-evidence toggle (highlights grounding sentences). */
		readonly showEvidence: string;
		readonly hideEvidence: string;
		readonly evidenceTitle: string;
		readonly noAnamnesisTitle: string;
		readonly noAnamnesisDescription: string;
		/** "Generate anamnesis" on the empty anamnesis card (transcript-only records). */
		readonly generateAnamnesis: string;
		/** Tamper-evidence badge labels (T-139) — mirrors IntegrityBadgeLabels. */
		readonly integrity: {
			readonly verified: string;
			readonly tampered: string;
			readonly unversioned: string;
		};
		/** Physician review stamps + actions (PL-022). */
		readonly confirmTranscript: string;
		readonly transcriptConfirmed: (date: string) => string;
		readonly approveAnamnesis: string;
		readonly approveAndNext: string;
		readonly anamnesisApproved: (version: number) => string;
		readonly anamnesisStale: (version: number) => string;
		readonly deferLabel: string;
		readonly deferResume: string;
		readonly deferredUntil: (date: string) => string;
		readonly approvedToast: string;
		readonly queueDoneToast: string;
	};
	/** Guided review mode (PL-023): queue rail + transcript/anamnesis steps. */
	readonly review: {
		readonly title: string;
		readonly queueLabel: string;
		readonly pendingCount: (n: number) => string;
		readonly sessionDone: (n: number) => string;
		readonly queueEmptyTitle: string;
		readonly queueEmptyDescription: string;
		readonly missingTitle: string;
		readonly missingDescription: string;
		readonly backToConsultations: string;
		readonly stepTranscript: string;
		readonly stepAnamnesis: string;
		readonly legacyAudioBadge: string;
		readonly noAudioBadge: string;
		readonly nextUncertain: string;
		readonly uncertainQueue: string;
		readonly uncertainProgress: (done: number, total: number) => string;
		readonly unverifySegment: string;
		readonly highConfTitle: string;
		readonly highConfHint: string;
		readonly editSegment: string;
		readonly editSection: string;
		readonly editFullText: string;
		readonly saveEdit: string;
		readonly cancelEdit: string;
		readonly editedTag: string;
		readonly pendingEdits: (n: number) => string;
		readonly confirmAndContinue: string;
		readonly shortcutsTitle: string;
		readonly shortcutPlayPause: string;
		readonly shortcutSeekBack: string;
		readonly shortcutKeySpace: string;
		readonly shortcutConfirm: string;
		readonly chapters: string;
		readonly staleAnamnesis: string;
		readonly regenerateAnamnesis: string;
		readonly deferredTag: string;
		readonly noAudioTag: string;
		readonly audioProcessingTag: string;
		readonly notFound: string;
	};
	readonly transcriptPanel: {
		readonly sourceServer: string;
		readonly sourceBrowser: string;
		readonly sourceCorrected: string;
		readonly enhancementFailed: string;
		readonly audioStored: string;
		readonly enhancing: string;
		readonly enhanced: string;
		readonly audioLabel: string;
		readonly playbackRate: string;
		readonly skipSilence: string;
		readonly tabCorrected: string;
		readonly tabChanges: string;
		readonly tabTranscript: string;
		readonly noChanges: string;
		readonly tabOriginal: string;
	};
	readonly newConsultation: {
		readonly title: string;
		readonly subtitle: string;
		readonly steps: {
			readonly prepare: string;
			readonly transcribe: string;
			readonly review: string;
		};
		readonly modeLabel: string;
		readonly modeLive: string;
		readonly modeDictation: string;
		readonly patientLabel: string;
		readonly unlinked: string;
		readonly newPatientPlaceholder: string;
		readonly newPatientNameLabel: string;
		readonly agePlaceholder: string;
		readonly newPatientAgeLabel: string;
		readonly ageRequired: string;
		readonly patientCreateFailed: string;
		readonly addPatient: string;
		readonly completeRecord: string;
		readonly consentDeclaration: string;
		readonly tabRecord: string;
		readonly tabUpload: string;
		readonly tabBot: string;
		readonly dictationDescription: string;
		readonly stopDictation: (elapsed: string) => string;
		readonly startDictation: string;
		readonly dictatingHint: (elapsed: string) => string;
		readonly consentRequiredDictation: string;
		readonly consentRequiredRecording: string;
		readonly unsupportedBrowser: string;
		readonly uploading: string;
		readonly uploadRecording: string;
		readonly uploadHint: string;
		readonly recordMic: string;
		readonly stopMic: string;
		readonly micHint: (doctor: string) => string;
		readonly captureTab: string;
		readonly stopTab: string;
		readonly tabHint: (patient: string) => string;
		readonly recordingTip: string;
		readonly channelsBadge: string;
		readonly botDescription: string;
		readonly teleconsultLinkLabel: string;
		readonly sendBot: string;
		readonly botInCall: string;
		readonly consultationLive: (id: number, status: string) => string;
		readonly transcribingLive: string;
		readonly callEnded: string;
		readonly recordingSpeak: string;
		readonly consultationText: string;
		readonly useSample: string;
		readonly clear: string;
		readonly transcriptPlaceholder: string;
		readonly serverTranscript: string;
		readonly generating: string;
		readonly generate: string;
		readonly generatedFrom: (source: string) => string;
		readonly modelReady: (device: string | null | undefined) => string;
		readonly modelUnavailable: (message: string) => string;
		readonly lowConfidenceReprocessing: string;
		readonly transcriptionRedone: string;
		readonly engineLabel: (engine: string) => string;
		readonly waitingTitle: string;
		readonly waitingDescription: string;
		readonly saving: string;
		readonly saveConsultation: string;
		readonly updateConsultation: string;
		readonly dialogErrorTitle: string;
		readonly dialogUpdatedTitle: string;
		readonly dialogSavedTitle: string;
		readonly viewConsultation: string;
		readonly confirm: string;
		readonly gotIt: string;
		/** Portal access question in the save dialog — `patient` is the
		 * patient's name, `email` the address the access went to. */
		readonly accessQuestion: (patient: string) => string;
		readonly accessHint: string;
		readonly accessEmailPlaceholder: string;
		readonly accessSend: string;
		readonly accessNotNow: string;
		readonly accessSent: (email: string) => string;
		readonly accessUnsent: (email: string) => string;
		readonly accessInvalidEmail: string;
		readonly accessFailed: string;
		/** Up-front access card under the patient picker (T-258). */
		readonly accessCardTitle: string;
		readonly accessCardNone: (patient: string) => string;
		readonly accessCardHasAccess: (patient: string) => string;
		readonly accessSendOnSave: string;
		readonly accessSkip: string;
		readonly accessEmailLabel: string;
		/** Quick-create: ask whether to send access, then the email. */
		readonly newPatientAccessQuestion: string;
		readonly accessYes: string;
		readonly accessNo: string;
		readonly dialogSavedBody: (args: {
			id: number;
			patientName: string | null;
			updated: boolean;
			consented: boolean;
		}) => string;
		readonly saveSessionExpired: string;
		readonly saveFailed: string;
		readonly anamnesisCopied: string;
		readonly copyFailed: string;
		readonly audioUploadFailed: (message: string) => string;
		readonly transcriptionFailedStatus: (status: number | string) => string;
		readonly transcriptionFailed: string;
		readonly botFailed: (status: number) => string;
		readonly patientFallback: string;
	};
	readonly admin: {
		readonly title: string;
		readonly none: string;
		readonly count: (n: number) => string;
		readonly emptyTitle: string;
		readonly emptyDescription: string;
		readonly colId: string;
		readonly colStatus: string;
		readonly colSource: string;
		readonly colPatient: string;
		readonly colOwner: string;
		readonly colAudio: string;
		readonly colCreated: string;
		readonly searchPlaceholder: string;
		readonly searchLabel: string;
		readonly noMatch: string;
		readonly filteredCount: (shown: number, total: number) => string;
		readonly colActions: string;
		readonly newConsultation: string;
		readonly createTitle: string;
		readonly createDescription: string;
		readonly createFailed: string;
		readonly ownerLabel: string;
		readonly ownerPlaceholder: string;
		readonly patientLabel: string;
		readonly patientPlaceholder: string;
		readonly patientNone: string;
		readonly transcriptLabel: string;
		readonly transcriptPlaceholder: string;
		readonly deleteFor: (label: string) => string;
		readonly deleteTitle: string;
		readonly deleteDescription: (label: string) => string;
		readonly deleteConfirm: string;
		readonly cancel: string;
	};
	/** /platform dashboard slot: stat cells + sections contributed via
	 * the portal.dashboard.* chrome regions (T-125). */
	readonly dashboard: {
		readonly live: string;
		readonly byStatus: string;
		readonly bySource: string;
		readonly recentConsultations: string;
		readonly viewAll: string;
	};
	/** ZK locked-record copy (T-145) — rows this device cannot decrypt. */
	readonly zk: {
		readonly lockedRecord: string;
		readonly lockedHint: string;
		readonly decryptFailed: string;
		/** Disabled-export reason (T-146): server PDF cannot render
		 * ciphertext, no browser-safe renderer ships. */
		readonly exportLocked: string;
	};
	/** Doctor-portal speech-model warm-up card — the one-time ahead-of-
	 * time download that keeps the first consultation off the ~50 MB
	 * model fetch (the consult page's lazy `load()` stays the fallback). */
	readonly warmup: {
		readonly title: string;
		readonly description: string;
		readonly preparing: string;
		readonly ready: (device: string | null | undefined) => string;
		readonly failed: (message: string) => string;
		readonly retry: string;
		readonly dismiss: string;
	};
}

const en: ConsultationMessages = {
	sources: {
		browser: "Browser voice",
		bot: "Teleconsult (bot)",
		dictation: "Dictation",
		upload: "Upload",
	},
	speakers: { doctor: "Doctor", patient: "Patient" },
	sections: {
		queixa_principal: "Chief complaint",
		hda: "History of present illness",
		antecedentes: "Past medical history",
		alergias: "Allergies",
		medicamentos_em_uso: "Current medications",
		exame_fisico: "Physical examination",
		hipoteses: "Diagnostic hypotheses",
		conduta: "Management plan",
		historico: "Prior consultations",
	},
	confidence: { alta: "high confidence", media: "medium confidence", baixa: "low confidence" },
	common: {
		consultations: "Consultations",
		anamnesis: "Anamnesis",
		transcript: "Transcript",
		noTranscript: "No transcript.",
		copy: "Copy",
		downloadPdf: "Download PDF",
		engine: paramMessage("en", "engine: {engine}", ["engine"]),
		consultationId: paramMessage("en", "Consultation #{id}", ["id"]),
	},
	list: {
		title: "Consultations",
		none: "No consultations yet.",
		count: paramMessage(
			"en",
			"{n, plural, =1{{n} consultation recorded.} other{{n} consultations recorded.}}",
			["n"],
		),
		newConsultation: "+ New consultation",
		searchPlaceholder: "Search by patient, complaint, or text…",
		searchLabel: "Search consultations",
		filterLabel: "Filter consultations",
		filters: { all: "All", anamnesis: "With anamnesis", pending: "Pending" },
		unlinkedPatient: "Unlinked patient",
		patientRecord: "Patient record",
		live: "live",
		noAnamnesis: "No anamnesis",
		consent: "Consent ✓",
		downloadPdfTitle: "Download anamnesis PDF",
		open: "Open",
		noMatch: "No consultations match the search.",
		emptyTitle: "No consultations yet",
		emptyDescription: "Start a consultation to record the conversation and generate the anamnesis.",
		startConsultation: "Start consultation",
		colPatient: "Patient",
		colDate: "Date",
		colStatus: "Status",
		colActions: "Actions",
		filterAll: "All statuses",
		filterLive: "Live",
		filterDone: "Done",
		filterSourceAll: "All sources",
		filterAnamnesisAll: "Any anamnesis",
		filterAnamnesisWith: "With anamnesis",
		filterAnamnesisWithout: "Without anamnesis",
		filterReviewAll: "Any review state",
		filterReviewPending: "Pending review",
		filterReviewDone: "Reviewed",
		filterReviewDeferred: "Deferred",
		facetStatus: "Status",
		facetSource: "Source",
		facetAnamnesis: "Anamnesis",
		facetReview: "Review",
		deferredBadge: paramMessage("en", "Deferred until {date}", ["date"]),
		reviewedBadge: paramMessage("en", "Reviewed v{n}", ["n"]),
		staleBadge: paramMessage("en", "New version v{n}", ["n"]),
		transcriptReviewedBadge: "Transcript confirmed",
		sidebarPendingReview: paramMessage("en", "{n} pending review", ["n"]),
		liveNow: "Live now",
		needsReview: paramMessage(
			"en",
			"{n, plural, =1{{n} section to review} other{{n} sections to review}}",
			["n"],
		),
		statsToday: "Today",
		statsReviewed: "Reviewed",
		statsNeedsReview: "Needs review",
		previewComplaint: "Chief complaint",
		previewPlan: "Plan",
	},
	detail: {
		back: "Consultations",
		metaTitle: "Details",
		openPatientRecord: "Open patient record",
		consentLabel: "Consent ✓",
		consentNotRecorded: "Consent not recorded",
		inProgress: "in progress",
		previousConsultations: paramMessage(
			"en",
			"{n, plural, =1{{n} previous consultation} other{{n} previous consultations}}",
			["n"],
		),
		anamnesisCopied: "Anamnesis copied",
		complaint: paramMessage("en", "Complaint: {text}", ["text"]),
		plan: paramMessage("en", "Plan: {text}", ["text"]),
		historyNote: "Factual record of prior consultations — context only, not clinical suggestions.",
		notReported: "Not reported",
		evidence: paramMessage("en", "evidence ({n})", ["n"]),
		showEvidence: "Show evidence",
		hideEvidence: "Hide evidence",
		evidenceTitle: "Transcript evidence",
		noAnamnesisTitle: "No anamnesis saved",
		noAnamnesisDescription: "This consultation does not have a saved anamnesis yet.",
		generateAnamnesis: "Generate anamnesis",
		integrity: {
			verified: "Integrity verified",
			tampered: "Integrity check failed",
			unversioned: "Integrity not recorded",
		},
		confirmTranscript: "Confirm transcript",
		transcriptConfirmed: paramMessage("en", "Confirmed {date}", ["date"]),
		approveAnamnesis: "Approve anamnesis",
		approveAndNext: "Approve & next",
		anamnesisApproved: paramMessage("en", "Approved v{n}", ["n"]),
		anamnesisStale: paramMessage("en", "New version v{n} pending", ["n"]),
		deferLabel: "Defer review",
		deferResume: "Back to the queue",
		deferredUntil: paramMessage("en", "Deferred until {date}", ["date"]),
		approvedToast: "Anamnesis approved",
		queueDoneToast: "Review queue complete",
	},
	review: {
		title: "Review mode",
		queueLabel: "Review queue",
		pendingCount: paramMessage("en", "{n} pending", ["n"]),
		sessionDone: paramMessage("en", "{n} reviewed this session", ["n"]),
		queueEmptyTitle: "Review queue clear",
		queueEmptyDescription: "Every consultation is reviewed. The end-of-day ritual is done.",
		missingTitle: "Consultation not found",
		missingDescription: "It may have been reviewed already or you don't have access to it.",
		backToConsultations: "Back to consultations",
		stepTranscript: "Transcript",
		stepAnamnesis: "Anamnesis",
		legacyAudioBadge: "legacy audio",
		noAudioBadge: "no audio to check against",
		nextUncertain: "Next uncertain",
		uncertainQueue: "Passages to check",
		uncertainProgress: paramMessage("en", "{done} of {total} checked", ["done", "total"]),
		unverifySegment: "Mark unchecked",
		highConfTitle: "High-confidence transcript",
		highConfHint: "no uncertain passages — spot-check optional",
		editSegment: "Edit line",
		editSection: "Edit section",
		editFullText: "Edit transcript",
		saveEdit: "Save",
		cancelEdit: "Cancel",
		editedTag: "edited",
		pendingEdits: paramMessage("en", "{n} unconfirmed edits", ["n"]),
		confirmAndContinue: "Confirm transcript & continue",
		shortcutsTitle: "Keyboard shortcuts",
		shortcutPlayPause: "play / pause",
		shortcutSeekBack: "seek -10s",
		shortcutKeySpace: "Space",
		shortcutConfirm: "confirm transcript",
		chapters: "Chapters",
		staleAnamnesis: "Transcript has edits — regenerate if the anamnesis should reflect them.",
		regenerateAnamnesis: "Regenerate anamnesis",
		deferredTag: "deferred",
		noAudioTag: "no audio",
		audioProcessingTag: "processing",
		notFound: "Record not found",
	},
	transcriptPanel: {
		sourceServer: "server · whisper large-v3-turbo",
		sourceBrowser: "browser",
		sourceCorrected: "llm corrected",
		enhancementFailed: "enhancement failed — showing original",
		audioStored: "audio stored",
		enhancing: "enhancing transcript…",
		enhanced: "enhanced ✓",
		audioLabel: "Consultation audio",
		playbackRate: "Playback speed",
		skipSilence: "Skip silence",
		tabCorrected: "Corrected",
		tabChanges: "Changes",
		tabTranscript: "Transcript",
		noChanges: "No differences between original and corrected.",
		tabOriginal: "Original",
	},
	newConsultation: {
		title: "New consultation",
		subtitle:
			"Record the conversation or paste the transcript. The anamnesis comes out structured for review.",
		steps: { prepare: "Prepare", transcribe: "Transcribe", review: "Review" },
		modeLabel: "Consultation mode",
		modeLive: "Live consultation",
		modeDictation: "Post-consultation dictation",
		patientLabel: "Patient",
		unlinked: "unlinked",
		newPatientPlaceholder: "new patient",
		newPatientNameLabel: "New patient name",
		agePlaceholder: "age",
		newPatientAgeLabel: "New patient age",
		ageRequired: "Enter the patient's age.",
		patientCreateFailed: "Could not register the patient.",
		addPatient: "+ patient",
		completeRecord: "Complete the record",
		consentDeclaration: "I declare that the patient was informed and consented to the recording",
		tabRecord: "Record",
		tabUpload: "Upload",
		tabBot: "Teleconsult (bot)",
		dictationDescription:
			"The consultation already happened? Narrate everything out loud, as if explaining the case, in a single voice (yours): chief complaint, history, exam, and plan. The narration becomes the transcript that generates the anamnesis.",
		stopDictation: paramMessage("en", "Stop dictation ({elapsed})", ["elapsed"]),
		startDictation: "Start dictation",
		dictatingHint: paramMessage(
			"en",
			"recording… {elapsed}. The transcript appears below in real time",
			["elapsed"],
		),
		consentRequiredDictation: "Check the consent box above to enable dictation.",
		consentRequiredRecording: "Check the consent box above to enable recording.",
		unsupportedBrowser:
			"Recording is not supported in this browser. Use the sample or paste the text (Chrome/Edge support it).",
		uploading: "Transcribing…",
		uploadRecording: "Upload recording",
		uploadHint: "Audio transcribed on the server (Whisper)",
		recordMic: "Record microphone",
		stopMic: "Stop microphone",
		micHint: paramMessage("en", "Your voice, shown as “{doctor}”", ["doctor"]),
		captureTab: "Capture call tab",
		stopTab: "Stop tab",
		tabHint: paramMessage("en", "Call audio, shown as “{patient}”", ["patient"]),
		recordingTip:
			"Tip: enable both to separate doctor and patient, and use headphones so the microphone does not pick up the speakers.",
		channelsBadge: "free speaker labels via channels",
		botDescription:
			"The “KTB Health” bot joins your call (Meet/Zoom/Teams), transcribes with speaker separation, and generates the draft when the consultation ends.",
		teleconsultLinkLabel: "Teleconsult link",
		sendBot: "Send bot",
		botInCall: "bot in call…",
		consultationLive: paramMessage("en", "consultation #{id} · {status}", ["id", "status"]),
		transcribingLive: "transcribing live",
		callEnded: "call ended",
		recordingSpeak: "recording… speak normally",
		consultationText: "Consultation text",
		useSample: "Use sample",
		clear: "Clear",
		transcriptPlaceholder: "The transcript appears here (or paste the consultation text)",
		serverTranscript: "Server transcript",
		generating: "Generating anamnesis…",
		generate: "Generate anamnesis →",
		generatedFrom: paramMessage("en", "anamnesis generated from the {source} transcript", [
			"source",
		]),
		modelReady: (device) => `model ready${device ? ` (${device})` : ""}`,
		modelUnavailable: paramMessage("en", "model unavailable: {message}", ["message"]),
		lowConfidenceReprocessing: "low confidence, reprocessing on the server…",
		transcriptionRedone: "transcription redone on the server",
		engineLabel: paramMessage("en", "engine: {engine}", ["engine"]),
		waitingTitle: "Waiting for anamnesis",
		waitingDescription:
			"The structured anamnesis appears here. Each section shows the confidence and the source sentences that ground it.",
		saving: "Saving…",
		saveConsultation: "Save consultation",
		updateConsultation: "Update consultation",
		dialogErrorTitle: "Could not save",
		dialogUpdatedTitle: "Consultation updated",
		dialogSavedTitle: "Anamnesis saved successfully",
		viewConsultation: "View consultation",
		confirm: "Confirm",
		gotIt: "Got it",
		accessQuestion: paramMessage("en", "Send {patient} the patient portal access email?", [
			"patient",
		]),
		accessHint:
			"The patient signs in with this email address to see the consultations you saved, read-only.",
		accessEmailPlaceholder: "patient@email.com",
		accessSend: "Send access email",
		accessNotNow: "Not now",
		accessSent: paramMessage("en", "Access email sent to {email}.", ["email"]),
		accessUnsent: paramMessage(
			"en",
			"Portal access granted to {email}, but the email could not be sent. Ask the patient to sign in to the patient portal with this address.",
			["email"],
		),
		accessInvalidEmail: "Enter a valid email address.",
		accessFailed: "Could not send the access email. Please try again.",
		accessCardTitle: "Patient access to this consultation",
		accessCardNone: paramMessage("en", "{patient} doesn't have patient portal access yet.", [
			"patient",
		]),
		accessCardHasAccess: paramMessage(
			"en",
			"{patient} already has portal access — this consultation shows up there once saved.",
			["patient"],
		),
		accessSendOnSave: "Send access by email when saving",
		accessSkip: "Don't send for now",
		accessEmailLabel: "Patient email",
		newPatientAccessQuestion: "Send consultation access by email?",
		accessYes: "Yes",
		accessNo: "No",
		dialogSavedBody: ({ id, patientName, updated, consented }) =>
			`Consultation #${id}${patientName ? ` for ${patientName}` : ""} was ${updated ? "updated" : "saved"} with the reviewed anamnesis.${consented ? " Patient consent recorded." : ""}`,
		saveSessionExpired: "session expired. Reload the page",
		saveFailed: "could not save the consultation",
		anamnesisCopied: "Anamnesis copied to clipboard",
		copyFailed: "Could not copy. Select the text manually.",
		audioUploadFailed: paramMessage(
			"en",
			"Audio could not be uploaded ({message}). The consultation was saved without it.",
			["message"],
		),
		transcriptionFailedStatus: paramMessage("en", "transcription failed ({status})", ["status"]),
		transcriptionFailed: "transcription failed",
		botFailed: paramMessage("en", "bot failed: HTTP {status}", ["status"]),
		patientFallback: "patient",
	},
	admin: {
		title: "Consultations",
		none: "No consultations yet.",
		count: paramMessage(
			"en",
			"{n, plural, =1{{n} consultation} other{{n} consultations}} across all owners.",
			["n"],
		),
		emptyTitle: "No consultations",
		emptyDescription: "Consultations appear here once created.",
		colId: "Id",
		colStatus: "Status",
		colSource: "Source",
		colPatient: "Patient",
		colOwner: "Owner",
		colAudio: "Audio",
		colCreated: "Created",
		searchPlaceholder: "Search by patient or owner…",
		searchLabel: "Search consultations",
		noMatch: "No consultations match the search.",
		filteredCount: paramMessage("en", "Showing {shown} of {total}", ["shown", "total"]),
		colActions: "Actions",
		newConsultation: "New consultation",
		createTitle: "New consultation",
		createDescription: "Create a consultation record on behalf of an owner.",
		createFailed: "Could not create the consultation. Try again.",
		ownerLabel: "Owner",
		ownerPlaceholder: "Select an owner",
		patientLabel: "Patient",
		patientPlaceholder: "Select a patient",
		patientNone: "No patient",
		transcriptLabel: "Transcript",
		transcriptPlaceholder: "Optional transcript text…",
		deleteFor: paramMessage("en", "Delete {label}", ["label"]),
		deleteTitle: "Delete consultation?",
		deleteDescription: paramMessage("en", "This permanently deletes {label} and its recording.", [
			"label",
		]),
		deleteConfirm: "Delete permanently",
		cancel: "Cancel",
	},
	dashboard: {
		live: "Live now",
		byStatus: "Consultations by status",
		bySource: "By source",
		recentConsultations: "Recent consultations",
		viewAll: "View all",
	},
	zk: {
		lockedRecord: "Encrypted record",
		lockedHint: "Unlock it on an approved clinic device to view it.",
		decryptFailed: "This record could not be decrypted on this device.",
		exportLocked: "PDF export unavailable for encrypted records",
	},
	warmup: {
		title: "Prepare speech recognition",
		description:
			"Download the speech model once (~50 MB) so your first consultation doesn't wait on it. It runs in the background — you can keep working.",
		preparing: "Downloading speech model…",
		ready: (device) => `Speech recognition ready${device ? ` (${device})` : ""}`,
		failed: paramMessage("en", "Speech model unavailable: {message}", ["message"]),
		retry: "Retry",
		dismiss: "Dismiss",
	},
};

const ptBR: ConsultationMessages = {
	sources: {
		browser: "Voz do navegador",
		bot: "Teleconsulta (bot)",
		dictation: "Ditado",
		upload: "Upload",
	},
	speakers: { doctor: "Médico", patient: "Paciente" },
	sections: {
		queixa_principal: "Queixa principal",
		hda: "História da doença atual",
		antecedentes: "Antecedentes patológicos",
		alergias: "Alergias",
		medicamentos_em_uso: "Medicamentos em uso",
		exame_fisico: "Exame físico",
		hipoteses: "Hipóteses diagnósticas",
		conduta: "Conduta",
		historico: "Consultas anteriores",
	},
	confidence: { alta: "confiança alta", media: "confiança média", baixa: "confiança baixa" },
	common: {
		consultations: "Consultas",
		anamnesis: "Anamnese",
		transcript: "Transcrição",
		noTranscript: "Sem transcrição.",
		copy: "Copiar",
		downloadPdf: "Baixar PDF",
		engine: paramMessage("pt-BR", "motor: {engine}", ["engine"]),
		consultationId: paramMessage("pt-BR", "Consulta #{id}", ["id"]),
	},
	list: {
		title: "Consultas",
		none: "Nenhuma consulta ainda.",
		count: paramMessage(
			"pt-BR",
			"{n, plural, =1{{n} consulta registrada.} other{{n} consultas registradas.}}",
			["n"],
		),
		newConsultation: "+ Nova consulta",
		searchPlaceholder: "Buscar por paciente, queixa ou texto…",
		searchLabel: "Buscar consultas",
		filterLabel: "Filtrar consultas",
		filters: { all: "Todas", anamnesis: "Com anamnese", pending: "Pendentes" },
		unlinkedPatient: "Paciente não vinculado",
		patientRecord: "Cadastro do paciente",
		live: "ao vivo",
		noAnamnesis: "Sem anamnese",
		consent: "Consentimento ✓",
		downloadPdfTitle: "Baixar anamnese em PDF",
		open: "Abrir",
		noMatch: "Nenhuma consulta corresponde à busca.",
		emptyTitle: "Nenhuma consulta ainda",
		emptyDescription: "Inicie uma consulta para gravar a conversa e gerar a anamnese.",
		startConsultation: "Iniciar consulta",
		colPatient: "Paciente",
		colDate: "Data",
		colStatus: "Status",
		colActions: "Ações",
		filterAll: "Todos os status",
		filterLive: "Ao vivo",
		filterDone: "Concluídas",
		filterSourceAll: "Todas as fontes",
		filterAnamnesisAll: "Qualquer anamnese",
		filterAnamnesisWith: "Com anamnese",
		filterAnamnesisWithout: "Sem anamnese",
		filterReviewAll: "Qualquer revisão",
		filterReviewPending: "Revisão pendente",
		filterReviewDone: "Revisadas",
		filterReviewDeferred: "Adiadas",
		facetStatus: "Status",
		facetSource: "Origem",
		facetAnamnesis: "Anamnese",
		facetReview: "Revisão",
		deferredBadge: paramMessage("pt-BR", "Adiada até {date}", ["date"]),
		reviewedBadge: paramMessage("pt-BR", "Revisada v{n}", ["n"]),
		staleBadge: paramMessage("pt-BR", "Nova versão v{n}", ["n"]),
		transcriptReviewedBadge: "Transcrição conferida",
		sidebarPendingReview: paramMessage("pt-BR", "{n} pendentes de revisão", ["n"]),
		liveNow: "Ao vivo agora",
		needsReview: paramMessage(
			"pt-BR",
			"{n, plural, =1{{n} seção para revisar} other{{n} seções para revisar}}",
			["n"],
		),
		statsToday: "Hoje",
		statsReviewed: "Revisadas",
		statsNeedsReview: "Revisão pendente",
		previewComplaint: "Queixa principal",
		previewPlan: "Conduta",
	},
	detail: {
		back: "Consultas",
		metaTitle: "Detalhes",
		openPatientRecord: "Abrir cadastro do paciente",
		consentLabel: "Consentimento ✓",
		consentNotRecorded: "Consentimento não registrado",
		inProgress: "em andamento",
		previousConsultations: paramMessage(
			"pt-BR",
			"{n, plural, =1{{n} consulta anterior} other{{n} consultas anteriores}}",
			["n"],
		),
		anamnesisCopied: "Anamnese copiada",
		complaint: paramMessage("pt-BR", "Queixa: {text}", ["text"]),
		plan: paramMessage("pt-BR", "Conduta: {text}", ["text"]),
		historyNote:
			"Registro factual de consultas anteriores — apenas contexto, não sugestões clínicas.",
		notReported: "Não informado",
		evidence: paramMessage("pt-BR", "evidências ({n})", ["n"]),
		showEvidence: "Ver evidência",
		hideEvidence: "Ocultar evidência",
		evidenceTitle: "Evidência no transcript",
		noAnamnesisTitle: "Nenhuma anamnese salva",
		noAnamnesisDescription: "Esta consulta ainda não tem uma anamnese salva.",
		generateAnamnesis: "Gerar anamnese",
		integrity: {
			verified: "Integridade verificada",
			tampered: "Falha na verificação de integridade",
			unversioned: "Integridade não registrada",
		},
		confirmTranscript: "Conferir transcrição",
		transcriptConfirmed: paramMessage("pt-BR", "Conferida em {date}", ["date"]),
		approveAnamnesis: "Aprovar anamnese",
		approveAndNext: "Aprovar e próxima",
		anamnesisApproved: paramMessage("pt-BR", "Aprovada v{n}", ["n"]),
		anamnesisStale: paramMessage("pt-BR", "Nova versão v{n} pendente", ["n"]),
		deferLabel: "Adiar revisão",
		deferResume: "Voltar para a fila",
		deferredUntil: paramMessage("pt-BR", "Adiada até {date}", ["date"]),
		approvedToast: "Anamnese aprovada",
		queueDoneToast: "Fila de revisão concluída",
	},
	review: {
		title: "Modo de revisão",
		queueLabel: "Fila de revisão",
		pendingCount: paramMessage("pt-BR", "{n} pendentes", ["n"]),
		sessionDone: paramMessage("pt-BR", "{n} revisadas nesta sessão", ["n"]),
		queueEmptyTitle: "Fila de revisão zerada",
		queueEmptyDescription: "Todas as consultas foram revisadas. O ritual de fim de dia está feito.",
		missingTitle: "Consulta não encontrada",
		missingDescription: "Ela pode já ter sido revisada ou você não tem acesso a ela.",
		backToConsultations: "Voltar para consultas",
		stepTranscript: "Transcrição",
		stepAnamnesis: "Anamnese",
		legacyAudioBadge: "áudio legado",
		noAudioBadge: "sem áudio para conferência",
		nextUncertain: "Próxima incerteza",
		uncertainQueue: "Trechos para conferir",
		uncertainProgress: paramMessage("pt-BR", "{done} de {total} conferidos", ["done", "total"]),
		unverifySegment: "Desmarcar",
		highConfTitle: "Transcrição de alta confiança",
		highConfHint: "sem trechos duvidosos — conferência opcional",
		editSegment: "Editar trecho",
		editSection: "Editar seção",
		editFullText: "Editar transcrição",
		saveEdit: "Salvar",
		cancelEdit: "Cancelar",
		editedTag: "editado",
		pendingEdits: paramMessage("pt-BR", "{n} edições não conferidas", ["n"]),
		confirmAndContinue: "Confirmar transcrição e continuar",
		shortcutsTitle: "Atalhos de teclado",
		shortcutPlayPause: "reproduzir / pausar",
		shortcutSeekBack: "voltar 10s",
		shortcutKeySpace: "Espaço",
		shortcutConfirm: "confirmar transcrição",
		chapters: "Capítulos",
		staleAnamnesis: "A transcrição tem edições — regenere se a anamnese deve refleti-las.",
		regenerateAnamnesis: "Regenerar anamnese",
		deferredTag: "adiada",
		noAudioTag: "sem áudio",
		audioProcessingTag: "processando",
		notFound: "Registro não encontrado",
	},
	transcriptPanel: {
		sourceServer: "servidor · whisper large-v3-turbo",
		sourceBrowser: "navegador",
		sourceCorrected: "corrigida por LLM",
		enhancementFailed: "falha na melhoria — exibindo original",
		audioStored: "áudio armazenado",
		enhancing: "melhorando transcrição…",
		enhanced: "melhorada ✓",
		audioLabel: "Áudio da consulta",
		playbackRate: "Velocidade de reprodução",
		skipSilence: "Pular silêncios",
		tabChanges: "Mudanças",
		tabTranscript: "Transcrição",
		noChanges: "Sem diferenças entre original e corrigida.",
		tabCorrected: "Corrigida",
		tabOriginal: "Original",
	},
	newConsultation: {
		title: "Nova consulta",
		subtitle: "Grave a conversa ou cole a transcrição. A anamnese sai estruturada para revisão.",
		steps: { prepare: "Preparar", transcribe: "Transcrever", review: "Revisar" },
		modeLabel: "Modo da consulta",
		modeLive: "Consulta ao vivo",
		modeDictation: "Ditado pós-consulta",
		patientLabel: "Paciente",
		unlinked: "não vinculado",
		newPatientPlaceholder: "novo paciente",
		newPatientNameLabel: "Nome do novo paciente",
		agePlaceholder: "idade",
		newPatientAgeLabel: "Idade do novo paciente",
		ageRequired: "Informe a idade do paciente.",
		patientCreateFailed: "Não foi possível cadastrar o paciente.",
		addPatient: "+ paciente",
		completeRecord: "Completar o cadastro",
		consentDeclaration: "Declaro que o paciente foi informado e consentiu com a gravação",
		tabRecord: "Gravar",
		tabUpload: "Upload",
		tabBot: "Teleconsulta (bot)",
		dictationDescription:
			"A consulta já aconteceu? Narre tudo em voz alta, como se explicasse o caso, em uma única voz (a sua): queixa principal, história, exame e conduta. A narração vira a transcrição que gera a anamnese.",
		stopDictation: paramMessage("pt-BR", "Parar ditado ({elapsed})", ["elapsed"]),
		startDictation: "Iniciar ditado",
		dictatingHint: paramMessage(
			"pt-BR",
			"gravando… {elapsed}. A transcrição aparece abaixo em tempo real",
			["elapsed"],
		),
		consentRequiredDictation: "Marque a caixa de consentimento acima para ativar o ditado.",
		consentRequiredRecording: "Marque a caixa de consentimento acima para ativar a gravação.",
		unsupportedBrowser:
			"A gravação não é suportada neste navegador. Use o exemplo ou cole o texto (Chrome/Edge suportam).",
		uploading: "Transcrevendo…",
		uploadRecording: "Enviar gravação",
		uploadHint: "Áudio transcrito no servidor (Whisper)",
		recordMic: "Gravar microfone",
		stopMic: "Parar microfone",
		micHint: paramMessage("pt-BR", "Sua voz, exibida como “{doctor}”", ["doctor"]),
		captureTab: "Capturar aba da chamada",
		stopTab: "Parar aba",
		tabHint: paramMessage("pt-BR", "Áudio da chamada, exibido como “{patient}”", ["patient"]),
		recordingTip:
			"Dica: ative os dois para separar médico e paciente, e use fones de ouvido para o microfone não captar as caixas de som.",
		channelsBadge: "vozes separadas por canais",
		botDescription:
			"O bot “KTB Health” entra na sua chamada (Meet/Zoom/Teams), transcreve com separação de vozes e gera o rascunho ao fim da consulta.",
		teleconsultLinkLabel: "Link da teleconsulta",
		sendBot: "Enviar bot",
		botInCall: "bot na chamada…",
		consultationLive: paramMessage("pt-BR", "consulta #{id} · {status}", ["id", "status"]),
		transcribingLive: "transcrevendo ao vivo",
		callEnded: "chamada encerrada",
		recordingSpeak: "gravando… fale normalmente",
		consultationText: "Texto da consulta",
		useSample: "Usar exemplo",
		clear: "Limpar",
		transcriptPlaceholder: "A transcrição aparece aqui (ou cole o texto da consulta)",
		serverTranscript: "Transcrição do servidor",
		generating: "Gerando anamnese…",
		generate: "Gerar anamnese →",
		generatedFrom: paramMessage("pt-BR", "anamnese gerada a partir da transcrição {source}", [
			"source",
		]),
		modelReady: (device) => `modelo pronto${device ? ` (${device})` : ""}`,
		modelUnavailable: paramMessage("pt-BR", "modelo indisponível: {message}", ["message"]),
		lowConfidenceReprocessing: "confiança baixa, reprocessando no servidor…",
		transcriptionRedone: "transcrição refeita no servidor",
		engineLabel: paramMessage("pt-BR", "motor: {engine}", ["engine"]),
		waitingTitle: "Aguardando anamnese",
		waitingDescription:
			"A anamnese estruturada aparece aqui. Cada seção mostra a confiança e as frases de origem que a sustentam.",
		saving: "Salvando…",
		saveConsultation: "Salvar consulta",
		updateConsultation: "Atualizar consulta",
		dialogErrorTitle: "Não foi possível salvar",
		dialogUpdatedTitle: "Consulta atualizada",
		dialogSavedTitle: "Anamnese salva com sucesso",
		viewConsultation: "Ver consulta",
		confirm: "Confirmar",
		gotIt: "Entendi",
		accessQuestion: paramMessage(
			"pt-BR",
			"Enviar para {patient} o e-mail de acesso ao portal do paciente?",
			["patient"],
		),
		accessHint:
			"O paciente entra com este e-mail para ver, somente para leitura, as consultas que você salvou.",
		accessEmailPlaceholder: "paciente@email.com",
		accessSend: "Enviar e-mail de acesso",
		accessNotNow: "Agora não",
		accessSent: paramMessage("pt-BR", "E-mail de acesso enviado para {email}.", ["email"]),
		accessUnsent: paramMessage(
			"pt-BR",
			"Acesso ao portal liberado para {email}, mas o e-mail não pôde ser enviado. Peça ao paciente que entre no portal do paciente com este endereço.",
			["email"],
		),
		accessInvalidEmail: "Informe um e-mail válido.",
		accessFailed: "Não foi possível enviar o e-mail de acesso. Tente novamente.",
		accessCardTitle: "Acesso do paciente à consulta",
		accessCardNone: paramMessage("pt-BR", "{patient} ainda não tem acesso ao portal do paciente.", [
			"patient",
		]),
		accessCardHasAccess: paramMessage(
			"pt-BR",
			"{patient} já tem acesso ao portal — a consulta aparece lá assim que for salva.",
			["patient"],
		),
		accessSendOnSave: "Enviar acesso por e-mail ao salvar",
		accessSkip: "Não enviar agora",
		accessEmailLabel: "E-mail do paciente",
		newPatientAccessQuestion: "Enviar acesso à consulta por e-mail?",
		accessYes: "Sim",
		accessNo: "Não",
		dialogSavedBody: ({ id, patientName, updated, consented }) =>
			`A consulta #${id}${patientName ? ` de ${patientName}` : ""} foi ${updated ? "atualizada" : "salva"} com a anamnese revisada.${consented ? " Consentimento do paciente registrado." : ""}`,
		saveSessionExpired: "sessão expirada. Recarregue a página",
		saveFailed: "não foi possível salvar a consulta",
		anamnesisCopied: "Anamnese copiada para a área de transferência",
		copyFailed: "Não foi possível copiar. Selecione o texto manualmente.",
		audioUploadFailed: paramMessage(
			"pt-BR",
			"Não foi possível enviar o áudio ({message}). A consulta foi salva sem ele.",
			["message"],
		),
		transcriptionFailedStatus: paramMessage("pt-BR", "transcrição falhou ({status})", ["status"]),
		transcriptionFailed: "falha na transcrição",
		botFailed: paramMessage("pt-BR", "bot falhou: HTTP {status}", ["status"]),
		patientFallback: "paciente",
	},
	admin: {
		title: "Consultas",
		none: "Nenhuma consulta ainda.",
		count: paramMessage(
			"pt-BR",
			"{n, plural, =1{{n} consulta} other{{n} consultas}} em toda a plataforma.",
			["n"],
		),
		emptyTitle: "Nenhuma consulta",
		emptyDescription: "As consultas aparecem aqui após serem criadas.",
		colId: "Id",
		colStatus: "Status",
		colSource: "Origem",
		colPatient: "Paciente",
		colOwner: "Proprietário",
		colAudio: "Áudio",
		colCreated: "Criada em",
		searchPlaceholder: "Buscar por paciente ou proprietário…",
		searchLabel: "Buscar consultas",
		noMatch: "Nenhuma consulta corresponde à busca.",
		filteredCount: paramMessage("pt-BR", "Exibindo {shown} de {total}", ["shown", "total"]),
		colActions: "Ações",
		newConsultation: "Nova consulta",
		createTitle: "Nova consulta",
		createDescription: "Crie um registro de consulta em nome de um proprietário.",
		createFailed: "Não foi possível criar a consulta. Tente novamente.",
		ownerLabel: "Proprietário",
		ownerPlaceholder: "Selecione um proprietário",
		patientLabel: "Paciente",
		patientPlaceholder: "Selecione um paciente",
		patientNone: "Sem paciente",
		transcriptLabel: "Transcrição",
		transcriptPlaceholder: "Texto da transcrição (opcional)…",
		deleteFor: paramMessage("pt-BR", "Excluir {label}", ["label"]),
		deleteTitle: "Excluir consulta?",
		deleteDescription: paramMessage(
			"pt-BR",
			"Isso exclui permanentemente {label} e sua gravação.",
			["label"],
		),
		deleteConfirm: "Excluir permanentemente",
		cancel: "Cancelar",
	},
	dashboard: {
		live: "Ao vivo",
		byStatus: "Consultas por status",
		bySource: "Por origem",
		recentConsultations: "Consultas recentes",
		viewAll: "Ver tudo",
	},
	zk: {
		lockedRecord: "Registro criptografado",
		lockedHint: "Desbloqueie em um dispositivo aprovado da clínica para visualizar.",
		decryptFailed: "Não foi possível descriptografar este registro neste dispositivo.",
		exportLocked: "Exportação em PDF indisponível para registros criptografados",
	},
	warmup: {
		title: "Preparar reconhecimento de voz",
		description:
			"Baixe o modelo de fala uma vez (~50 MB) para que a primeira consulta não espere por ele. A execução é em segundo plano — você pode continuar trabalhando.",
		preparing: "Baixando modelo de fala…",
		ready: (device) => `Reconhecimento de voz pronto${device ? ` (${device})` : ""}`,
		failed: paramMessage("pt-BR", "Modelo de fala indisponível: {message}", ["message"]),
		retry: "Tentar novamente",
		dismiss: "Dispensar",
	},
};

const es: ConsultationMessages = {
	sources: {
		browser: "Voz del navegador",
		bot: "Teleconsulta (bot)",
		dictation: "Dictado",
		upload: "Carga",
	},
	speakers: { doctor: "Médico", patient: "Paciente" },
	sections: {
		queixa_principal: "Motivo de consulta",
		hda: "Historia de la enfermedad actual",
		antecedentes: "Antecedentes patológicos",
		alergias: "Alergias",
		medicamentos_em_uso: "Medicamentos en uso",
		exame_fisico: "Examen físico",
		hipoteses: "Hipótesis diagnósticas",
		conduta: "Plan de manejo",
		historico: "Consultas anteriores",
	},
	confidence: { alta: "confianza alta", media: "confianza media", baixa: "confianza baja" },
	common: {
		consultations: "Consultas",
		anamnesis: "Anamnesis",
		transcript: "Transcripción",
		noTranscript: "Sin transcripción.",
		copy: "Copiar",
		downloadPdf: "Descargar PDF",
		engine: paramMessage("es", "motor: {engine}", ["engine"]),
		consultationId: paramMessage("es", "Consulta #{id}", ["id"]),
	},
	list: {
		title: "Consultas",
		none: "Ninguna consulta aún.",
		count: paramMessage(
			"es",
			"{n, plural, =1{{n} consulta registrada.} other{{n} consultas registradas.}}",
			["n"],
		),
		newConsultation: "+ Nueva consulta",
		searchPlaceholder: "Buscar por paciente, motivo o texto…",
		searchLabel: "Buscar consultas",
		filterLabel: "Filtrar consultas",
		filters: { all: "Todas", anamnesis: "Con anamnesis", pending: "Pendientes" },
		unlinkedPatient: "Paciente no vinculado",
		patientRecord: "Registro del paciente",
		live: "en vivo",
		noAnamnesis: "Sin anamnesis",
		consent: "Consentimiento ✓",
		downloadPdfTitle: "Descargar anamnesis en PDF",
		open: "Abrir",
		noMatch: "Ninguna consulta coincide con la búsqueda.",
		emptyTitle: "Ninguna consulta aún",
		emptyDescription: "Inicie una consulta para grabar la conversación y generar la anamnesis.",
		startConsultation: "Iniciar consulta",
		colPatient: "Paciente",
		colDate: "Fecha",
		colStatus: "Estado",
		colActions: "Acciones",
		filterAll: "Todos los estados",
		filterLive: "En vivo",
		filterDone: "Finalizadas",
		filterSourceAll: "Todas las fuentes",
		filterAnamnesisAll: "Cualquier anamnesis",
		filterAnamnesisWith: "Con anamnesis",
		filterAnamnesisWithout: "Sin anamnesis",
		filterReviewAll: "Cualquier revisión",
		filterReviewPending: "Revisión pendiente",
		filterReviewDone: "Revisadas",
		filterReviewDeferred: "Aplazadas",
		facetStatus: "Estado",
		facetSource: "Origen",
		facetAnamnesis: "Anamnesis",
		facetReview: "Revisión",
		deferredBadge: paramMessage("es", "Aplazada hasta {date}", ["date"]),
		reviewedBadge: paramMessage("es", "Revisada v{n}", ["n"]),
		staleBadge: paramMessage("es", "Nueva versión v{n}", ["n"]),
		transcriptReviewedBadge: "Transcripción confirmada",
		sidebarPendingReview: paramMessage("es", "{n} pendientes de revisión", ["n"]),
		liveNow: "En vivo ahora",
		needsReview: paramMessage(
			"es",
			"{n, plural, =1{{n} sección por revisar} other{{n} secciones por revisar}}",
			["n"],
		),
		statsToday: "Hoy",
		statsReviewed: "Revisadas",
		statsNeedsReview: "Requiere revisión",
		previewComplaint: "Motivo de consulta",
		previewPlan: "Plan",
	},
	detail: {
		back: "Consultas",
		metaTitle: "Detalles",
		openPatientRecord: "Abrir registro del paciente",
		consentLabel: "Consentimiento ✓",
		consentNotRecorded: "Consentimiento no registrado",
		inProgress: "en curso",
		previousConsultations: paramMessage(
			"es",
			"{n, plural, =1{{n} consulta anterior} other{{n} consultas anteriores}}",
			["n"],
		),
		anamnesisCopied: "Anamnesis copiada",
		complaint: paramMessage("es", "Motivo: {text}", ["text"]),
		plan: paramMessage("es", "Plan: {text}", ["text"]),
		historyNote:
			"Registro factual de consultas anteriores — solo contexto, no sugerencias clínicas.",
		notReported: "No informado",
		evidence: paramMessage("es", "evidencias ({n})", ["n"]),
		showEvidence: "Ver evidencia",
		hideEvidence: "Ocultar evidencia",
		evidenceTitle: "Evidencia en la transcripción",
		noAnamnesisTitle: "Ninguna anamnesis guardada",
		noAnamnesisDescription: "Esta consulta aún no tiene una anamnesis guardada.",
		generateAnamnesis: "Generar anamnesis",
		integrity: {
			verified: "Integridad verificada",
			tampered: "Falló la verificación de integridad",
			unversioned: "Integridad no registrada",
		},
		confirmTranscript: "Confirmar transcripción",
		transcriptConfirmed: paramMessage("es", "Confirmada el {date}", ["date"]),
		approveAnamnesis: "Aprobar anamnesis",
		approveAndNext: "Aprobar y siguiente",
		anamnesisApproved: paramMessage("es", "Aprobada v{n}", ["n"]),
		anamnesisStale: paramMessage("es", "Nueva versión v{n} pendiente", ["n"]),
		deferLabel: "Aplazar revisión",
		deferResume: "Volver a la cola",
		deferredUntil: paramMessage("es", "Aplazada hasta {date}", ["date"]),
		approvedToast: "Anamnesis aprobada",
		queueDoneToast: "Cola de revisión completada",
	},
	review: {
		title: "Modo de revisión",
		queueLabel: "Cola de revisión",
		pendingCount: paramMessage("es", "{n} pendientes", ["n"]),
		sessionDone: paramMessage("es", "{n} revisadas en esta sesión", ["n"]),
		queueEmptyTitle: "Cola de revisión vacía",
		queueEmptyDescription:
			"Todas las consultas están revisadas. El ritual de fin de día está listo.",
		missingTitle: "Consulta no encontrada",
		missingDescription: "Puede que ya haya sido revisada o que no tengas acceso a ella.",
		backToConsultations: "Volver a consultas",
		stepTranscript: "Transcripción",
		stepAnamnesis: "Anamnesis",
		legacyAudioBadge: "audio heredado",
		noAudioBadge: "sin audio para cotejar",
		nextUncertain: "Siguiente incertidumbre",
		uncertainQueue: "Pasajes por cotejar",
		uncertainProgress: paramMessage("es", "{done} de {total} cotejados", ["done", "total"]),
		unverifySegment: "Desmarcar",
		highConfTitle: "Transcripción de alta confianza",
		highConfHint: "sin pasajes dudosos — cotejo opcional",
		editSegment: "Editar fragmento",
		editSection: "Editar sección",
		editFullText: "Editar transcripción",
		saveEdit: "Guardar",
		cancelEdit: "Cancelar",
		editedTag: "editado",
		pendingEdits: paramMessage("es", "{n} ediciones sin confirmar", ["n"]),
		confirmAndContinue: "Confirmar transcripción y continuar",
		shortcutsTitle: "Atajos de teclado",
		shortcutPlayPause: "reproducir / pausa",
		shortcutSeekBack: "retroceder 10s",
		shortcutKeySpace: "Espacio",
		shortcutConfirm: "confirmar transcripción",
		chapters: "Capítulos",
		staleAnamnesis: "La transcripción tiene ediciones — regenera si la anamnesis debe reflejarlas.",
		regenerateAnamnesis: "Regenerar anamnesis",
		deferredTag: "aplazada",
		noAudioTag: "sin audio",
		audioProcessingTag: "procesando",
		notFound: "Registro no encontrado",
	},
	transcriptPanel: {
		sourceServer: "servidor · whisper large-v3-turbo",
		sourceBrowser: "navegador",
		sourceCorrected: "corregida por LLM",
		enhancementFailed: "falló la mejora — mostrando original",
		audioStored: "audio almacenado",
		enhancing: "mejorando transcripción…",
		enhanced: "mejorada ✓",
		audioLabel: "Audio de la consulta",
		playbackRate: "Velocidad de reproducción",
		skipSilence: "Saltar silencios",
		tabChanges: "Cambios",
		tabTranscript: "Transcripción",
		noChanges: "Sin diferencias entre original y corregida.",
		tabCorrected: "Corregida",
		tabOriginal: "Original",
	},
	newConsultation: {
		title: "Nueva consulta",
		subtitle:
			"Grabe la conversación o pegue la transcripción. La anamnesis sale estructurada para revisión.",
		steps: { prepare: "Preparar", transcribe: "Transcribir", review: "Revisar" },
		modeLabel: "Modo de la consulta",
		modeLive: "Consulta en vivo",
		modeDictation: "Dictado posconsulta",
		patientLabel: "Paciente",
		unlinked: "no vinculado",
		newPatientPlaceholder: "nuevo paciente",
		newPatientNameLabel: "Nombre del nuevo paciente",
		agePlaceholder: "edad",
		newPatientAgeLabel: "Edad del nuevo paciente",
		ageRequired: "Ingrese la edad del paciente.",
		patientCreateFailed: "No se pudo registrar el paciente.",
		addPatient: "+ paciente",
		completeRecord: "Completar el registro",
		consentDeclaration: "Declaro que el paciente fue informado y consintió la grabación",
		tabRecord: "Grabar",
		tabUpload: "Carga",
		tabBot: "Teleconsulta (bot)",
		dictationDescription:
			"¿La consulta ya ocurrió? Narre todo en voz alta, como si explicara el caso, en una sola voz (la suya): motivo de consulta, historia, examen y plan. La narración se convierte en la transcripción que genera la anamnesis.",
		stopDictation: paramMessage("es", "Detener dictado ({elapsed})", ["elapsed"]),
		startDictation: "Iniciar dictado",
		dictatingHint: paramMessage(
			"es",
			"grabando… {elapsed}. La transcripción aparece abajo en tiempo real",
			["elapsed"],
		),
		consentRequiredDictation: "Marque la casilla de consentimiento arriba para activar el dictado.",
		consentRequiredRecording:
			"Marque la casilla de consentimiento arriba para activar la grabación.",
		unsupportedBrowser:
			"La grabación no es compatible con este navegador. Use el ejemplo o pegue el texto (Chrome/Edge lo admiten).",
		uploading: "Transcribiendo…",
		uploadRecording: "Enviar grabación",
		uploadHint: "Audio transcrito en el servidor (Whisper)",
		recordMic: "Grabar micrófono",
		stopMic: "Detener micrófono",
		micHint: paramMessage("es", "Su voz, mostrada como “{doctor}”", ["doctor"]),
		captureTab: "Capturar pestaña de la llamada",
		stopTab: "Detener pestaña",
		tabHint: paramMessage("es", "Audio de la llamada, mostrado como “{patient}”", ["patient"]),
		recordingTip:
			"Consejo: active ambos para separar médico y paciente, y use auriculares para que el micrófono no capte los altavoces.",
		channelsBadge: "voces separadas por canales",
		botDescription:
			"El bot “KTB Health” se une a su llamada (Meet/Zoom/Teams), transcribe con separación de voces y genera el borrador al final de la consulta.",
		teleconsultLinkLabel: "Enlace de teleconsulta",
		sendBot: "Enviar bot",
		botInCall: "bot en la llamada…",
		consultationLive: paramMessage("es", "consulta #{id} · {status}", ["id", "status"]),
		transcribingLive: "transcribiendo en vivo",
		callEnded: "llamada finalizada",
		recordingSpeak: "grabando… hable con normalidad",
		consultationText: "Texto de la consulta",
		useSample: "Usar ejemplo",
		clear: "Limpiar",
		transcriptPlaceholder: "La transcripción aparece aquí (o pegue el texto de la consulta)",
		serverTranscript: "Transcripción del servidor",
		generating: "Generando anamnesis…",
		generate: "Generar anamnesis →",
		generatedFrom: paramMessage("es", "anamnesis generada a partir de la transcripción {source}", [
			"source",
		]),
		modelReady: (device) => `modelo listo${device ? ` (${device})` : ""}`,
		modelUnavailable: paramMessage("es", "modelo no disponible: {message}", ["message"]),
		lowConfidenceReprocessing: "confianza baja, reprocesando en el servidor…",
		transcriptionRedone: "transcripción rehecha en el servidor",
		engineLabel: paramMessage("es", "motor: {engine}", ["engine"]),
		waitingTitle: "Esperando anamnesis",
		waitingDescription:
			"La anamnesis estructurada aparece aquí. Cada sección muestra la confianza y las frases de origen que la respaldan.",
		saving: "Guardando…",
		saveConsultation: "Guardar consulta",
		updateConsultation: "Actualizar consulta",
		dialogErrorTitle: "No se pudo guardar",
		dialogUpdatedTitle: "Consulta actualizada",
		dialogSavedTitle: "Anamnesis guardada con éxito",
		viewConsultation: "Ver consulta",
		confirm: "Confirmar",
		gotIt: "Entendido",
		accessQuestion: paramMessage(
			"es",
			"¿Enviar a {patient} el correo de acceso al portal del paciente?",
			["patient"],
		),
		accessHint:
			"El paciente inicia sesión con este correo para ver, solo en lectura, las consultas que guardaste.",
		accessEmailPlaceholder: "paciente@correo.com",
		accessSend: "Enviar correo de acceso",
		accessNotNow: "Ahora no",
		accessSent: paramMessage("es", "Correo de acceso enviado a {email}.", ["email"]),
		accessUnsent: paramMessage(
			"es",
			"Acceso al portal concedido a {email}, pero no se pudo enviar el correo. Pide al paciente que inicie sesión en el portal del paciente con esta dirección.",
			["email"],
		),
		accessInvalidEmail: "Ingresa un correo válido.",
		accessFailed: "No se pudo enviar el correo de acceso. Inténtalo de nuevo.",
		accessCardTitle: "Acceso del paciente a la consulta",
		accessCardNone: paramMessage("es", "{patient} aún no tiene acceso al portal del paciente.", [
			"patient",
		]),
		accessCardHasAccess: paramMessage(
			"es",
			"{patient} ya tiene acceso al portal — la consulta aparecerá allí al guardarla.",
			["patient"],
		),
		accessSendOnSave: "Enviar acceso por correo al guardar",
		accessSkip: "No enviar por ahora",
		accessEmailLabel: "Correo del paciente",
		newPatientAccessQuestion: "¿Enviar acceso a la consulta por correo?",
		accessYes: "Sí",
		accessNo: "No",
		dialogSavedBody: ({ id, patientName, updated, consented }) =>
			`La consulta #${id}${patientName ? ` de ${patientName}` : ""} fue ${updated ? "actualizada" : "guardada"} con la anamnesis revisada.${consented ? " Consentimiento del paciente registrado." : ""}`,
		saveSessionExpired: "sesión expirada. Recargue la página",
		saveFailed: "no se pudo guardar la consulta",
		anamnesisCopied: "Anamnesis copiada al portapapeles",
		copyFailed: "No se pudo copiar. Seleccione el texto manualmente.",
		audioUploadFailed: paramMessage(
			"es",
			"No se pudo enviar el audio ({message}). La consulta se guardó sin él.",
			["message"],
		),
		transcriptionFailedStatus: paramMessage("es", "la transcripción falló ({status})", ["status"]),
		transcriptionFailed: "falló la transcripción",
		botFailed: paramMessage("es", "el bot falló: HTTP {status}", ["status"]),
		patientFallback: "paciente",
	},
	admin: {
		title: "Consultas",
		none: "Ninguna consulta aún.",
		count: paramMessage(
			"es",
			"{n, plural, =1{{n} consulta} other{{n} consultas}} en toda la plataforma.",
			["n"],
		),
		emptyTitle: "Ninguna consulta",
		emptyDescription: "Las consultas aparecen aquí una vez creadas.",
		colId: "Id",
		colStatus: "Estado",
		colSource: "Origen",
		colPatient: "Paciente",
		colOwner: "Propietario",
		colAudio: "Audio",
		colCreated: "Creada",
		searchPlaceholder: "Buscar por paciente o propietario…",
		searchLabel: "Buscar consultas",
		noMatch: "Ninguna consulta coincide con la búsqueda.",
		filteredCount: paramMessage("es", "Mostrando {shown} de {total}", ["shown", "total"]),
		colActions: "Acciones",
		newConsultation: "Nueva consulta",
		createTitle: "Nueva consulta",
		createDescription: "Cree un registro de consulta en nombre de un propietario.",
		createFailed: "No se pudo crear la consulta. Inténtelo de nuevo.",
		ownerLabel: "Propietario",
		ownerPlaceholder: "Seleccione un propietario",
		patientLabel: "Paciente",
		patientPlaceholder: "Seleccione un paciente",
		patientNone: "Sin paciente",
		transcriptLabel: "Transcripción",
		transcriptPlaceholder: "Texto de la transcripción (opcional)…",
		deleteFor: paramMessage("es", "Eliminar {label}", ["label"]),
		deleteTitle: "¿Eliminar consulta?",
		deleteDescription: paramMessage("es", "Esto elimina permanentemente {label} y su grabación.", [
			"label",
		]),
		deleteConfirm: "Eliminar permanentemente",
		cancel: "Cancelar",
	},
	dashboard: {
		live: "En vivo",
		byStatus: "Consultas por estado",
		bySource: "Por origen",
		recentConsultations: "Consultas recientes",
		viewAll: "Ver todo",
	},
	zk: {
		lockedRecord: "Registro cifrado",
		lockedHint: "Desbloquéalo en un dispositivo aprobado de la clínica para verlo.",
		decryptFailed: "No se pudo descifrar este registro en este dispositivo.",
		exportLocked: "Exportación a PDF no disponible para registros cifrados",
	},
	warmup: {
		title: "Preparar reconocimiento de voz",
		description:
			"Descarga el modelo de voz una vez (~50 MB) para que la primera consulta no tenga que esperarlo. Se ejecuta en segundo plano — puedes seguir trabajando.",
		preparing: "Descargando modelo de voz…",
		ready: (device) => `Reconocimiento de voz listo${device ? ` (${device})` : ""}`,
		failed: paramMessage("es", "Modelo de voz no disponible: {message}", ["message"]),
		retry: "Reintentar",
		dismiss: "Descartar",
	},
};

const CATALOGS: Record<ConsultationLocale, ConsultationMessages> = { en, "pt-BR": ptBR, es };

export const isConsultationLocale = (locale: string): locale is ConsultationLocale =>
	(CONSULTATION_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const consultationMessages = (locale: string): ConsultationMessages =>
	CATALOGS[isConsultationLocale(locale) ? locale : BASE_LOCALE];

/** Localized capture-source label; unknown/absent sources pass through. */
export const sourceLabel = (t: ConsultationMessages, source: string | null | undefined): string =>
	source !== null && source !== undefined && source in t.sources
		? t.sources[source as keyof ConsultationMessages["sources"]]
		: (source ?? "");
