/**
 * App-bound re-export for the theme asset queue consumer (T-137): the
 * pipeline itself lives in `@ktb/theme/jobs` — this module keeps the
 * composition edge's stable specifier for server.ts (which partitions
 * queue batches by envelope kind), the dev:node
 * local queue and the worker-entry tests. The platform import
 * registers the ServerRuntime that `defaultThemeJobDeps` resolves
 * (same role `#/lib/platform.ts` plays for the audio consumer).
 */
import "#/lib/platform.ts";

export { handleThemeQueueBatch } from "@ktb/theme/jobs";
