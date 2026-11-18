import type { JsonObject } from "effect/Schema";

import type { DatasetManifest } from "@ktb/eval-core";

import type { EvalInstance, EvalInstanceItem } from "./schema.ts";

/**
 * Dataset-manifest projection (WS-D / PL-009): maps a finished
 * generation instance onto the eval-core `DatasetManifest` artifact —
 * the same shape `eval generate` writes for CLI cohorts, so platform
 * runs and CLI runs share one registry vocabulary.
 *
 * Pure module: no Effect, no db, no platform APIs — the caller
 * (EvalInstances.tick finalize) owns persistence. The hash helper is
 * a local FNV-1a: plugins may not import node:crypto (arch lint) and
 * crypto.subtle is async, while manifest derivation must stay sync.
 */

/** FNV-1a 32-bit → 8 lowercase hex chars. Deterministic across
 * runtimes (unlike Math.random/seeded PRNGs) and stable for a given
 * input string — the content pin the manifest promises. */
const fnv1a = (input: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
};

const parseJson = <T>(s: string | null, fallback: T): T => {
	/* v8 ignore next -- eval_instance.params is NOT NULL; null is defensive only */
	if (s === null) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

/** Project one generation instance + its item rows onto a
 * DatasetManifest. `sampleCount`/`version` count only GENERATED items
 * (`status='done'`) — pending/error slots aren't corpus. The
 * `contentHash` pins the actual cohort: sorted `itemId:script` pairs,
 * so re-running generation over the same items reproduces the hash
 * while any script edit breaks it. `version` derives from that hash —
 * same content, same version; new content, new version. */
export const instanceToDatasetManifest = (
	instance: EvalInstance,
	items: readonly EvalInstanceItem[],
): DatasetManifest => {
	const doneCount = items.filter((i) => i.status === "done").length;
	const contentHash = fnv1a(
		[...items]
			.sort((a, b) => a.id - b.id)
			.map((i) => `${i.id}:${i.script ?? ""}`)
			.join("\n"),
	);
	return {
		id: `eval-instance-${instance.id}`,
		version: `v${doneCount}-${contentHash}`,
		domain: "eval.consultation",
		generator: {
			mode: instance.mode,
			params: parseJson<JsonObject>(instance.params, {}),
			endpointId: instance.endpointId,
		},
		provenance: { createdBy: instance.createdBy },
		createdAt: instance.createdAt.getTime(),
		sampleCount: doneCount,
		contentHash,
	};
};
