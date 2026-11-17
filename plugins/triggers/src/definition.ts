import * as Context from "effect/Context";
import type { JsonObject } from "effect/Schema";

import {
	collectKindContributions,
	GENERIC_CONTRIBUTION_SLOT,
	type ContributionKindDescriptor,
	type Plugin,
	type PluginContribution,
} from "@ktb/kernel";
import { assertCondition, type WizardCondition } from "@ktb/wizards/condition";

/**
 * Trigger definitions as DATA — the `trigger.def` contribution kind.
 *
 * A plugin contributes a declarative reaction by putting a
 * `triggerDefContribution(def)` entry in its manifest's generic
 * `contributions` array; the payload is plain JSON
 * (`PluginContribution.meta` is `JsonObject`), so no kernel changes
 * are needed. `@ktb/triggers` owns the kind descriptor, the def
 * validator, the collected `TriggerDefinitions` registry (app-host
 * composition, same injection pattern as `DocumentCollections`/
 * `ViewDefinitions`/`ApiExposures`) and the runtime that subscribes to
 * document-store write events on the app-wide `EventBus`.
 *
 * Grammar: WHEN a `document-store.record-written` event matches
 * (collection + ops + optional `when` condition over the written
 * doc's `data`) DO `action` — either a `collection-write` back into
 * the store (templated field mapping) or a `hook` resolved through
 * the `TriggersHooks` registry (./hooks.ts).
 */

/** The registered contribution kind for trigger definitions. */
export const TRIGGER_DEF_KIND: ContributionKindDescriptor = {
	id: "trigger.def",
	slot: GENERIC_CONTRIBUTION_SLOT,
	// app-host.server: the Triggers service resolves defs through
	// TriggerDefinitions. plugin-manager: defs are JSON data tooling may
	// enumerate via ctx.plugins.
	consumers: ["app-host.server", "plugin-manager"],
	ordering: "topo",
};

/** Trigger ids are diagnostic keys (logs, hook handles) — slug-safe. */
export const TRIGGER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Same shape document-store collection names use (mirrored — the
 * constant is private to that package). */
const COLLECTION_NAME_RE = /^[a-z][a-z0-9._-]{0,99}$/;

/** Write ops a trigger can match — mirrors DOCUMENT_WRITE_OPS. */
export const TRIGGER_OPS = ["insert", "update", "remove"] as const;
export type TriggerOp = (typeof TRIGGER_OPS)[number];

/**
 * A template string: `"$<scope>.<dot.path>"` resolves against the
 * write scope (`record`, `trigger` — see ./runner.ts); every other
 * string passes through literally. Kept as a plain string alias so
 * defs stay JSON-serializable.
 */
export type TriggerTemplate = string;

/** Write back into a document-store collection. `mapping` templates
 * resolve against the write scope and become the record `data`.
 * `mode: "update"` additionally needs `id` — a template resolving to
 * the target record id (typically `"$record.id"`). */
export interface CollectionWriteAction {
	readonly kind: "collection-write";
	readonly collection: string;
	readonly mapping: Readonly<Record<string, TriggerTemplate>>;
	readonly mode: "insert" | "update";
	/** Target record id template — REQUIRED when `mode` is `"update"`. */
	readonly id?: TriggerTemplate;
}

/** Invoke a handler registered on the `TriggersHooks` service — the
 * escape hatch for reactions that need domain logic (notifications,
 * cross-collection orchestration, …). */
export interface HookAction {
	readonly kind: "hook";
	readonly hook: string;
}

export type TriggerAction = CollectionWriteAction | HookAction;

