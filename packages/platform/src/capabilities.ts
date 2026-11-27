import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { Plugin, PluginContribution } from "@ktb/kernel";
import { GENERIC_CONTRIBUTION_SLOT, type ContributionKindDescriptor } from "@ktb/kernel";

/**
 * Work-orchestration capability declarations (P-094): the generic
 * `contributions` channel kinds a plugin uses to declare WHAT the
 * runtime may trigger — never how it executes. Handlers stay
 * imperative (the composition-built job-handler registry in
 * @ktb/jobs-port, wired by the composition root's edge modules);
 * these entries are serializable metadata the composition root
 * collects once and exposes through `ServerRuntime`:
 *
 * - `jobs.kind` — advisory metadata for a registered job kind
 *   (description, concurrency/attempt hints for consoles). The live
 *   registry registration stays authoritative for execution.
 * - `jobs.schedulable` — opts a job kind into runtime scheduling:
 *   the /platform/cron picker lists it, `paramsSchema` (a JSON Schema
 *   document) validates schedule params at create time, and
 *   `suggestedCronExpr`/`suggestedParams` prefill the form.
 * - `events.topic` — declares a pub/sub topic the plugin publishes or
 *   subscribes to, with an optional payload schema. The pub/sub
 *   console lists declarations alongside live transport topics —
 *   declared ≠ live, the console renders them as catalog entries.
 *
 * Same contract as `route` contributions (./routes.ts): entries are
 * data, `meta` decodes through an effect Schema, invalid entries fail
 * composition loudly, and consumers opt in per kind.
 */

// ---------------------------------------------------------------------------
// Kind ids + descriptors
// ---------------------------------------------------------------------------

/** Kind id for job-kind metadata declarations. */
export const JOB_KIND = "jobs.kind" satisfies string;

export const JOB_KIND_DESCRIPTOR: ContributionKindDescriptor = {
	id: JOB_KIND,
	slot: GENERIC_CONTRIBUTION_SLOT,
	consumers: ["app-host.server", "plugin-manager"],
	ordering: "topo",
};

/** Kind id for schedulable-job declarations. */
export const SCHEDULABLE_KIND = "jobs.schedulable" satisfies string;

export const SCHEDULABLE_DESCRIPTOR: ContributionKindDescriptor = {
	id: SCHEDULABLE_KIND,
	slot: GENERIC_CONTRIBUTION_SLOT,
	consumers: ["app-host.server", "plugin-manager"],
	ordering: "topo",
};

/** Kind id for pub/sub topic declarations. */
export const EVENT_TOPIC_KIND = "events.topic" satisfies string;

export const EVENT_TOPIC_DESCRIPTOR: ContributionKindDescriptor = {
	id: EVENT_TOPIC_KIND,
	slot: GENERIC_CONTRIBUTION_SLOT,
	consumers: ["app-host.server", "plugin-manager"],
	ordering: "topo",
};

/** All three capability kinds, for consumers that collect together. */
export const CAPABILITY_CONTRIBUTION_KINDS: readonly ContributionKindDescriptor[] = [
	JOB_KIND_DESCRIPTOR,
	SCHEDULABLE_DESCRIPTOR,
	EVENT_TOPIC_DESCRIPTOR,
];

// ---------------------------------------------------------------------------
// Meta schemas (the serializable contract on PluginContribution.meta)
// ---------------------------------------------------------------------------

/** `jobs.kind` meta — advisory only; the registry registration is
 * authoritative for concurrency/attempts at execution time. */
export const JobKindMeta = Schema.Struct({
	description: Schema.optionalKey(Schema.String),
	concurrency: Schema.optionalKey(Schema.Int),
	maxAttempts: Schema.optionalKey(Schema.Int),
	idempotent: Schema.optionalKey(Schema.Boolean),
});
export type JobKindMeta = Schema.Schema.Type<typeof JobKindMeta>;

/** `jobs.schedulable` meta — `kind` is the job kind to schedule (must
 * resolve to a dispatchable handler at runtime); `paramsSchema` is a
 * JSON Schema document (@ktb/json-schema profile) validated against
 * schedule params on create. `suggestedParams` must satisfy it. */
export const SchedulableMeta = Schema.Struct({
	kind: Schema.String,
	description: Schema.optionalKey(Schema.String),
	paramsSchema: Schema.optionalKey(Schema.Json),
	suggestedCronExpr: Schema.optionalKey(Schema.String),
	suggestedParams: Schema.optionalKey(Schema.Json),
});
export type SchedulableMeta = Schema.Schema.Type<typeof SchedulableMeta>;

/** `events.topic` meta — `payloadSchema` is a JSON Schema document for
 * the payload shape; documentation/validation hint for publishers. */
export const EventTopicMeta = Schema.Struct({
	description: Schema.optionalKey(Schema.String),
	payloadSchema: Schema.optionalKey(Schema.Json),
});
export type EventTopicMeta = Schema.Schema.Type<typeof EventTopicMeta>;

// ---------------------------------------------------------------------------
// Contribution builders (plugin-manifest side)
// ---------------------------------------------------------------------------

/** Declare metadata for a job kind — `kind` is both the entry id and
 * the registry key it describes. */
export const jobKindContribution = (kind: string, meta: JobKindMeta = {}): PluginContribution => ({
	kind: JOB_KIND,
	id: kind,
	meta: { ...meta },
});

/** Declare a schedulable job — `id` is a stable declaration slug
 * (e.g. "eval.nightly"), `meta.kind` the dispatchable job kind. */
