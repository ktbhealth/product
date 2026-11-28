import type { OrchestrationPack } from "@ktb/orchestrator";
import { transcriptOrchestrationPack } from "@ktb/plugin-pipeline-transcript/orchestration";

/**
 * packs.ts — plugin-contributed orchestration packs the jobs worker
 * registers alongside `builtinKinds`.
 *
 * apps/web discovers packs through `import.meta.glob` over each
 * plugin's `src/index.ts` (a Vite transform); this process is plain
 * Bun, so the pack list is explicit — add the pack here when a plugin
 * starts contributing `orchestrations` (today:
 * pipeline-transcript's consultation-transcript def). Only the
 * `./orchestration` subpath is imported — never the plugin's index —
 * so UI/React surfaces stay out of this process.
 *
 * Pack kinds still degrade honestly at fire time: their ambient port
 * probes (PlatformLlm/PlatformDecisions/EnvCorrector/…) resolve
 * against the runner's ambientContext, which carries only the
 * OrchestratorRegistry — absent ports produce `{skipped: true}` /
 * disabled-state outputs by design, not failures.
 */
export const ORCHESTRATION_PACKS: readonly OrchestrationPack[] = [transcriptOrchestrationPack];
