import type { JsonObject } from "effect/Schema";
import type { JsonSchemaObject } from "@ktb/json-schema";
import { assertSchema } from "@ktb/json-schema";
import {
	collectKindContributions,
	GENERIC_CONTRIBUTION_SLOT,
	type ContributionKindDescriptor,
	type Plugin,
	type PluginContribution,
} from "@ktb/kernel";

/**
 * Form definitions as DATA — the `form.def` contribution kind.
 *
 * A plugin contributes a fillable form by putting a
 * `formDefContribution(def)` entry in its manifest's generic
 * `contributions` array; the payload is plain JSON
 * (`PluginContribution.meta` is `JsonObject`), so no kernel changes
 * are needed. `@ktb/forms` owns the kind descriptor and the renderer:
 * `SchemaForm` draws any collected definition with @ktbhealth/ui
 * controls and validates values against the definition's JSON Schema
 * (the @ktb/json-schema draft-2020-12 subset — see
 * packages/json-schema/PROFILE.md).
 *
 * The standalone `/forms/<id>` page (./forms-page.tsx) resolves defs
 * from `ctx.plugins` — the enabled-filtered CLIENT registry — so
 * plugins that emit `form.def` entries MUST mirror `contributions` in
 * their `src/client.ts` (same contract as chrome/panel/pages).
 * `FORM_DEF_KIND.consumers` records that requirement.
 */

/** The registered contribution kind for form definitions. */
export const FORM_DEF_KIND: ContributionKindDescriptor = {
	id: "form.def",
	slot: GENERIC_CONTRIBUTION_SLOT,
	// app-host.client: defs are JSON data the browser renderer consumes
	// (ctx.plugins on page surfaces). Emitters must mirror
	// `contributions` in client.ts — see module docstring.
	consumers: ["app-host.client", "plugin-manager"],
	ordering: "topo",
};

/**
 * Per-field presentation hints, keyed by TOP-LEVEL property name only
 * (nested objects/arrays inherit schema-driven rendering — v1 keeps
 * the hint surface flat). Every hint is optional; absent hints fall
 * back to schema inference (see ./schema-utils.ts).
 */
export interface FormFieldUi {
	/** Force a widget. Inference order otherwise: enum/const → select,
	 * string → input, number/integer → number, boolean → checkbox,
	 * simple-items array → list, object → nested fieldset, anything
	 * else → json. */
	readonly widget?:
		| "input"
		| "textarea"
		| "select"
		| "radio"
		| "checkbox"
		| "switch"
		| "number"
		| "json"
		| "list"
		| "object";
	/** Placeholder for text-like widgets; also labels the empty option
	 * of select/radio when the field is optional. */
	readonly placeholder?: string;
	/** Explicit options for select/radio — overrides `enum`/`const`.
	 * `value` is compared to the field value by JSON equality; `label`
	 * is the visible text (defaults to String(value)). */
	readonly options?: readonly { readonly value: unknown; readonly label: string }[];
}

/**
 * A form definition — the unit plugins contribute. `schema` must be an
 * object-typed JSON Schema in the @ktb/json-schema subset; its
 * `properties` become the fields, `required` marks mandatory inputs,
 * and annotation keywords (`title`, `description`, `default`) drive
 * labels, help text and initial values.
 */
export interface FormDefinition {
	/** Form id — also the URL segment under /forms/. Lowercase slug. */
	readonly id: string;
	/** Owning plugin id — stamped from the contributing plugin when the
	 * manifest omits it. */
	readonly owner?: string;
	readonly title?: string;
	readonly description?: string;
	/** Object schema describing the submitted value. */
	readonly schema: JsonSchemaObject;
	/** Presentation hints keyed by top-level property name. */
	readonly ui?: Readonly<Record<string, FormFieldUi>>;
	/** Submit button label; falls back to the messages catalog. */
	readonly submitLabel?: string;
}

/** Form ids double as URL segments — keep them slug-safe. */
export const FORM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate an untyped manifest payload as a {@link FormDefinition}.
 * Throws with a `plugin "…" contribution "…"`-style context string
 * supplied by the caller — same packaging-bug contract as
 * `toDocumentCollection`/`toEvalContribution`.
 */
