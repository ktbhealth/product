import * as Context from "effect/Context";
import type { JsonObject } from "effect/Schema";

import {
	collectKindContributions,
	GENERIC_CONTRIBUTION_SLOT,
	type ContributionKindDescriptor,
	type Plugin,
	type PluginContribution,
} from "@ktb/kernel";
import {
	assertCondition,
	COLLECTION_NAME_RE,
	HOOK_ID_RE,
	isFieldPath,
	isRecord,
	PERMISSION_RE,
	SLUG_PATTERN,
	type Condition,
} from "@ktb/dsl";

/**
 * Flow definitions as DATA — the `flow.def` contribution kind.
 *
 * A plugin contributes a declarative document lifecycle by putting a
 * `flowDefContribution(def)` entry in its manifest's generic
 * `contributions` array; the payload is plain JSON
 * (`PluginContribution.meta` is `JsonObject`), so no kernel changes
 * are needed. `@ktb/flows` owns the kind descriptor, the def
 * validator, the collected `FlowDefinitions` registry (app-host
 * composition, same injection pattern as `DocumentCollections`/
 * `ViewDefinitions`/`ApiExposures`/`TriggerDefinitions`) and the
 * runtime that resolves legal transitions and writes them through
 * DocumentStore.
 *
 * Grammar: a flow governs ONE document-store collection. The current
 * state lives ON THE DOCUMENT at `stateField` (a dotted path into the
 * record's `data` — see ./interpreter.ts for read/write semantics).
 * Each state may declare `on: { <event>: transition }`; a transition
 * names a `target` state, an optional wizards-style `guard` condition
 * (evaluated over `{ record, event, flow }` — `record.*` paths read
 * the document's data, `event.*` paths read the transition payload)
 * and ordered `actions`. Flows govern LEGAL TRANSITIONS only — they
 * never fire on their own; callers (server fns, hooks, other plugins)
 * invoke `Flows.transition` explicitly. This is the complement of
 * `trigger.def`: triggers react to ANY write after the fact, flows
 * decide which writes are legal before they happen.
 */

/** The registered contribution kind for flow definitions. */
export const FLOW_DEF_KIND: ContributionKindDescriptor = {
	id: "flow.def",
	slot: GENERIC_CONTRIBUTION_SLOT,
	// app-host.server: the Flows service resolves defs through
	// FlowDefinitions. plugin-manager: defs are JSON data tooling may
	// enumerate via ctx.plugins.
	consumers: ["app-host.server", "plugin-manager"],
	ordering: "topo",
};

/** Flow ids are diagnostic keys (logs, hook handles, wire payloads) —
 * slug-safe. */
export const FLOW_ID_PATTERN = SLUG_PATTERN;

/** State names double as stateField values stored on documents —
 * identifier-ish, kebab allowed ("under-review"). */
export const FLOW_STATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Event names are caller-chosen labels ("submit", "approve",
 * "doc.published") — dotted segments allowed, length-capped. Same
 * grammar as hook ids (@ktb/dsl `HOOK_ID_RE`). */
export const FLOW_EVENT_PATTERN = HOOK_ID_RE;

/** A template string: `"$<scope>.<dot.path>"` resolves against the
 * transition scope (`record`, `event`, `flow` — see ./interpreter.ts);
 * every other string passes through literally. Kept as a plain string
 * alias so defs stay JSON-serializable. */
export type FlowTemplate = string;

/** Write a field on the governed document. `field` is a dotted path
 * into `data` (same grammar as `stateField`); `value` is a template
 * resolved against the transition scope at apply time. All
 * set-field writes plus the stateField write fold into ONE
 * DocumentStore update — see ./service.ts for the atomicity contract. */
export interface SetFieldAction {
	readonly kind: "set-field";
	readonly field: string;
	readonly value: FlowTemplate;
}

/** Invoke a handler registered on the `FlowsHooks` service — the
 * escape hatch for transitions that need domain logic (notifications,
 * audit entries, cross-collection orchestration, …). Runs AFTER the
 * state write commits; failures are logged, never fatal (see
 * ./service.ts). */
export interface HookAction {
	readonly kind: "hook";
	readonly hook: string;
}

export type FlowAction = SetFieldAction | HookAction;

/** A declarative transition: `on.<event>` inside a state. */
export interface FlowTransition {
	/** Next state name — must be a key of the def's `states`. */
	readonly target: string;
	/** Optional wizards-style condition evaluated against the scope
	 * `{ record: <doc data>, event: <payload>, flow: {id,title} }` —
	 * a non-match makes the event illegal in this state. */
	readonly guard?: Condition;
	/** Ordered actions applied on a successful transition. */
	readonly actions?: readonly FlowAction[];
}

