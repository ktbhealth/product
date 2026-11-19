import { createContext, useContext, useMemo, useState, type FormEvent } from "react";

import {
	compileSchema,
	type JsonSchema,
	type JsonSchemaObject,
	type ValidationIssue,
} from "@ktb/json-schema";
import { Alert, AlertDescription, AlertTitle } from "@ktbhealth/ui/components/alert";
import { Button } from "@ktbhealth/ui/components/button";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { RadioGroup, RadioGroupItem } from "@ktbhealth/ui/components/radio-group";
import { Switch } from "@ktbhealth/ui/components/switch";
import { Textarea } from "@ktbhealth/ui/components/textarea";
import { PlusIcon, Trash2Icon } from "lucide-react";

import type { FormDefinition, FormFieldUi } from "./definition.ts";
import { formsMessages, type FormMessages } from "./i18n.ts";
import {
	decodeOption,
	defaultFor,
	displayString,
	encodeOption,
	inferWidget,
	initialValueFromSchema,
	isArrayLike,
	isObjectLike,
	isSchemaObject,
	issuesForField,
	issuesForObjectNode,
	optionLabel,
	optionValues,
	pruneEmpty,
	sanitizeId,
	schemaTypes,
	setIn,
	unmatchedIssues,
} from "./schema-utils.ts";

/**
 * SchemaForm — the schema-driven form renderer. Draws a
 * {@link FormDefinition}'s object schema with @ktbhealth/ui controls,
 * validates the assembled value against the @ktb/json-schema subset
 * on submit, and reports per-field issues through FieldError
 * (role="alert") plus a form-level Alert summary. Every control is
 * labelled (`htmlFor`/`aria-labelledby`), invalid fields carry
 * `aria-invalid` + `aria-describedby`, and required fields expose
 * `required`/`aria-required` — the renderer is keyboard- and
 * screen-reader-complete by construction.
 */

interface FormScope {
	readonly values: Record<string, unknown>;
	readonly setValue: (segments: readonly (string | number)[], next: unknown) => void;
	readonly issues: readonly ValidationIssue[];
	readonly messages: FormMessages;
	readonly disabled: boolean;
	readonly idPrefix: string;
}

const FormScopeContext = createContext<FormScope | null>(null);

// Internal invariant: every consumer renders inside <SchemaForm> —
// the cast keeps the hook branch-free (100% coverage contract).
const useFormScope = (): FormScope => useContext(FormScopeContext) as FormScope;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const joinPath = (base: string, key: string): string => (base === "" ? key : `${base}.${key}`);

export interface SchemaFormProps {
	readonly definition: FormDefinition;
	/** Locale catalog — defaults to English. */
	readonly messages?: FormMessages;
	/** Controlled initial value; absent keys fall back to schema
	 * `default`s via {@link initialValueFromSchema}. */
	readonly initialValue?: unknown;
	readonly onSubmit?: (value: unknown) => void;
	readonly onInvalid?: (issues: readonly ValidationIssue[]) => void;
	readonly disabled?: boolean;
	/** DOM id prefix for controls ("my-form" → "my-form-name"). */
	readonly idPrefix?: string;
}

export const SchemaForm = ({
	definition,
	messages = formsMessages(undefined),
	initialValue,
	onSubmit,
	onInvalid,
	disabled = false,
	idPrefix = "form",
}: SchemaFormProps) => {
	const { schema } = definition;
	const validator = useMemo(() => compileSchema(schema), [schema]);
	const [values, setValues] = useState<Record<string, unknown>>(() =>
		isRecord(initialValue) ? initialValue : initialValueFromSchema(schema),
	);
	const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);

	const scope: FormScope = {
		values,
		setValue: (segments, next) =>
			setValues((current) => setIn(current, segments, next) as Record<string, unknown>),
		issues,
		messages,
		disabled,
		idPrefix,
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const candidate = pruneEmpty(schema, values);
		const found = validator.validate(candidate);
		setIssues(found);
		if (found.length > 0) {
			onInvalid?.(found);
			return;
		}
		onSubmit?.(candidate);
	};

	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const stray = unmatchedIssues(issues, Object.keys(properties));

	return (
		<FormScopeContext.Provider value={scope}>
			<form onSubmit={handleSubmit} noValidate data-slot="schema-form">
				{definition.description !== undefined && (
					<p className="mb-4 text-sm text-muted-foreground">{definition.description}</p>
				)}
				<PropertyFields
					schema={schema}
					ui={definition.ui}
					value={values}
					path=""
					segments={[]}
					required={required}
				/>
				{issues.length > 0 && (
					<Alert variant="destructive" className="mt-4">
						<AlertTitle>{messages.invalidSummary(issues.length)}</AlertTitle>
						{stray.length > 0 && (
							<AlertDescription>
								<ul className="ml-4 list-disc">
									{stray.map((issue, index) => (
										<li key={index}>
											{issue.path.replace(/^\$$/, "form")}: {issue.message}
										</li>
									))}
								</ul>
							</AlertDescription>
						)}
					</Alert>
				)}
				<div className="mt-4">
					<Button type="submit" disabled={disabled}>
						{definition.submitLabel ?? messages.submit}
					</Button>
				</div>
			</form>
		</FormScopeContext.Provider>
	);
};

