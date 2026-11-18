import { Schema } from "effect";

import type { PluginConfigSchema } from "@ktb/kernel";

/**
 * Config contract for `audit.services` (P-087 D5) — runtime knobs for
 * the Audit write path, editable from /platform/plugins.
 *
 * NOTE the `.tsx` extension: `src/client.ts` may only value-import
 * relative `.tsx` modules (arch/client-contract), so the shared
 * isomorphic manifest data lives here even though it contains no JSX —
 * same convention as plugins/manager/src/config.tsx.
 *
 * `auditConfigSchema` is the effect/Schema SOURCE OF TRUTH: the server
 * manifest (`./index.ts`) exposes it as `configSchema` so PluginStates
 * can decode incoming/stored JSON against it at runtime.
 * `auditConfig` is its serializable projection — the JSON Schema
 * document (draft 2020-12) stored on `meta.config` — shared verbatim by
 * BOTH manifests so the client registry renders the generated form
 * without pulling the Schema (or any server-only dep) into the bundle.
 * Keep the two in sync by construction: never hand-edit the document,
 * change the Schema and re-derive.
 *
 * Semantics (resolved per `Audit.record` call — edits apply without a
 * restart; PluginStates is read through `serviceOption` so tests and
 * non-app contexts fall back to these defaults):
 * - `enabled` — global kill switch: false stops ALL recording.
 * - `readsEnabled` — false stops only `*.read` events (the D2/D3
 *   sensitive-read volume); mutation events are unaffected.
 * - `readCoalesceMs` — D3 window: a `.read` action is skipped when an
 *   identical (actor, action, target) row exists within this many ms.
 *   0 disables coalescing (every read records).
 */
export const auditConfigSchema = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean).annotate({
		title: "Audit recording enabled",
		description: "Global kill switch — false stops all audit writes.",
		default: true,
	}),
	readsEnabled: Schema.optionalKey(Schema.Boolean).annotate({
		title: "Record read events",
		description: "False disables *.read audit events only; mutations still record.",
		default: true,
	}),
	readCoalesceMs: Schema.optionalKey(Schema.Int).annotate({
		title: "Read coalescing window (ms)",
		description:
			"Skip a .read event when an identical one was recorded within this window. 0 disables.",
		default: 60000,
	}),
});

export const auditConfig: PluginConfigSchema = {
	schema: Schema.toJsonSchemaDocument(auditConfigSchema),
};
