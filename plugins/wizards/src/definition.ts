import * as Context from "effect/Context";
import type { JsonSchemaObject } from "@ktb/json-schema";
import { assertSchema } from "@ktb/json-schema";
import type { FormFieldUi } from "@ktb/forms";
import { defineDefKind, type DefOwnerIndex } from "@ktb/kernel";

import {
	assertCondition,
	COLLECTION_NAME_RE,
	FORBIDDEN_PATH_SEGMENTS,
	HOOK_ID_RE,
	isRecord,
	PERMISSION_RE,
	SLUG_PATTERN,
	type Condition,
} from "@ktb/dsl";

/**
 * Wizard definitions as DATA — the `wizard.def` contribution kind.
 *
 * A plugin contributes a runnable wizard by putting a
 * `wizardDefContribution(def)` entry in its manifest's generic
 * `contributions` array; the payload is plain JSON
 * (`PluginContribution.meta` is `JsonObject`), so no kernel changes
 * are needed. `@ktb/wizards` owns the kind descriptor, the pure step
 * interpreter (./resolve.ts), the condition evaluator (./condition.ts)
 * and the `/wizards/<id>` runner page.
 *
 * Admin-authored defs live in the `wizard_defs` table (./schema.ts) —
 * same {@link WizardDefinition} shape, stored as JSON, gated by the
 * `published` flag. The service merges both sources at read time;
 * plugins that emit `wizard.def` entries MUST mirror `contributions`
 * in their `src/client.ts` (same contract as `form.def`) because the
 * runner resolves defs from `ctx.plugins` — the enabled-filtered
 * CLIENT registry.
 *
 * Extension points: step kinds (`"form"`/`"info"`) and completion
 * kinds (`"document-store"`/`"hook"`) are CLOSED unions — new
 * behavior lands in ./resolve.ts/./completion.ts; the `hook`
 * completion id is the escape hatch for domain logic, resolved
 * through the WizardHooks registry (./hooks.ts).
 */

/** Wizard ids double as URL segments — keep them slug-safe. */
export const WIZARD_ID_PATTERN = SLUG_PATTERN;

/** Step kinds the v1 interpreter knows how to render. */
export type WizardStepKind = "form" | "info";

interface WizardStepBase {
	/** Step id — keys the submitted value in `answers` (`answers[step.id]`). */
	readonly id: string;
	readonly title?: string;
	readonly description?: string;
	/** Optional visibility condition evaluated against submitted answers
	 * — a hidden step is skipped by the interpreter (./resolve.ts). */
	readonly when?: Condition;
}

/** A step that collects input: rendered with @ktb/forms `SchemaForm`
 * against `schema` (same @ktb/json-schema subset as `form.def`). */
export interface WizardFormStep extends WizardStepBase {
	readonly kind: "form";
	readonly schema: JsonSchemaObject;
	/** Presentation hints keyed by top-level property name — forwarded
	 * to SchemaForm verbatim (see @ktb/forms FormFieldUi). */
	readonly ui?: Readonly<Record<string, FormFieldUi>>;
	readonly submitLabel?: string;
}

/** A display-only step: title/body copy plus a continue affordance —
 * no input collected. */
export interface WizardInfoStep extends WizardStepBase {
	readonly kind: "info";
	readonly body?: string;
}

export type WizardStep = WizardFormStep | WizardInfoStep;

/** What a finished run produces. `data` values are templates: a string
 * of the form `"$answers.<stepId>.<field>"` (also `"$wizard.<key>"`,
 * `"$run.<field>"`) resolves against the run context; every other
 * value passes through literally. See ./completion.ts. */
export type WizardCompletion =
	| {
			readonly kind: "document-store";
			/** Target collection name (a contributed or DB collection). */
			readonly collection: string;
			readonly data?: Readonly<Record<string, unknown>>;
	  }
	| {
			readonly kind: "hook";
			/** Id of a handler registered on the WizardHooks service. */
			readonly hook: string;
			readonly data?: Readonly<Record<string, unknown>>;
	  };

/**
 * A wizard definition — the unit plugins contribute and admins author.
 * `steps` run in declaration order; `when` conditions and the step
 * interpreter decide which are visible for a given answer set.
 * `completion` (optional) fires once when the last visible step is
 * submitted.
 */
export interface WizardDefinition {
	/** Wizard id — also the URL segment under /wizards/. Lowercase slug. */
	readonly id: string;
	/** Owning plugin id — stamped from the contributing plugin when the
	 * manifest omits it; "" for admin-authored DB defs. */
	readonly owner?: string;
	readonly title?: string;
	readonly description?: string;
	readonly steps: readonly WizardStep[];
	readonly completion?: WizardCompletion;
	/** Label for form-step submit buttons; falls back to catalogs. */
	readonly submitLabel?: string;
	/** Optional `"resource.action"` grant required to START a run —
	 * enforced by the run service through the optional `Permissions`
	 * port (a declared permission fails closed when no grant service
	 * is bound). */
	readonly permission?: string;
}