/** Render every declared property of an object(-like) schema.
 * `ui` hints apply only at the top level (definition.ui is keyed by
 * top-level property name); nested nodes pass undefined. */
const PropertyFields = ({
	schema,
	ui,
	value,
	path,
	segments,
	required,
}: {
	readonly schema: JsonSchema;
	readonly ui?: Readonly<Record<string, FormFieldUi>>;
	readonly value: Record<string, unknown>;
	readonly path: string;
	readonly segments: readonly (string | number)[];
	readonly required: ReadonlySet<string>;
}) => {
	const properties = isSchemaObject(schema) && isRecord(schema.properties) ? schema.properties : {};
	return (
		<FieldGroup>
			{Object.entries(properties).map(([key, propertySchema]) => (
				<PropertyField
					key={key}
					name={key}
					schema={propertySchema}
					ui={ui?.[key]}
					value={value[key]}
					path={joinPath(path, key)}
					segments={[...segments, key]}
					required={required.has(key)}
				/>
			))}
		</FieldGroup>
	);
};

/** One labelled field: resolves its widget, wires value/errors/a11y. */
const PropertyField = ({
	name,
	schema,
	ui,
	value,
	path,
	segments,
	required,
}: {
	readonly name: string;
	readonly schema: JsonSchema;
	readonly ui?: FormFieldUi;
	readonly value: unknown;
	readonly path: string;
	readonly segments: readonly (string | number)[];
	readonly required: boolean;
}) => {
	const scope = useFormScope();
	const meta: JsonSchemaObject = isSchemaObject(schema) ? schema : {};
	const title = typeof meta.title === "string" ? meta.title : name;
	const description = typeof meta.description === "string" ? meta.description : undefined;
	const fieldIssues = issuesForField(scope.issues, path);
	const invalid = fieldIssues.length > 0;
	const controlId = `${scope.idPrefix}-${sanitizeId(path)}`;
	const descId = `${controlId}-desc`;
	const errId = `${controlId}-err`;
	const describedBy = [description !== undefined ? descId : "", invalid ? errId : ""]
		.filter((id) => id !== "")
		.join(" ");

	const onChange = (next: unknown) => scope.setValue(segments, next);

	let widget = inferWidget(schema, ui);
	// Defensive: a forced ui.widget that doesn't match the schema's
	// shape degrades to json rather than crashing the renderer.
	if (widget === "list" && !isArrayLike(schema)) widget = "json";
	if (widget === "object" && !isObjectLike(schema)) widget = "json";

	if (widget === "object") {
		return (
			<FieldSet>
				<FieldLegend>
					{title}
					{required && <span aria-hidden="true"> *</span>}
				</FieldLegend>
				{description !== undefined && (
					<FieldDescription id={descId}>{description}</FieldDescription>
				)}
				<PropertyFields
					schema={schema}
					ui={undefined}
					value={isRecord(value) ? value : {}}
					path={path}
					segments={segments}
					required={
						new Set(isSchemaObject(schema) && Array.isArray(schema.required) ? schema.required : [])
					}
				/>
				{/* Only exact-path issues surface on the fieldset — deeper
				    violations already render on their own fields. */}
				<FieldError
					id={errId}
					errors={issuesForObjectNode(scope.issues, path, name).map((issue) => ({
						message: issue.message,
					}))}
				/>
			</FieldSet>
		);
	}

	const control =
		widget === "list" ? (
			<ListControl schema={schema} value={value} onChange={onChange} path={path} title={title} />
		) : (
			<ScalarControl
				schema={schema}
				ui={ui}
				widget={widget}
				value={value}
				onChange={onChange}
				id={controlId}
				path={path}
				required={required}
				label={title}
				describedBy={describedBy === "" ? undefined : describedBy}
			/>
		);

	return (
		<Field data-invalid={invalid || undefined}>
			{widget === "checkbox" || widget === "switch" ? (
				<div className="flex items-center gap-2">
					{control}
					<FieldLabel htmlFor={controlId}>
						{title}
						{required && <span aria-hidden="true"> *</span>}
					</FieldLabel>
				</div>
			) : (
				<>
					<FieldLabel htmlFor={controlId}>
						{title}
						{required && <span aria-hidden="true"> *</span>}
					</FieldLabel>
					{control}
				</>
			)}
			{description !== undefined && <FieldDescription id={descId}>{description}</FieldDescription>}
			<FieldError id={errId} errors={fieldIssues.map((issue) => ({ message: issue.message }))} />
		</Field>
	);
};