export const assertFormDefinition = (value: unknown, context: string): FormDefinition => {
	if (!isRecord(value)) {
		throw new Error(`${context}: form definition must be an object`);
	}
	const { id, owner, title, description, schema, ui, submitLabel } = value;
	if (typeof id !== "string" || !FORM_ID_PATTERN.test(id)) {
		throw new Error(
			`${context}: form id must match ${FORM_ID_PATTERN} (got ${JSON.stringify(id)})`,
		);
	}
	if (owner !== undefined && typeof owner !== "string") {
		throw new Error(`${context}: form owner must be a string`);
	}
	if (title !== undefined && typeof title !== "string") {
		throw new Error(`${context}: form title must be a string`);
	}
	if (description !== undefined && typeof description !== "string") {
		throw new Error(`${context}: form description must be a string`);
	}
	if (submitLabel !== undefined && typeof submitLabel !== "string") {
		throw new Error(`${context}: form submitLabel must be a string`);
	}
	// assertSchema enforces the @ktb/json-schema subset — unknown
	// keywords, bad types, unsafe patterns all fail loudly here, at
	// composition time, not at render time.
	assertSchema(schema);
	if (!isRecord(schema)) {
		throw new Error(`${context}: form schema must be a schema object (not a boolean)`);
	}
	const types = schema.type;
	const isObject = types === "object" || (Array.isArray(types) && types.includes("object"));
	if (!isObject) {
		throw new Error(
			`${context}: form schema must be object-typed (got type ${JSON.stringify(types)})`,
		);
	}
	if (ui !== undefined) {
		if (!isRecord(ui)) {
			throw new Error(`${context}: form ui hints must be an object`);
		}
		for (const [key, hint] of Object.entries(ui)) {
			if (!isRecord(hint)) {
				throw new Error(`${context}: ui hint for "${key}" must be an object`);
			}
			const { widget, placeholder, options } = hint;
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
	return value as unknown as FormDefinition;
};

/**
 * Build a typed definition — asserts immediately so packaging bugs
 * surface at module load, not at first render.
 */
export const defineForm = (def: FormDefinition): FormDefinition =>
	assertFormDefinition(def, `form "${String((def as { id?: unknown }).id)}"`);

/**
 * Build the manifest entry a plugin adds to `contributions`:
 *
 * ```ts
 * contributions: [formDefContribution(myForm)]
 * ```
 *
 * `meta` carries the whole definition (JSON data); `id` is the form id
 * (the /forms/<id> segment). Remember to mirror `contributions` in the
 * plugin's `src/client.ts` — the renderer reads the client registry.
 */
export const formDefContribution = (def: FormDefinition): PluginContribution => ({
	kind: FORM_DEF_KIND.id,
	id: def.id,
	// Defs are pure JSON by construction (JsonSchema subset + string
	// hints) — the cast bridges the typed view onto the serializable
	// contract, same as documentCollectionContribution.
	meta: def as unknown as JsonObject,
});

/** Narrow a collected `PluginContribution` back to a definition.
 * Throws on malformed entries — same packaging-bug contract as
 * {@link assertFormDefinition}. `owner` falls back to the
 * contributing plugin id. */
export const toFormDefinition = (entry: PluginContribution, pluginId: string): FormDefinition => {
	const def = assertFormDefinition(entry.meta, `plugin "${pluginId}" contribution "${entry.id}"`);
	return def.owner === undefined ? { ...def, owner: pluginId } : def;
};

/**
 * The ordered form registry page surfaces resolve against: every
 * `form.def` contribution across the (enabled-filtered, client-side)
 * plugin list, in topo then declaration order. Duplicate form ids are
 * a packaging bug — this throws rather than letting the last
 * contribution win.
 */
export const collectFormDefinitions = (plugins: readonly Plugin[]): readonly FormDefinition[] => {
	const collected = collectKindContributions(plugins, FORM_DEF_KIND).map((entry) =>
		toFormDefinition(entry.payload as PluginContribution, entry.plugin.id),
	);
	const seen = new Set<string>();
	for (const def of collected) {
		if (seen.has(def.id)) {
			throw new Error(`duplicate form definition "${def.id}" contributed by multiple plugins`);
		}
		seen.add(def.id);
	}
	return collected;
};

/**
 * Extract the form id from a `/forms/<id>` request path — the
 * wildcard page's loader/guard share this. Returns null for paths
 * outside the subtree or with extra segments.
 */
export const formIdFromPath = (path: string): string | null => {
	const match = /^\/forms\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(path);
	return match?.[1] ?? null;
};
