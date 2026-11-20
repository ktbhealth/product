import { useMemo, useState, type ComponentType } from "react";

import { Render } from "@puckeditor/core/rsc";
import type { Config, Data, Field } from "@puckeditor/core";
import {
	collectKindContributions,
	ELEMENT_KINDS_KIND,
	type ElementKind,
	type ElementKindEditorProps,
	type Plugin,
} from "@ktb/kernel";
import type { JsonSchema, JsonSchemaObject } from "@ktb/json-schema";

import { migrateBuilderDoc, parseBuilderDoc } from "./doc.ts";

/**
 * Registry → Puck adapter (PL-014 / P-109): compiles the client
 * `elementKinds` manifest into a Puck `Config` and renders stored
 * `builderJson` documents through Puck's `<Render>`.
 *
 * Two storage shapes, chosen per kind:
 *
 * - FLAT (kind declares `fields`): the Puck component's props ARE the
 *   kind's props payload. Each schema property becomes a native Puck
 *   field — `enum`/`const` → select, `string` → text, `boolean` →
 *   checkbox, `integer`/`number` → number; arrays/objects/unions fall
 *   back to a commit-on-blur JSON field. The kind's `renderer`
 *   receives the stored props (minus Puck internals) as `value`.
 * - WRAPPED (no `fields`, `editor` present — e.g. `rich-text`): the
 *   component stores a single `value` prop holding the whole payload
 *   and edits it through the kind's `editor` mounted as a Puck custom
 *   field. The `renderer` receives `props.value`.
 * - Neither (render-only kinds): flat shape with no fields — stored
 *   props pass through uneditable.
 *
 * Component keys are the kind ids themselves, so `data.content[].type`
 * values are stable across releases — the same strings consumers
 * already store.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow an untyped manifest payload to the catalog's view of an
 * ElementKind — same contract as the /platform/components catalog. */
const asKind = (payload: unknown): ElementKind | null => {
	if (!isRecord(payload)) return null;
	const kind = payload as unknown as ElementKind;
	return typeof kind.kind === "string" && typeof kind.label === "string" ? kind : null;
};

/** Every `elementKinds` manifest entry across `plugins`, in topo
 * order — the palette `<Puck>` and `<Render>` both compile. */
export const collectElementKinds = (plugins: readonly Plugin[]): readonly ElementKind[] =>
	collectKindContributions(plugins, ELEMENT_KINDS_KIND)
		.map((entry) => asKind(entry.payload))
		.filter((kind): kind is ElementKind => kind !== null);

/* ------------------------------------------------------------------ */
/* Field generation                                                    */
/* ------------------------------------------------------------------ */

const propTitle = (name: string, schema: JsonSchema): string => {
	/* v8 ignore next -- fieldForProp only reaches this for object schemas;
	 * the fallback satisfies the boolean arm of the JsonSchema union. */
	if (typeof schema !== "object" || schema === null) return name;
	return schema.title ?? name;
};

/** Select options only when every enum/const value is a string —
 * Puck select fields are string-valued; mixed enums degrade to the
 * JSON field instead of coercing silently. */
const stringOptions = (schema: JsonSchema): readonly string[] | null => {
	/* v8 ignore next -- JsonSchema admits boolean|object; null can only
	 * arrive via an untyped manifest payload and typeof rejects it anyway. */
	if (typeof schema !== "object" || schema === null) return null;
	const values = schema.enum ?? (schema.const !== undefined ? [schema.const] : undefined);
	if (values === undefined) return null;
	return values.every((v): v is string => typeof v === "string") ? values : null;
};

/** Commit-on-blur JSON editor for array/object/union props — same
 * contract as the builder-blocks schema editor's JSON widget:
 * unparseable input is stored raw so schema validation flags it. */
const JsonPropsField = ({
	value,
	onChange,
	readOnly,
}: {
	readonly value: unknown;
	readonly onChange: (value: unknown) => void;
	readonly readOnly?: boolean;
}) => {
	const [draft, setDraft] = useState<string | null>(null);
	const shown =
		draft ?? (value === undefined || value === null ? "" : JSON.stringify(value, null, 2));
	return (
		<textarea
			className="min-h-20 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
			value={shown}
			readOnly={readOnly}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => {
				if (draft === null) return;
				const text = draft.trim();
				if (text === "") {
					onChange(undefined);
				} else {
					try {
						onChange(JSON.parse(text));
					} catch {
						onChange(text);
					}
				}
				setDraft(null);
			}}
		/>
	);
};

const JSON_FIELD: Field = { type: "custom", render: JsonPropsField };

/** Map one schema property to a Puck field; null means "use the JSON
 * fallback" (arrays, objects, unions, non-string enums). */
const fieldForProp = (name: string, schema: JsonSchema): Field => {
	const options = stringOptions(schema);
	if (options !== null) {
		return {
			type: "select",
			label: propTitle(name, schema),
			options: options.map((option) => ({ label: option, value: option })),
		};
	}
	if (typeof schema === "object" && schema !== null && !Array.isArray(schema.type)) {
		switch (schema.type) {
			case "string":
				return { type: "text", label: propTitle(name, schema) };
			case "boolean":
				return {
					type: "checkbox",
					label: propTitle(name, schema),
					options: [
						{ label: "Yes", value: true },
						{ label: "No", value: false },
					],
				};
			case "integer":
			case "number":
				return { type: "number", label: propTitle(name, schema) };
			default:
				break;
		}
	}
	return JSON_FIELD;
};