/** One lifecycle state. `final: true` marks a terminal state — it may
 * NOT declare `on` transitions (assertFlowDef rejects them). */
export interface FlowState {
	readonly on?: Readonly<Record<string, FlowTransition>>;
	readonly final?: boolean;
}

/** A flow definition — the unit plugins contribute. */
export interface FlowDef {
	/** Unique flow id — diagnostic key in logs, hook handles and wire
	 * payloads. */
	readonly id: string;
	readonly title?: string;
	/** Document-store collection the flow governs. */
	readonly collection: string;
	/** Dotted path into the record's `data` holding the current state
	 * (e.g. `"status"` or `"review.state"`). The TOP-LEVEL segment must
	 * be a declared field of the collection (document-store rejects
	 * unknown keys on write). */
	readonly stateField: string;
	/** State assumed when `stateField` is absent/empty on the document
	 * — flows never AUTO-INITIALIZE: nothing writes `initial` for you;
	 * it only defines where a stateless document starts so the first
	 * event can fire. The transition write itself always persists
	 * `target` to `stateField`. Must be a key of `states`. */
	readonly initial: string;
	readonly states: Readonly<Record<string, FlowState>>;
	/** Optional `"resource.action"` permission required to run ANY
	 * transition — checked through the optional `Permissions` port;
	 * absent service or denied grant fails closed (see ./service.ts). */
	readonly permission?: string;
	/** Owning plugin id — stamped from the contributing plugin when the
	 * manifest omits it. */
	readonly owner?: string;
}

/** `"$scope.path"` templates must at least parse; anything else is a
 * literal string. Unresolvable paths at apply time pass the template
 * through literally (same contract as trigger templates). */
const TEMPLATE_RE = /^\$[A-Za-z]+\..+$/;

const assertAction = (value: unknown, context: string): FlowAction => {
	if (!isRecord(value)) {
		throw new Error(`${context}: flow action must be an object`);
	}
	if (value.kind === "set-field") {
		const { field, value: template } = value;
		if (!isFieldPath(field)) {
			throw new Error(`${context}: set-field action field must be a dotted field path`);
		}
		if (typeof template !== "string" || (template.startsWith("$") && !TEMPLATE_RE.test(template))) {
			throw new Error(
				`${context}: set-field action value must be a string template ("$<scope>.<path>" or literal)`,
			);
		}
		return value as unknown as SetFieldAction;
	}
	if (value.kind === "hook") {
		const { hook } = value;
		if (typeof hook !== "string" || !HOOK_ID_RE.test(hook)) {
			throw new Error(`${context}: hook action needs a valid hook id`);
		}
		return value as unknown as HookAction;
	}
	throw new Error(`${context}: flow action kind must be "set-field" or "hook"`);
};

const assertTransition = (
	value: unknown,
	context: string,
	states: Readonly<Record<string, FlowState>>,
): FlowTransition => {
	if (!isRecord(value)) {
		throw new Error(`${context}: transition must be an object`);
	}
	const { target, guard, actions } = value;
	// hasOwn, not `in`: "constructor"/"toString" satisfy the state
	// pattern but are Object.prototype members — `in` would accept a
	// target/initial that was never declared.
	if (typeof target !== "string" || !Object.hasOwn(states, target)) {
		throw new Error(
			`${context}: transition target ${JSON.stringify(target)} is not a declared state`,
		);
	}
	if (guard !== undefined) {
		assertCondition(guard, `${context} guard`);
	}
	let checkedActions: readonly FlowAction[] | undefined;
	if (actions !== undefined) {
		if (!Array.isArray(actions)) {
			throw new Error(`${context}: transition actions must be an array`);
		}
		checkedActions = actions.map((action, i) => assertAction(action, `${context} actions[${i}]`));
	}
	return {
		target,
		...(guard === undefined ? {} : { guard: guard as Condition }),
		...(checkedActions === undefined ? {} : { actions: checkedActions }),
	};
};

/**
 * Validate an untyped manifest payload as a {@link FlowDef}. Throws
 * with a caller-supplied context string — same packaging-bug contract
 * as `assertTriggerDef`/`assertViewDef`.
 *
 * Rules enforced beyond shape:
 * - `initial` and every transition `target` must name a declared state.
 * - `final` states may not declare `on` transitions (terminal means
 *   terminal — reopen by transitioning INTO a non-final state first).
 * - `stateField`/`set-field.field` must be dotted field paths free of
 *   prototype-polluting segments; `set-field.value` must be a string
 *   template; `collection`/`permission`/`id` match their grammars.
 */
