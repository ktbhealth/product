import { useState, type ComponentType } from "react";

import type { ElementKindEditorProps } from "@ktb/kernel";
import { compileSchema, type JsonSchema, type JsonSchemaObject } from "@ktb/json-schema";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import { Input } from "@ktbhealth/ui/components/input";
import { Label } from "@ktbhealth/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@ktbhealth/ui/components/native-select";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import { isRecord } from "./renderers.tsx";

/**
 * Schema-driven prop editor for builder blocks (P-108): adapts an
 * `ElementKind.fields` JSON Schema (@ktb/json-schema subset — the same
 * profile `form.def` uses) into a small controlled form matching the
 * kind's `{ value, onChange }` editor contract.
 *
 * Widget resolution is deliberately flat — top-level properties only,
 * same v1 scope as `FormFieldUi` hints in plugins/forms:
 * - `enum`/`const` → select
 * - `boolean` → checkbox
 * - `number`/`integer` → numeric input
 * - `array`/`object`/unions → JSON textarea (commit on blur; invalid
 *   JSON is stored raw so schema validation flags it)
 * - everything else → text input
 *
 * The schema is compiled once per editor instance; issues are computed
 * per render and summarized under the form — palettes (PL-014) will
 * compile the same `fields` schema into richer per-kind editors, so
 * this component is the registry's baseline editor, not the final UX.
 */

type Widget = "select" | "checkbox" | "number" | "json" | "text";

interface WidgetResolution {
	readonly widget: Widget;
	/** Select options — populated only for `widget: "select"`. */
	readonly options: readonly unknown[];
}

const resolveWidget = (schema: JsonSchema): WidgetResolution => {
	if (typeof schema === "boolean") return { widget: "text", options: [] };
	if (schema.enum !== undefined || schema.const !== undefined) {
		return { widget: "select", options: schema.enum ?? [schema.const] };
	}
	if (schema.type === "boolean") return { widget: "checkbox", options: [] };
	if (schema.type === "number" || schema.type === "integer")
		return { widget: "number", options: [] };
	if (schema.type === "array" || schema.type === "object") return { widget: "json", options: [] };
	return { widget: "text", options: [] };
};

const optionLabel = (value: unknown): string =>
	typeof value === "string" ? value : JSON.stringify(value);

/** Stable string form of a prop value for controlled inputs. */
const displayString = (value: unknown): string => {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
};

export const schemaEditor = (fields: JsonSchemaObject): ComponentType<ElementKindEditorProps> => {
	const validator = compileSchema(fields);
	const properties = fields.properties ?? {};
	const required = new Set(fields.required ?? []);

	const SchemaEditor = ({ value, onChange }: ElementKindEditorProps) => {
		const props = isRecord(value) ? value : {};
		const issues = validator.validate(props);
		const set = (key: string, next: unknown) => onChange({ ...props, [key]: next });

		return (
			<div className="flex flex-col gap-3">
				{Object.entries(properties).map(([key, propSchema]) => {
					const { widget, options } = resolveWidget(propSchema);
					const current = props[key];
					const label =
						typeof propSchema === "object" && propSchema !== null ? (propSchema.title ?? key) : key;
					const fieldId = `builder-block-field-${key}`;
					return (
						<div key={key} className="flex flex-col gap-1.5">
							<Label htmlFor={widget === "checkbox" ? undefined : fieldId}>
								{label}
								{required.has(key) && <span aria-hidden="true">*</span>}
							</Label>
							{widget === "select" && (
								<NativeSelect
									id={fieldId}
									value={displayString(current)}
									onChange={(event) => {
										const raw = event.target.value;
										const match = options.find((option) => optionLabel(option) === raw);
										set(key, match);
									}}
								>
									{options.map((option, index) => (
										// oxlint-disable-next-line react/no-array-index-key -- options are positional
										<NativeSelectOption key={index} value={optionLabel(option)}>
											{optionLabel(option)}
										</NativeSelectOption>
									))}
								</NativeSelect>
							)}
							{widget === "checkbox" && (
								<Checkbox
									checked={current === true}
									onCheckedChange={(checked) => set(key, checked === true)}
								/>
							)}
							{widget === "number" && (
								<Input
									id={fieldId}
									type="number"
									value={displayString(current)}
									onChange={(event) => {
										const raw = event.target.value;
										// type="number" only yields a valid float or ""
										set(key, raw === "" ? undefined : Number(raw));
									}}
								/>
							)}
							{widget === "json" && (
								<JsonField id={fieldId} value={current} onCommit={(next) => set(key, next)} />
							)}
							{widget === "text" && (
								<Input
									id={fieldId}
									value={displayString(current)}
									onChange={(event) => set(key, event.target.value)}
								/>
							)}
						</div>
					);
				})}
				{issues.length > 0 && (
					<p className="text-xs text-destructive">
						{issues.length} validation issue{issues.length === 1 ? "" : "s"}
					</p>
				)}
			</div>
		);
	};
	SchemaEditor.displayName = "SchemaPropsEditor";
	return SchemaEditor;
};

/** JSON textarea for array/object props: commits on blur so partial
 * JSON never lands in the payload mid-keystroke. Unparseable input is
 * stored as the raw string — schema validation then flags the type
 * mismatch instead of silently dropping the edit. */
const JsonField = ({
	id,
	value,
	onCommit,
}: {
	readonly id: string;
	readonly value: unknown;
	readonly onCommit: (value: unknown) => void;
}) => {
	const [draft, setDraft] = useState<string | null>(null);
	const shown = draft ?? (value === undefined ? "" : JSON.stringify(value, null, 2));
	return (
		<Textarea
			id={id}
			className="font-mono text-xs"
			rows={4}
			value={shown}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => {
				if (draft === null) return;
				const text = draft.trim();
				if (text === "") {
					onCommit(undefined);
				} else {
					try {
						onCommit(JSON.parse(text));
					} catch {
						onCommit(text);
					}
				}
				setDraft(null);
			}}
		/>
	);
};

/** Preview helper for catalog surfaces: the props a renderer sees when
 * a consumer stores only schema defaults — every `default` annotation
 * applied, nothing else. */
export const defaultPropsFor = (fields: JsonSchemaObject | undefined): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const [key, schema] of Object.entries(fields?.properties ?? {})) {
		if (typeof schema === "object" && schema !== null && "default" in schema) {
			out[key] = schema.default;
		}
	}
	return out;
};
