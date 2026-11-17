import type { JsonObject } from "effect/Schema";
import type { JsonSchemaObject } from "@ktb/json-schema";
import { assertSchema } from "@ktb/json-schema";
import type { FormFieldUi } from "@ktb/forms";
import {
	collectKindContributions,
	GENERIC_CONTRIBUTION_SLOT,
	type ContributionKindDescriptor,
	type Plugin,
	type PluginContribution,
} from "@ktb/kernel";

import { assertCondition, type WizardCondition } from "./condition.ts";

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
 */

/** The registered contribution kind for wizard definitions. */
export const WIZARD_DEF_KIND: ContributionKindDescriptor = {
	id: "wizard.def",
	slot: GENERIC_CONTRIBUTION_SLOT,
	// app-host.client: defs are JSON data the browser runner consumes
	// (ctx.plugins on page surfaces). Emitters must mirror
	// `contributions` in client.ts — see module docstring.
	// wizards.services: the run service resolves DB defs + validates
	// client-supplied snapshots against the same contract.
	consumers: ["app-host.client", "wizards.services", "plugin-manager"],
	ordering: "topo",
};

/** Wizard ids double as URL segments — keep them slug-safe. */
export const WIZARD_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Step kinds the v1 interpreter knows how to render. */
export type WizardStepKind = "form" | "info";

interface WizardStepBase {
	/** Step id — keys the submitted value in `answers` (`answers[step.id]`). */
	readonly id: string;
	readonly title?: string;
	readonly description?: string;
	/** Optional visibility condition evaluated against submitted answers
	 * — a hidden step is skipped by the interpreter (./resolve.ts). */
	readonly when?: WizardCondition;
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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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
		if (typeof collection !== "string" || collection.length === 0) {
			throw new Error(`${context}: document-store completion needs a collection name`);
		}
	} else if (kind === "hook") {
		if (typeof hook !== "string" || hook.length === 0) {
			throw new Error(`${context}: hook completion needs a hook id`);
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
	const { id, owner, title, description, steps, completion, submitLabel } = value;
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
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new Error(`${context}: wizard "${id}" needs at least one step`);
	}
	const seen = new Set<string>();
	steps.forEach((step, index) => assertStep(step, `${context} step[${index}]`, seen));
	if (completion !== undefined) assertCompletion(completion, `${context} completion`);
	return value as unknown as WizardDefinition;
};

/**
 * Build a typed definition — asserts immediately so packaging bugs
 * surface at module load, not at first render.
 */
export const defineWizard = (def: WizardDefinition): WizardDefinition =>
	assertWizardDefinition(def, `wizard "${String((def as { id?: unknown }).id)}"`);

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
export const wizardDefContribution = (def: WizardDefinition): PluginContribution => ({
	kind: WIZARD_DEF_KIND.id,
	id: def.id,
	// Defs are pure JSON by construction (JsonSchema subset + JSON
	// conditions/completions) — the cast bridges the typed view onto
	// the serializable contract, same as formDefContribution.
	meta: def as unknown as JsonObject,
});

/** Narrow a collected `PluginContribution` back to a definition.
 * Throws on malformed entries — same packaging-bug contract as
 * {@link assertWizardDefinition}. `owner` falls back to the
 * contributing plugin id. */
export const toWizardDefinition = (
	entry: PluginContribution,
	pluginId: string,
): WizardDefinition => {
	const def = assertWizardDefinition(entry.meta, `plugin "${pluginId}" contribution "${entry.id}"`);
	return def.owner === undefined ? { ...def, owner: pluginId } : def;
};

/** Collect every `wizard.def` contribution across `plugins` (expected
 * in topo order — pass the output of `orderPlugins`/`ctx.plugins`). */
export const collectWizardDefinitions = (plugins: readonly Plugin[]): readonly WizardDefinition[] =>
	collectKindContributions(plugins, WIZARD_DEF_KIND).map(({ plugin, payload }) =>
		toWizardDefinition(payload as PluginContribution, plugin.id),
	);

/** Extract the wizard id from a `/wizards/<id>` request path — the
 * runner page's wildcard descriptor passes the full path as `data`.
 * Returns null for the bare `/wizards` or `/wizards/` prefix. */
export const wizardIdFromPath = (path: string): string | null => {
	const match = /^\/wizards\/([^/?#]+)\/?$/.exec(path.trim());
	return match?.[1] ?? null;
};