export const assertFlowDef = (value: unknown, context: string): FlowDef => {
	if (!isRecord(value)) {
		throw new Error(`${context}: flow definition must be an object`);
	}
	const { id, title, collection, stateField, initial, states, permission, owner } = value;
	if (typeof id !== "string" || !FLOW_ID_PATTERN.test(id)) {
		throw new Error(`${context}: flow id must match ${FLOW_ID_PATTERN}`);
	}
	if (title !== undefined && typeof title !== "string") {
		throw new Error(`${context}: flow "${id}" title must be a string`);
	}
	if (typeof collection !== "string" || !COLLECTION_NAME_RE.test(collection)) {
		throw new Error(`${context}: flow "${id}" collection is not a valid collection name`);
	}
	if (!isFieldPath(stateField)) {
		throw new Error(`${context}: flow "${id}" stateField must be a dotted field path`);
	}
	if (permission !== undefined) {
		if (typeof permission !== "string" || !PERMISSION_RE.test(permission)) {
			throw new Error(
				`${context}: flow "${id}" permission must use the "resource.action" spelling`,
			);
		}
	}
	if (owner !== undefined && typeof owner !== "string") {
		throw new Error(`${context}: flow "${id}" owner must be a string`);
	}
	if (!isRecord(states) || Object.keys(states).length === 0) {
		throw new Error(`${context}: flow "${id}" states must be a non-empty object`);
	}
	for (const name of Object.keys(states)) {
		if (!FLOW_STATE_PATTERN.test(name)) {
			throw new Error(
				`${context}: flow "${id}" state name ${JSON.stringify(name)} must match ${FLOW_STATE_PATTERN}`,
			);
		}
	}
	if (typeof initial !== "string" || !Object.hasOwn(states, initial)) {
		throw new Error(`${context}: flow "${id}" initial must name a declared state`);
	}
	const checkedStates: Record<string, FlowState> = {};
	for (const [name, raw] of Object.entries(states)) {
		const at = `${context} flow "${id}" state "${name}"`;
		if (!isRecord(raw)) {
			throw new Error(`${at} must be an object`);
		}
		const { on, final } = raw;
		if (final !== undefined && typeof final !== "boolean") {
			throw new Error(`${at}.final must be a boolean`);
		}
		let checkedOn: Record<string, FlowTransition> | undefined;
		if (on !== undefined) {
			if (final === true) {
				throw new Error(`${at} is final and may not declare "on" transitions`);
			}
			if (!isRecord(on)) {
				throw new Error(`${at}.on must be an object`);
			}
			checkedOn = {};
			for (const [event, transition] of Object.entries(on)) {
				if (!FLOW_EVENT_PATTERN.test(event)) {
					throw new Error(
						`${at}.on event name ${JSON.stringify(event)} must match ${FLOW_EVENT_PATTERN}`,
					);
				}
				checkedOn[event] = assertTransition(
					transition,
					`${at}.on.${event}`,
					states as Readonly<Record<string, FlowState>>,
				);
			}
		}
		checkedStates[name] = {
			...(checkedOn === undefined ? {} : { on: checkedOn }),
			...(final === undefined ? {} : { final }),
		};
	}
	return {
		id,
		...(title === undefined ? {} : { title }),
		collection,
		stateField,
		initial,
		states: checkedStates,
		...(permission === undefined ? {} : { permission }),
		...(owner === undefined ? {} : { owner }),
	};
};

/**
 * Declare a flow. Everything is data — the result is
 * JSON-serializable by construction so it can be dropped into
 * `PluginContribution.meta` unchanged.
 */
export const defineFlow = (def: FlowDef): FlowDef =>
	assertFlowDef(def, `flow "${String((def as { id?: unknown }).id)}"`);

/**
 * Build the manifest entry a plugin adds to `contributions`:
 *
 * ```ts
 * contributions: [flowDefContribution(myFlow)]
 * ```
 *
 * `meta` carries the whole definition (JSON data); `id` is the flow id.
 */
export const flowDefContribution = (def: FlowDef): PluginContribution => ({
	kind: FLOW_DEF_KIND.id,
	id: def.id,
	version: "1",
	meta: def as unknown as JsonObject,
});

/** Narrow a collected `PluginContribution` back to a definition.
 * Throws on malformed entries — same packaging-bug contract as
 * {@link assertFlowDef}. `owner` falls back to the contributing
 * plugin id. */