/** Native Puck fields compiled from a kind's `fields` JSON Schema. */
const flatFields = (fields: JsonSchemaObject): Record<string, Field> => {
	const out: Record<string, Field> = {};
	for (const [name, schema] of Object.entries(fields.properties ?? {})) {
		out[name] = fieldForProp(name, schema);
	}
	return out;
};

/** Schema `default`s become the component's `defaultProps` so newly
 * dropped blocks preview correctly. */
const flatDefaults = (fields: JsonSchemaObject): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const [name, schema] of Object.entries(fields.properties ?? {})) {
		if (typeof schema === "object" && schema !== null && "default" in schema) {
			out[name] = schema.default;
		}
	}
	return out;
};

/** Wrapped mode: one custom field editing the whole payload through
 * the kind's `editor` ({ value, onChange } contract). */
const wrappedField = (Editor: ComponentType<ElementKindEditorProps>): Field => ({
	type: "custom",
	render: ({ value, onChange }) => <Editor value={value} onChange={onChange} />,
});

/* ------------------------------------------------------------------ */
/* Render adapters                                                     */
/* ------------------------------------------------------------------ */

/** Props Puck injects into every component render — never part of the
 * stored payload. */
const PUCK_INTERNALS = new Set(["id", "puck", "editMode", "children"]);

const stripInternals = (props: Record<string, unknown>): Record<string, unknown> =>
	Object.fromEntries(Object.entries(props).filter(([key]) => !PUCK_INTERNALS.has(key)));

type RenderMode = "flat" | "wrapped";

const modeFor = (kind: ElementKind): RenderMode =>
	kind.fields === undefined && kind.editor !== undefined ? "wrapped" : "flat";

const makeRender = (
	kind: ElementKind,
	mode: RenderMode,
): ComponentType<Record<string, unknown>> => {
	const Renderer = kind.renderer as ComponentType<{ value: unknown }> | undefined;
	const Wrapped = (props: Record<string, unknown>) => {
		/* v8 ignore next -- toPuckConfig skips renderer-less kinds before makeRender */
		if (Renderer === undefined) return null;
		const value = mode === "wrapped" ? props.value : stripInternals(props);
		return <Renderer value={value} />;
	};
	Wrapped.displayName = `Builder${kind.kind}`;
	return Wrapped;
};

const fieldsFor = (kind: ElementKind, mode: RenderMode): Record<string, Field> => {
	if (mode === "wrapped" && kind.editor !== undefined) {
		return { value: wrappedField(kind.editor) };
	}
	if (kind.fields !== undefined) return flatFields(kind.fields);
	return {};
};

const defaultsFor = (kind: ElementKind, mode: RenderMode): Record<string, unknown> | undefined => {
	if (mode === "flat" && kind.fields !== undefined) return flatDefaults(kind.fields);
	return undefined;
};

/**
 * Compile element kinds into a Puck `Config`. Kinds without a
 * `renderer` are skipped — they have nothing to draw. `categories`
 * groups the palette by `ElementKind.category` (uncategorized kinds
 * land under "other").
 */
export const toPuckConfig = (kinds: readonly ElementKind[]): Config => {
	const components: Record<string, unknown> = {};
	const categories: Record<string, { title: string; components: string[] }> = {};
	for (const kind of kinds) {
		if (kind.renderer === undefined) continue;
		const mode = modeFor(kind);
		components[kind.kind] = {
			label: kind.label,
			fields: fieldsFor(kind, mode),
			defaultProps: defaultsFor(kind, mode),
			render: makeRender(kind, mode),
		};
		const category = kind.category ?? "other";
		const entry = (categories[category] ??= { title: category, components: [] });
		entry.components.push(kind.kind);
	}
	return {
		components,
		...(Object.keys(categories).length > 0 ? { categories } : {}),
	} as Config;
};

/* ------------------------------------------------------------------ */
/* Document rendering                                                  */
/* ------------------------------------------------------------------ */

/**
 * Render a stored `builderJson` string through Puck's `<Render>`.
 * Returns null for absent/malformed docs — callers fall back to the
 * legacy rich-text/layout render path. The doc is migrated to the
 * current schema version before render; unknown component `type`s in
 * the data are tolerated by Puck (skipped).
 */
export const BuilderDocument = ({
	builderJson,
	elementKinds,
}: {
	readonly builderJson: string | null | undefined;
	readonly elementKinds: readonly ElementKind[];
}) => {
	const config = useMemo(() => toPuckConfig(elementKinds), [elementKinds]);
	const doc = useMemo(() => {
		const parsed = parseBuilderDoc(builderJson);
		return parsed === null ? null : migrateBuilderDoc(parsed);
	}, [builderJson]);
	if (doc === null) return null;
	return <Render config={config} data={doc.data as Data} />;
};
