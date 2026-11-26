import { resolveTranscriptionBackend } from "@ktb/transcription";
import { webSpeechBackend, webSpeechCandidate } from "@ktb/transcription-webspeech";
import { whisperCandidate } from "@ktb/transcription-whisper";

// Documented client-side injection point (see vite.config.ts): backend
// selection is data — the first supported driver wins and array order
// breaks ties, the same rule @ktb/driver-framework applies server-side.
// Web Speech is the last-resort backend when nothing else is eligible.
const resolvedBackend = resolveTranscriptionBackend([whisperCandidate, webSpeechCandidate]);
export const transcriptionBackend = resolvedBackend?.backend ?? webSpeechBackend;
/** Driver that won resolution (`"whisper"`, `"webspeech"`, …) — lets
 * views gate engine-specific UX (e.g. the model warm-up card) without
 * probing the backend shape. `null` when no candidate was eligible and
 * the webSpeech last-resort was injected instead. */
export const transcriptionDriverId = resolvedBackend?.driverId ?? null;