const WIDGETS = new Set([
	"input",
	"textarea",
	"select",
	"radio",
	"checkbox",
	"switch",
	"number",
	"json",
	"list",
	"object",
]);

const assertStep = (value: unknown, context: string, seen: Set<string>): void => {
	if (!isRecord(value)) {
		throw new Error(`${context}: wizard step must be an object`);
	}
	const { id, kind, title, description, when, schema, ui, submitLabel, body } = value;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`${context}: wizard step id must be a non-empty string`);
	}
	// Step ids key the `answers` object — prototype-polluting names are
	// rejected outright (same denylist as document-store field names).
	if (FORBIDDEN_PATH_SEGMENTS.has(id)) {
		throw new Error(`${context}: wizard step id ${JSON.stringify(id)} is reserved`);
	}
	if (seen.has(id)) {
		throw new Error(`${context}: duplicate wizard step id "${id}"`);
	}
	seen.add(id);
	if (kind !== "form" && kind !== "info") {
		throw new Error(`${context}: wizard step "${id}" kind must be "form" or "info"`);
	}
	if (title !== undefined && typeof title !== "string") {
		throw new Error(`${context}: wizard step "${id}" title must be a string`);
	}
	if (description !== undefined && typeof description !== "string") {
		throw new Error(`${context}: wizard step "${id}" description must be a string`);
	}
	if (body !== undefined && typeof body !== "string") {
		throw new Error(`${context}: wizard step "${id}" body must be a string`);
	}
	if (submitLabel !== undefined && typeof submitLabel !== "string") {
		throw new Error(`${context}: wizard step "${id}" submitLabel must be a string`);
	}
	if (when !== undefined) assertCondition(when, `${context} step "${id}" when`);
	if (kind === "info") return;
	// form step
	assertSchema(schema);
	if (!isRecord(schema)) {
		throw new Error(`${context}: wizard step "${id}" schema must be a schema object`);
	}
	const types = schema.type;
	const isObject = types === "object" || (Array.isArray(types) && types.includes("object"));
	if (!isObject) {
		throw new Error(
			`${context}: wizard step "${id}" schema must be object-typed (got ${JSON.stringify(types)})`,
		);
	}
	if (ui !== undefined) {
		if (!isRecord(ui)) {
			throw new Error(`${context}: wizard step "${id}" ui hints must be an object`);
		}
		for (const [key, hint] of Object.entries(ui)) {
			if (!isRecord(hint)) {
				throw new Error(`${context}: ui hint for "${key}" must be an object`);
			}
			const { widget, placeholder, options } = hint;
			if (widget !== undefined && (typeof widget !== "string" || !WIDGETS.has(widget))) {
				throw new Error(`${context}: ui widget for "${key}" is not a known widget`);
			}
			if (placeholder !== undefined && typeof placeholder !== "string") {
				throw new Error(`${context}: ui placeholder for "${key}" must be a string`);
			}
			if (options !== undefined) {
				if (!Array.isArray(options)) {
					throw new Error(`${context}: ui options for "${key}" must be an array`);
				}
				for (const option of options) {
					if (!isRecord(option) || typeof option.label !== "string" || !("value" in option)) {
						throw new Error(`${context}: ui options for "${key}" must be { value, label } entries`);
					}
				}
			}
		}
	}
};

const assertCompletion = (value: unknown, context: string): void => {
	if (!isRecord(value)) {
		throw new Error(`${context}: wizard completion must be an object`);
	}
	const { kind, collection, hook, data } = value;
	if (kind === "document-store") {
		if (typeof collection !== "string" || !COLLECTION_NAME_RE.test(collection)) {
			throw new Error(`${context}: document-store completion needs a valid collection name`);
		}
	} else if (kind === "hook") {
		if (typeof hook !== "string" || !HOOK_ID_RE.test(hook)) {
			throw new Error(`${context}: hook completion needs a valid hook id`);
		}
	} else {
		throw new Error(`${context}: wizard completion kind must be "document-store" or "hook"`);
	}
	if (data !== undefined && !isRecord(data)) {
		throw new Error(`${context}: wizard completion data must be an object`);
	}
};

/**
 * Validate an untyped manifest/DB payload as a {@link WizardDefinition}.
 * Throws with a `plugin "…" contribution "…"`-style context string
 * supplied by the caller — same packaging-bug contract as
 * `assertFormDefinition`/`toDocumentCollection`.
 */