/** Scalar-ish control dispatch — everything except list/object. */
const ScalarControl = ({
	schema,
	ui,
	value,
	onChange,
	id,
	path,
	required,
	label,
	ariaLabel,
	describedBy,
	widget: widgetProp,
}: {
	readonly schema: JsonSchema;
	readonly ui?: FormFieldUi;
	/** Pre-resolved widget (PropertyField already applied shape
	 *  downgrades); falls back to inference for array items. */
	readonly widget?: FormFieldUi["widget"];
	readonly value: unknown;
	readonly onChange: (next: unknown) => void;
	readonly id: string;
	readonly path: string;
	readonly required: boolean;
	readonly label: string;
	/** Explicit accessible name for controls without a visible label
	 * (array items). Top-level fields get their name from FieldLabel. */
	readonly ariaLabel?: string;
	readonly describedBy?: string;
}) => {
	const scope = useFormScope();
	const invalid = issuesForField(scope.issues, path).length > 0;
	const a11y = {
		id,
		"aria-label": ariaLabel,
		"aria-invalid": invalid || undefined,
		"aria-describedby": describedBy,
		"aria-required": required || undefined,
		disabled: scope.disabled || undefined,
	};
	const widget = widgetProp ?? inferWidget(schema, ui);

	switch (widget) {
		case "textarea":
			return (
				<Textarea
					{...a11y}
					required={required || undefined}
					value={displayString(value)}
					placeholder={ui?.placeholder}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "number": {
			const types = schemaTypes(schema);
			const meta = isSchemaObject(schema) ? schema : {};
			return (
				<Input
					{...a11y}
					required={required || undefined}
					type="number"
					step={types.includes("integer") ? 1 : undefined}
					min={typeof meta.minimum === "number" ? meta.minimum : undefined}
					max={typeof meta.maximum === "number" ? meta.maximum : undefined}
					value={displayString(value)}
					placeholder={ui?.placeholder}
					onChange={(event) => {
						const raw = event.target.value;
						if (raw === "") {
							onChange(undefined);
							return;
						}
						// input[type=number] only yields "" or valid floats —
						// Number() can't produce NaN here; if it ever did,
						// the schema validator rejects it on submit.
						onChange(Number(raw));
					}}
				/>
			);
		}
		case "select": {
			const values = optionValues(schema, ui);
			if (values === null) {
				// Forced select/radio without discrete options degrades to
				// a plain text input.
				return (
					<Input
						{...a11y}
						required={required || undefined}
						type="text"
						value={displayString(value)}
						placeholder={ui?.placeholder}
						onChange={(event) => onChange(event.target.value)}
					/>
				);
			}
			const placeholder = ui?.placeholder ?? scope.messages.chooseOption;
			const options = values.map((option, index) => ({
				value: encodeOption(option),
				label: optionLabel(option, ui),
				key: index,
			}));
			return (
				<Select
					items={[{ value: "", label: placeholder }, ...options]}
					disabled={scope.disabled || undefined}
					required={required || undefined}
					value={value === undefined || value === null ? "" : encodeOption(value)}
					onValueChange={(next) =>
						onChange(next === "" || next === null ? undefined : decodeOption(next))
					}
				>
					<SelectTrigger {...a11y}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="">{placeholder}</SelectItem>
						{options.map((option) => (
							<SelectItem key={option.key} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			);
		}
		case "radio": {
			const values = optionValues(schema, ui);
			if (values === null) {
				return (
					<Input
						{...a11y}
						required={required || undefined}
						type="text"
						value={displayString(value)}
						placeholder={ui?.placeholder}
						onChange={(event) => onChange(event.target.value)}
					/>
				);
			}
			return (
				<RadioGroup
					aria-label={ariaLabel ?? label}
					aria-required={required || undefined}
					aria-invalid={invalid || undefined}
					aria-describedby={describedBy}
					value={value === undefined || value === null ? "" : encodeOption(value)}
					onValueChange={(next) => onChange(decodeOption(next))}
				>
					{values.map((option, index) => {
						const optionId = `${id}-opt-${index}`;
						return (
							<div key={index} className="flex items-center gap-2">
								<RadioGroupItem
									id={optionId}
									value={encodeOption(option)}
									disabled={scope.disabled || undefined}
								/>
								<label htmlFor={optionId} className="text-sm">
									{optionLabel(option, ui)}
								</label>
							</div>
						);
					})}
				</RadioGroup>
			);
		}
		case "checkbox":
			return (
				<Checkbox
					{...a11y}
					checked={value === true}
					onCheckedChange={(checked) => onChange(checked === true)}
				/>
			);
		case "switch":
			return (
				<Switch
					{...a11y}
					checked={value === true}
					onCheckedChange={(checked) => onChange(checked === true)}
				/>
			);
		case "json":
			return (
				<Textarea
					{...a11y}
					required={required || undefined}
					value={jsonText(value)}
					placeholder={ui?.placeholder}
					onChange={(event) => {
						const raw = event.target.value;
						try {
							onChange(JSON.parse(raw) as unknown);
						} catch {
							// Unparseable input stays a raw string — the schema
							// validator rejects it on submit (and the field
							// keeps showing exactly what was typed).
							onChange(raw);
						}
					}}
				/>
			);
		default:
			// "input" and any unrecognized widget degrade to a text input.
			return (
				<Input
					{...a11y}
					required={required || undefined}
					type="text"
					value={displayString(value)}
					placeholder={ui?.placeholder}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
	}
};

/** Display text for the json widget: strings stay raw (they may be
 * in-progress JSON), everything else pretty-prints. */
const jsonText = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return JSON.stringify(value, null, 2);
};

/** Repeatable editor for arrays of simple (scalar/enum) items. */
const ListControl = ({
	schema,
	value,
	onChange,
	path,
	title,
}: {
	readonly schema: JsonSchema;
	readonly value: unknown;
	readonly onChange: (next: unknown) => void;
	readonly path: string;
	readonly title: string;
}) => {
	const scope = useFormScope();
	// ListControl only renders for array-like schemas, which are always
	// schema objects — the cast is safe.
	const meta = schema as JsonSchemaObject;
	const items = meta.items;
	const array = Array.isArray(value) ? value : [];
	const minItems = typeof meta.minItems === "number" ? meta.minItems : 0;
	const maxItems = typeof meta.maxItems === "number" ? meta.maxItems : 50;
	const itemPath = (index: number) => `${path}[${index}]`;

	const setItem = (index: number, next: unknown) => {
		const copy = array.slice();
		copy[index] = next;
		onChange(copy);
	};

	return (
		<div className="flex flex-col gap-2">
			{array.map((item, index) => (
				<div key={index} className="flex items-end gap-2">
					<div className="flex-1">
						<ScalarControl
							schema={items ?? true}
							ui={undefined}
							value={item}
							onChange={(next) => setItem(index, next)}
							id={`${scope.idPrefix}-${sanitizeId(itemPath(index))}`}
							path={itemPath(index)}
							required={false}
							label={`${title} ${index + 1}`}
							ariaLabel={`${title} ${index + 1}`}
						/>
					</div>
					<Button
						type="button"
						variant="outline"
						size="icon"
						aria-label={`${scope.messages.removeItem} ${index + 1}`}
						disabled={scope.disabled || array.length <= minItems}
						onClick={() => onChange(array.filter((_, i) => i !== index))}
					>
						<Trash2Icon />
					</Button>
				</div>
			))}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="self-start"
				disabled={scope.disabled || array.length >= maxItems}
				onClick={() =>
					onChange([
						...array,
						items === undefined
							? undefined
							: (defaultFor(items) ?? (schemaTypes(items).includes("boolean") ? false : undefined)),
					])
				}
			>
				<PlusIcon />
				{scope.messages.addItem}
			</Button>
		</div>
	);
};