/** A trigger definition — the unit plugins contribute. */
export interface TriggerDef {
	/** Unique trigger id — diagnostic key in logs and hook handles. */
	readonly id: string;
	readonly title?: string;
	/** Source collection: the `document-store.record-written` events
	 * this trigger watches. */
	readonly collection: string;
	/** Ops to match — defaults to all three when omitted. */
	readonly ops?: readonly TriggerOp[];
	/** Optional wizards-style condition evaluated against the written
	 * record's `data` payload — a non-match skips the action. */
	readonly when?: WizardCondition;
	readonly action: TriggerAction;
	/** Owning plugin id — stamped from the contributing plugin when the
	 * manifest omits it. */
	readonly owner?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const HOOK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const assertAction = (value: unknown, context: string): TriggerAction => {
	if (!isRecord(value)) {
		throw new Error(`${context}: trigger action must be an object`);
	}
	if (value.kind === "collection-write") {
		const { collection, mapping, mode, id } = value;
		if (typeof collection !== "string" || !COLLECTION_NAME_RE.test(collection)) {
			throw new Error(`${context}: collection-write action collection is not a valid name`);
		}
		if (!isRecord(mapping)) {
			throw new Error(`${context}: collection-write mapping must be an object`);
		}
		for (const [key, template] of Object.entries(mapping)) {
			if (typeof template !== "string") {
				throw new Error(`${context}: collection-write mapping "${key}" must be a template string`);
			}
		}
		if (mode !== "insert" && mode !== "update") {
			throw new Error(`${context}: collection-write mode must be "insert" or "update"`);
		}
		if (id !== undefined && typeof id !== "string") {
			throw new Error(`${context}: collection-write id must be a template string`);
		}
		if (mode === "update" && typeof id !== "string") {
			throw new Error(`${context}: collection-write "update" mode needs an id template`);
		}
		return value as unknown as CollectionWriteAction;
	}
	if (value.kind === "hook") {
		const { hook } = value;
		if (typeof hook !== "string" || !HOOK_ID_RE.test(hook)) {
			throw new Error(`${context}: hook action needs a valid hook id`);
		}
		return value as unknown as HookAction;
	}
	throw new Error(`${context}: trigger action kind must be "collection-write" or "hook"`);
};

/**
 * Validate an untyped manifest payload as a {@link TriggerDef}.
 * Throws with a caller-supplied context string — same packaging-bug
 * contract as `assertViewDef`/`assertCollectionDef`.
 */
export const assertTriggerDef = (value: unknown, context: string): TriggerDef => {
	if (!isRecord(value)) {
		throw new Error(`${context}: trigger definition must be an object`);
	}
	const { id, title, collection, ops, when, action, owner } = value;
	if (typeof id !== "string" || !TRIGGER_ID_PATTERN.test(id)) {
		throw new Error(`${context}: trigger id must match ${TRIGGER_ID_PATTERN}`);
	}
	if (title !== undefined && typeof title !== "string") {
		throw new Error(`${context}: trigger "${id}" title must be a string`);
	}
	if (typeof collection !== "string" || !COLLECTION_NAME_RE.test(collection)) {
		throw new Error(`${context}: trigger "${id}" collection is not a valid collection name`);
	}
	let checkedOps: readonly TriggerOp[] | undefined;
	if (ops !== undefined) {
		if (!Array.isArray(ops) || ops.length === 0) {
			throw new Error(`${context}: trigger "${id}" ops must be a non-empty array`);
		}
		const seen = new Set<TriggerOp>();
		for (const op of ops) {
			if (typeof op !== "string" || !TRIGGER_OPS.includes(op as TriggerOp)) {
				throw new Error(
					`${context}: trigger "${id}" op ${JSON.stringify(op)} is not one of ${TRIGGER_OPS.join(", ")}`,
				);
			}
			seen.add(op as TriggerOp);
		}
		checkedOps = [...seen];
	}
	if (when !== undefined) {
		assertCondition(when, `${context} trigger "${id}" when`);
	}
	if (owner !== undefined && typeof owner !== "string") {
		throw new Error(`${context}: trigger "${id}" owner must be a string`);
	}
	const checked: TriggerDef = {
		id,
		...(title === undefined ? {} : { title }),
		collection,
		...(checkedOps === undefined ? {} : { ops: checkedOps }),
		...(when === undefined ? {} : { when: when as WizardCondition }),
		action: assertAction(action, `${context} trigger "${id}"`),
		...(owner === undefined ? {} : { owner }),
	};
	return checked;
};

/**
 * Declare a trigger. Everything is data — the result is
 * JSON-serializable by construction so it can be dropped into
 * `PluginContribution.meta` unchanged.
 */
export const defineTrigger = (def: TriggerDef): TriggerDef =>
	assertTriggerDef(def, `trigger "${String((def as { id?: unknown }).id)}"`);

/**
 * Build the manifest entry a plugin adds to `contributions`:
 *
 * ```ts
 * contributions: [triggerDefContribution(myTrigger)]
 * ```
 *
 * `meta` carries the whole definition (JSON data); `id` is the trigger id.
 */
export const triggerDefContribution = (def: TriggerDef): PluginContribution => ({
	kind: TRIGGER_DEF_KIND.id,
	id: def.id,
	version: "1",
	meta: def as unknown as JsonObject,
});

/** Narrow a collected `PluginContribution` back to a definition.
 * Throws on malformed entries — same packaging-bug contract as
 * {@link assertTriggerDef}. `owner` falls back to the contributing
 * plugin id. */
export const toTriggerDefinition = (entry: PluginContribution, pluginId: string): TriggerDef => {
	const def = assertTriggerDef(entry.meta, `plugin "${pluginId}" contribution "${entry.id}"`);
	return def.owner === undefined ? { ...def, owner: pluginId } : def;
};

/**
 * Collect every `trigger.def` contribution across `plugins` (expected
 * in topo order — pass the output of `orderPlugins`/`ctx.plugins`).
 * Duplicate trigger ids are a packaging bug — this throws rather than
 * letting the first contribution silently shadow the rest.
 */
export const collectTriggerDefinitions = (plugins: readonly Plugin[]): readonly TriggerDef[] => {
	const collected = collectKindContributions(plugins, TRIGGER_DEF_KIND).map(({ plugin, payload }) =>
		toTriggerDefinition(payload as PluginContribution, plugin.id),
	);
	const seen = new Set<string>();
	for (const def of collected) {
		if (seen.has(def.id)) {
			throw new Error(`duplicate trigger id "${def.id}" contributed by multiple plugins`);
		}
		seen.add(def.id);
	}
	return collected;
};

/**
 * The ordered trigger registry the composition root provides to the
 * `Triggers` service — the layer @ktb/app-host merges into `core` next
 * to `makePluginStatesLive(plugins)`/`makeDocumentCollections(plugins)`/
 * `makeViewDefinitions(plugins)`/`makeApiExposures(plugins)`.
 */
export class TriggerDefinitions extends Context.Service<
	TriggerDefinitions,
	{ readonly triggers: readonly TriggerDef[] }
>()("@ktb/triggers/TriggerDefinitions") {}

/** Build the `TriggerDefinitions` service value for a plugin graph. */
export const makeTriggerDefinitions = (
	plugins: readonly Plugin[],
): { readonly triggers: readonly TriggerDef[] } => ({
	triggers: collectTriggerDefinitions(plugins),
});