export const schedulableContribution = (id: string, meta: SchedulableMeta): PluginContribution => ({
	kind: SCHEDULABLE_KIND,
	id,
	meta: { ...meta },
});

/** Declare a pub/sub topic — `topic` is both the entry id and the
 * transport-level topic name subscribers publish to. */
export const eventTopicContribution = (
	topic: string,
	meta: EventTopicMeta = {},
): PluginContribution => ({ kind: EVENT_TOPIC_KIND, id: topic, meta: { ...meta } });

// ---------------------------------------------------------------------------
// Decoded declarations (consumer side)
// ---------------------------------------------------------------------------

export interface JobKindDeclaration {
	readonly kind: string;
	readonly pluginId: string;
	readonly description?: string;
	readonly concurrency?: number;
	readonly maxAttempts?: number;
	readonly idempotent?: boolean;
}

export interface SchedulableDeclaration {
	/** Stable declaration slug (the contribution entry id). */
	readonly id: string;
	readonly pluginId: string;
	/** The dispatchable job kind this entry schedules. */
	readonly kind: string;
	readonly description?: string;
	/** JSON Schema document for schedule params, when declared. */
	readonly paramsSchema?: unknown;
	readonly suggestedCronExpr?: string;
	readonly suggestedParams?: unknown;
}

export interface EventTopicDeclaration {
	readonly topic: string;
	readonly pluginId: string;
	readonly description?: string;
	/** JSON Schema document for the payload shape, when declared. */
	readonly payloadSchema?: unknown;
}

const decodeMeta = <A>(
	schema: Schema.ConstraintDecoder<A>,
	plugin: Plugin,
	entry: PluginContribution,
): A => {
	const decoded = Schema.decodeUnknownResult(schema)(entry.meta ?? {});
	if (Result.isFailure(decoded)) {
		throw new Error(
			`invalid "${entry.kind}" contribution "${entry.id}" on plugin "${plugin.id}": ${String(decoded.failure)}`,
		);
	}
	return decoded.success;
};

/** Collect `jobs.kind` declarations across the (topo-ordered) plugin
 * registry. Duplicate kind ids throw — a kind has exactly one owning
 * declaration. */
export const collectJobKindDeclarations = (
	plugins: readonly Plugin[],
): readonly JobKindDeclaration[] => {
	const out: JobKindDeclaration[] = [];
	const seen = new Set<string>();
	for (const plugin of plugins) {
		for (const entry of plugin.contributions ?? []) {
			if (entry.kind !== JOB_KIND) continue;
			if (seen.has(entry.id)) {
				throw new Error(`duplicate "${JOB_KIND}" contribution "${entry.id}"`);
			}
			seen.add(entry.id);
			const meta = decodeMeta(JobKindMeta, plugin, entry);
			out.push({
				kind: entry.id,
				pluginId: plugin.id,
				...(meta.description === undefined ? {} : { description: meta.description }),
				...(meta.concurrency === undefined ? {} : { concurrency: meta.concurrency }),
				...(meta.maxAttempts === undefined ? {} : { maxAttempts: meta.maxAttempts }),
				...(meta.idempotent === undefined ? {} : { idempotent: meta.idempotent }),
			});
		}
	}
	return out;
};

/** Collect `jobs.schedulable` declarations. Multiple entries may
 * target the same job `kind` (different param presets); entry ids must
 * still be unique — enforced by the seen-set on the slug. */
export const collectSchedulableDeclarations = (
	plugins: readonly Plugin[],
): readonly SchedulableDeclaration[] => {
	const out: SchedulableDeclaration[] = [];
	const seen = new Set<string>();
	for (const plugin of plugins) {
		for (const entry of plugin.contributions ?? []) {
			if (entry.kind !== SCHEDULABLE_KIND) continue;
			if (seen.has(entry.id)) {
				throw new Error(`duplicate "${SCHEDULABLE_KIND}" contribution "${entry.id}"`);
			}
			seen.add(entry.id);
			const meta = decodeMeta(SchedulableMeta, plugin, entry);
			out.push({
				id: entry.id,
				pluginId: plugin.id,
				kind: meta.kind,
				...(meta.description === undefined ? {} : { description: meta.description }),
				...(meta.paramsSchema === undefined ? {} : { paramsSchema: meta.paramsSchema }),
				...(meta.suggestedCronExpr === undefined
					? {}
					: { suggestedCronExpr: meta.suggestedCronExpr }),
				...(meta.suggestedParams === undefined ? {} : { suggestedParams: meta.suggestedParams }),
			});
		}
	}
	return out;
};

/** Collect `events.topic` declarations. Duplicate topic names throw —
 * a topic has exactly one declaring plugin. */
export const collectEventTopicDeclarations = (
	plugins: readonly Plugin[],
): readonly EventTopicDeclaration[] => {
	const out: EventTopicDeclaration[] = [];
	const seen = new Set<string>();
	for (const plugin of plugins) {
		for (const entry of plugin.contributions ?? []) {
			if (entry.kind !== EVENT_TOPIC_KIND) continue;
			if (seen.has(entry.id)) {
				throw new Error(`duplicate "${EVENT_TOPIC_KIND}" contribution "${entry.id}"`);
			}
			seen.add(entry.id);
			const meta = decodeMeta(EventTopicMeta, plugin, entry);
			out.push({
				topic: entry.id,
				pluginId: plugin.id,
				...(meta.description === undefined ? {} : { description: meta.description }),
				...(meta.payloadSchema === undefined ? {} : { payloadSchema: meta.payloadSchema }),
			});
		}
	}
	return out;
};
