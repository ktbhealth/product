/**
 * Transport-level queue names this deployment binds — the single
 * source for the names Cloudflare Queues carry (`batch.queue` in the
 * worker entry's queue handler, the wrangler/alchemy consumer config)
 * and the names the /platform queue registry publishes. Queue-name
 * literals live ONLY here (and in deploy config that cannot import
 * TS); dispatch and introspection derive from these constants.
 */

/** Shared transcription + generic-jobs queue (AUDIO_QUEUE binding). */
export const AUDIO_QUEUE_NAME = "ktb-transcription";

/** Dedicated theme-assets queue (THEME_ASSETS_QUEUE binding, PL-006
 * phase 4) — image derivatives and font downloads never contend with
 * transcription. */
export const THEME_ASSETS_QUEUE_NAME = "ktb-theme-assets";
