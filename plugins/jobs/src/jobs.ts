import type { JobStatusValue } from "@ktbhealth/ui/components/job-status";

import { AUDIO_JOB_STATUSES, AUDIO_RETRY_STATUSES } from "@ktb/consultations/api";
import type { AudioJobRow } from "@ktb/consultations/api";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import type { ConsoleJob } from "./context.ts";
import { jobMessages, I18N_NAMESPACE } from "./i18n.ts";

// Canonical row shape + status vocabularies live in @ktb/consultations/api
// (client-safe); re-exported so existing "../jobs.ts" importers are
// unaffected.
export type { AudioJobRow } from "@ktb/consultations/api";

const STATUS_MAP: Record<string, JobStatusValue | undefined> = {
	stored: "queued",
	queued: "queued",
	processing: "processing",
	done: "done",
	failed: "failed",
} satisfies Record<(typeof AUDIO_JOB_STATUSES)[number], JobStatusValue>;

/**
 * Audio-pipeline status → job badge status; null for rows that are not
 * jobs ("none" or unmapped). Client-safe — the ops console reuses it.
 */
export const jobStatusOf = (audioStatus: string): JobStatusValue | null =>
	STATUS_MAP[audioStatus] ?? null;

/**
 * Audio statuses the admin retry accepts — the canonical
 * `AUDIO_RETRY_STATUSES` from @ktb/consultations/api (kept under this
 * name so views stay client-safe; the service re-checks server-side).
 */
export const RETRYABLE_AUDIO_STATUSES = AUDIO_RETRY_STATUSES;

export const isAudioRetryable = (audioStatus: string): boolean =>
	(RETRYABLE_AUDIO_STATUSES as readonly string[]).includes(audioStatus);

const fmtDate = (value: Date | string, locale: string): string => {
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale);
};

/**
 * Map consultation audio-pipeline rows to console jobs. Rows with
 * `audioStatus: "none"` (no recording) are skipped — they are not jobs.
 * `locale` localizes the job title/description copy.
 */
export const jobsFromAudioRows = (
	rows: readonly AudioJobRow[],
	locale = "en",
	i18n?: PageI18nSlice,
): ConsoleJob[] => {
	const t = sliceMessages(i18n, I18N_NAMESPACE, jobMessages(locale));
	return rows.flatMap((row) => {
		const status = STATUS_MAP[row.audioStatus];
		if (status === undefined) return [];
		return [
			{
				id: `audio-${row.id}`,
				title: t.jobTitle,
				description: row.patientName ?? t.consultationRef(row.id),
				status,
				meta: row.audioError ?? fmtDate(row.createdAt, locale),
				...(row.audioError ? { error: row.audioError } : {}),
			},
		];
	});
};

/**
 * Single-row variant for live SSE deltas (`/api/jobs` frames carry one
 * AudioJobRow at a time) — null when the row isn't a job
 * (audioStatus "none" or unmapped), so callers can drop it.
 */
export const jobFromAudioRow = (
	row: AudioJobRow,
	locale = "en",
	i18n?: PageI18nSlice,
): ConsoleJob | null => jobsFromAudioRows([row], locale, i18n)[0] ?? null;
