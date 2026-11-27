/**
 * Env parsing helpers for the jobs worker entrypoint — kept separate
 * from main.ts so the parsing is unit-testable without booting the
 * worker loop.
 */

/** JOBS_BATCH — positive integer, default 10. Anything else (unset,
 * non-numeric, zero, negative, fractional) falls back to the default
 * so a typo can't silently disable consumption. */
export const batchSizeFromEnv = (value: string | undefined): number => {
	if (value === undefined) return 10;
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : 10;
};