export const toFlowDefinition = (entry: PluginContribution, pluginId: string): FlowDef => {
	const def = assertFlowDef(entry.meta, `plugin "${pluginId}" contribution "${entry.id}"`);
	return def.owner === undefined ? { ...def, owner: pluginId } : def;
};

/**
 * Collect every `flow.def` contribution across `plugins` (expected
 * in topo order — pass the output of `orderPlugins`/`ctx.plugins`).
 * Duplicate flow ids are a packaging bug — this throws rather than
 * letting the first contribution silently shadow the rest.
 */
export const collectFlowDefinitions = (plugins: readonly Plugin[]): readonly FlowDef[] => {
	const collected = collectKindContributions(plugins, FLOW_DEF_KIND).map(({ plugin, payload }) =>
		toFlowDefinition(payload as PluginContribution, plugin.id),
	);
	const seen = new Set<string>();
	for (const def of collected) {
		if (seen.has(def.id)) {
			throw new Error(`duplicate flow id "${def.id}" contributed by multiple plugins`);
		}
		seen.add(def.id);
	}
	return collected;
};

/**
 * Owner→enablement index built from the plugin registry at composition
 * time. Enablement itself is RUNTIME state (`PluginStates`, DB-backed)
 * — defs stay static composition data and the Flows service re-checks
 * `def.owner` against `PluginStates.enabledIds()` on every call, so a
 * /platform/plugins toggle takes effect without a layer rebuild (same
 * contract as the CQRS dispatch gate in @ktb/app-host).
 */
export interface DefOwnerIndex {
	/** plugin id → `pkg` stamp (`undefined` when the plugin carries none). */
	readonly pkgById: ReadonlyMap<string, string | undefined>;
	/** pkg → member plugin ids — packageLive needs the whole member set. */
	readonly membersByPkg: ReadonlyMap<string, readonly string[]>;
}

/** Build the index `makeFlowDefinitions` attaches to the registry. */
export const buildDefOwnerIndex = (plugins: readonly Plugin[]): DefOwnerIndex => {
	const pkgById = new Map<string, string | undefined>();
	const membersByPkg = new Map<string, string[]>();
	for (const plugin of plugins) {
		pkgById.set(plugin.id, plugin.pkg);
		if (plugin.pkg !== undefined) {
			const members = membersByPkg.get(plugin.pkg) ?? [];
			members.push(plugin.id);
			membersByPkg.set(plugin.pkg, members);
		}
	}
	return { pkgById, membersByPkg };
};

/**
 * Package-granular enablement for a def `owner` — mirrors
 * `entryEnabled`/`packageLive` (@ktb/kernel): a pkg-stamped owner is
 * live while ANY package member id is enabled; an unstamped or
 * unindexed owner falls back to the per-id check. `owner`/`index`
 * absent → `true`: unattributed defs (hand-built registries) cannot be
 * gated and stay live.
 */
export const defOwnerEnabled = (
	index: DefOwnerIndex | undefined,
	owner: string | undefined,
	enabled: ReadonlySet<string>,
): boolean => {
	if (owner === undefined) return true;
	if (index === undefined || !index.pkgById.has(owner)) return enabled.has(owner);
	const pkg = index.pkgById.get(owner);
	if (pkg === undefined) return enabled.has(owner);
	return (index.membersByPkg.get(pkg) ?? [owner]).some((id) => enabled.has(id));
};

/**
 * The ordered flow registry the composition root provides to the
 * `Flows` service — the layer @ktb/app-host merges into `core` next
 * to `makePluginStatesLive(plugins)`/`makeDocumentCollections(plugins)`/
 * `makeViewDefinitions(plugins)`/`makeApiExposures(plugins)`/
 * `makeTriggerDefinitions(plugins)`.
 *
 * `ownerIndex` is optional so hand-built registries (tests, tooling)
 * keep working; `makeFlowDefinitions` always populates it.
 */
export class FlowDefinitions extends Context.Service<
	FlowDefinitions,
	{
		readonly flows: readonly FlowDef[];
		readonly ownerIndex?: DefOwnerIndex;
	}
>()("@ktb/flows/FlowDefinitions") {}

/** Build the `FlowDefinitions` service value for a plugin graph. */
export const makeFlowDefinitions = (
	plugins: readonly Plugin[],
): { readonly flows: readonly FlowDef[]; readonly ownerIndex: DefOwnerIndex } => ({
	flows: collectFlowDefinitions(plugins),
	ownerIndex: buildDefOwnerIndex(plugins),
});