export const assertWizardDefinition = (value: unknown, context: string): WizardDefinition => {
	if (!isRecord(value)) {
		throw new Error(`${context}: wizard definition must be an object`);
	}
	const { id, owner, title, description, steps, completion, submitLabel, permission } = value;
	if (typeof id !== "string" || !WIZARD_ID_PATTERN.test(id)) {
		throw new Error(
			`${context}: wizard id must match ${WIZARD_ID_PATTERN} (got ${JSON.stringify(id)})`,
		);
	}
	if (owner !== undefined && typeof owner !== "string") {
		throw new Error(`${context}: wizard owner must be a string`);
	}
	if (title !== undefined && typeof title !== "string") {
		throw new Error(`${context}: wizard title must be a string`);
	}
	if (description !== undefined && typeof description !== "string") {
		throw new Error(`${context}: wizard description must be a string`);
	}
	if (submitLabel !== undefined && typeof submitLabel !== "string") {
		throw new Error(`${context}: wizard submitLabel must be a string`);
	}
	if (permission !== undefined) {
		if (typeof permission !== "string" || !PERMISSION_RE.test(permission)) {
			throw new Error(
				`${context}: wizard "${id}" permission must use the "resource.action" spelling`,
			);
		}
	}
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new Error(`${context}: wizard "${id}" needs at least one step`);
	}
	const seen = new Set<string>();
	steps.forEach((step, index) => assertStep(step, `${context} step[${index}]`, seen));
	if (completion !== undefined) assertCompletion(completion, `${context} completion`);
	return value as unknown as WizardDefinition;
};

/**
 * The `wizard.def` contribution pipeline — kind descriptor, define /
 * contribution / to-def / collect / registry builders — owned by
 * `defineDefKind` (@ktb/kernel). Two deliberate deviations from the
 * sibling kinds, preserved from the hand-rolled version: manifest
 * entries carry NO `version` (defs version implicitly with the
 * plugin), and `collect` performs no duplicate-id check — DB-backed
 * `wizard_defs` rows share the id namespace downstream, where the
 * run service arbitrates.
 */
const wizardDefKind = defineDefKind<WizardDefinition, "wizards">({
	id: "wizard.def",
	// app-host.client: defs are JSON data the browser runner consumes
	// (ctx.plugins on page surfaces). Emitters must mirror
	// `contributions` in client.ts — see module docstring.
	// wizards.services: the run service resolves DB defs + validates
	// client-supplied snapshots against the same contract.
	consumers: ["app-host.client", "wizards.services", "plugin-manager"],
	assert: assertWizardDefinition,
	defId: (def) => def.id,
	noun: "wizard",
	field: "wizards",
	version: () => undefined,
});

/** The registered contribution kind for wizard definitions. */
export const WIZARD_DEF_KIND = wizardDefKind.KIND;

/**
 * Build a typed definition — asserts immediately so packaging bugs
 * surface at module load, not at first render.
 */
export const defineWizard = wizardDefKind.define;

/**
 * Build the manifest entry a plugin adds to `contributions`:
 *
 * ```ts
 * contributions: [wizardDefContribution(myWizard)]
 * ```
 *
 * `meta` carries the whole definition (JSON data); `id` is the wizard
 * id (the /wizards/<id> segment). Remember to mirror `contributions`
 * in the plugin's `src/client.ts` — the runner reads the client
 * registry.
 */
export const wizardDefContribution = wizardDefKind.contribution;

/** Narrow a collected `PluginContribution` back to a definition.
 * Throws on malformed entries — same packaging-bug contract as
 * {@link assertWizardDefinition}. `owner` falls back to the
 * contributing plugin id. */
export const toWizardDefinition = wizardDefKind.toDef;

/** Collect every `wizard.def` contribution across `plugins` (expected
 * in topo order — pass the output of `orderPlugins`/`ctx.plugins`). */
export const collectWizardDefinitions = wizardDefKind.collect;

/**
 * The ordered wizard registry the composition root provides to the
 * `Wizards` service — the layer @ktb/app-host merges into `core` next
 * to `makeViewDefinitions(plugins)`/`makeTriggerDefinitions(plugins)`/
 * `makeFlowDefinitions(plugins)`. The run service uses it to decide
 * whether a client-supplied definition snapshot is a legitimate
 * code-contribution (deep-equal) or a forgery.
 *
 * `ownerIndex` is optional so hand-built registries (tests, tooling)
 * keep working; `makeWizardDefinitions` always populates it. The run
 * service re-checks each contributed def's `owner` against
 * `PluginStates.enabledIds()` at `startRun` — a disabled plugin's def
 * is not honored (same contract as @ktb/views/@ktb/api).
 */
export class WizardDefinitions extends Context.Service<
	WizardDefinitions,
	{
		readonly wizards: readonly WizardDefinition[];
		readonly ownerIndex?: DefOwnerIndex;
	}
>()("@ktb/wizards/WizardDefinitions") {}

/** Build the `WizardDefinitions` service value for a plugin graph. */
export const makeWizardDefinitions = wizardDefKind.makeRegistry;

/** Extract the wizard id from a `/wizards/<id>` request path — the
 * runner page's wildcard descriptor passes the full path as `data`.
 * Returns null for the bare `/wizards` or `/wizards/` prefix. */
export const wizardIdFromPath = (path: string): string | null => {
	const match = /^\/wizards\/([^/?#]+)\/?$/.exec(path.trim());
	return match?.[1] ?? null;
};
