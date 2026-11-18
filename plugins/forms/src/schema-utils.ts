import type { JsonSchema, JsonSchemaObject, ValidationIssue } from "@ktb/json-schema";

import type { FormFieldUi } from "./definition.ts";

/**
 * Pure schema→UI helpers for the SchemaForm renderer. Everything here
 * is synchronous and side-effect free so the widget-inference and
 * value-shaping rules stay unit-testable without a DOM.
 */

const COMBINATORS = ["allOf", "anyOf", "oneOf", "not"] as const;

/** True for schema objects (vs boolean schemas). */
export const isSchemaObject = (schema: JsonSchema): schema is JsonSchemaObject =>
	typeof schema === "object" && schema !== null;

/** Object-shaped schema: explicit object type or declared properties. */
export const isObjectLike = (schema: JsonSchema): boolean =>
	isSchemaObject(schema) &&
	(schemaTypes(schema).includes("object") || hasOwn(schema, "properties"));

/** Array-typed schema. */
export const isArrayLike = (schema: JsonSchema): boolean =>
	isSchemaObject(schema) && schemaTypes(schema).includes("array");

/** Normalized `type` list — boolean schemas and absent types yield []. */
export const schemaTypes = (schema: JsonSchema): readonly string[] => {
	if (!isSchemaObject(schema)) return [];
	const { type } = schema;
	if (type === undefined) return [];
	// `type` is `Name | readonly Name[]` — typeof narrows the readonly
	// array case that Array.isArray misses.
	return typeof type === "string" ? [type] : [...type];
};

const hasOwn = (schema: JsonSchemaObject, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(schema, key);

/** True when the schema needs JSON-level (non-scalar) editing: a $ref
 * the renderer cannot resolve locally, a combinator, or a nested
 * object/array type. */
export const isComplexSchema = (schema: JsonSchema): boolean => {
	if (!isSchemaObject(schema)) return true;
	if (hasOwn(schema, "$ref")) return true;
	if (COMBINATORS.some((key) => hasOwn(schema, key))) return true;
	const types = schemaTypes(schema);
	return types.includes("object") || types.includes("array") || hasOwn(schema, "properties");
};

/**
 * Whether an array's `items` schema can use the repeatable "list"
 * widget (one scalar control per element). Objects, arrays,
 * combinators and $refs inside items fall back to the json widget.
 */
export const isSimpleItemSchema = (schema: JsonSchema | undefined): boolean => {
	if (schema === undefined || !isSchemaObject(schema)) return false;
	if (isComplexSchema(schema)) return false;
	// A bare {} or annotation-only schema still edits fine as text.
	return true;
};

/**
 * Pick the widget for a field when `ui.widget` doesn't force one.
 * Order: explicit enum/const → select; boolean → checkbox; number →
 * number; string → input; simple-items array → list; object →
 * nested fieldset; everything else (combinators, $ref, untyped,
 * complex arrays) → json.
 */
export const inferWidget = (schema: JsonSchema, ui?: FormFieldUi): FormFieldUi["widget"] => {
	if (ui?.widget !== undefined) return ui.widget;
	if (!isSchemaObject(schema)) return "json";
	if (hasOwn(schema, "enum") || hasOwn(schema, "const")) return "select";
	const types = schemaTypes(schema);
	if (types.includes("boolean")) return "checkbox";
	if (types.includes("number") || types.includes("integer")) return "number";
	if (types.includes("string")) return "input";
	if (types.includes("array")) {
		return isSimpleItemSchema(schema.items) ? "list" : "json";
	}
	if (types.includes("object") || hasOwn(schema, "properties")) return "object";
	return "json";
};

/** JSON.stringify that never returns undefined (option values must
 * always encode to a string; `undefined` isn't valid JSON anyway). */
export const encodeOption = (value: unknown): string => {
	const encoded = JSON.stringify(value);
	return encoded === undefined ? "null" : encoded;
};

/** Decode an {@link encodeOption} string back to its JSON value. */
export const decodeOption = (encoded: string): unknown => JSON.parse(encoded) as unknown;

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Human-readable option text: ui-provided label wins, else a
 * stringified scalar (objects fall back to compact JSON). */
export const optionLabel = (value: unknown, ui?: FormFieldUi): string => {
	const match = ui?.options?.find((option) => jsonEqual(option.value, value));
	if (match !== undefined) return match.label;
	if (typeof value === "string") return value;
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return JSON.stringify(value) ?? "";
};

/**
 * The selectable values for select/radio widgets: ui.options first,
 * then `enum`, then a single `const`. Returns null when the schema
 * offers no discrete choices (caller falls back to a text widget).
 */
export const optionValues = (schema: JsonSchema, ui?: FormFieldUi): readonly unknown[] | null => {
	if (ui?.options !== undefined) return ui.options.map((option) => option.value);
	if (!isSchemaObject(schema)) return null;
	if (Array.isArray(schema.enum)) return schema.enum;
	if (hasOwn(schema, "const")) return [schema.const];
	return null;
};

/** String form of a field value for text-like controls; nullish → "". */
export const displayString = (value: unknown): string => {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	// JSON.stringify only yields undefined for non-JSON values
	// (functions/symbols), which cannot appear here.
	return JSON.stringify(value) as string;
};

/** DOM-id-safe fragment for a field path ("address.street[0]" →
 * "address-street-0"). */
export const sanitizeId = (path: string): string =>
	path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Initial value for a schema: `default` wins at every level; object
 * schemas without a default assemble one from their properties'
 * defaults (empty object when nothing declares one). Arrays and
 * scalars without defaults yield undefined — omitted by callers.
 */
export const defaultFor = (schema: JsonSchema): unknown => {
	if (!isSchemaObject(schema)) return undefined;
	if (hasOwn(schema, "default")) return schema.default;
	const types = schemaTypes(schema);
	const objectish = types.includes("object") || hasOwn(schema, "properties");
	if (!objectish || schema.properties === undefined) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, sub] of Object.entries(schema.properties)) {
		const value = defaultFor(sub);
		if (value !== undefined) out[key] = value;
	}
	return out;
};

/** Initial form value: every top-level property's default, assembled
 * like {@link defaultFor} but always returning an object (a form's
 * value IS an object). */
export const initialValueFromSchema = (schema: JsonSchemaObject): Record<string, unknown> => {
	const value = defaultFor(schema);
	return isRecord(value) ? value : {};
};

/**
 * Drop keys that must not reach validation: `undefined` everywhere,
 * and "" for NON-required object properties (an untouched optional
 * text input shouldn't fail `pattern`/`minLength` it never filled).
 * Required keys keep "" so `required`-adjacent keywords still judge
 * them; arrays keep every element ("" inside a list is an explicit
 * entry, not an omission).
 */
export const pruneEmpty = (schema: JsonSchema, value: unknown): unknown => {
	if (!isSchemaObject(schema)) return value;
	const types = schemaTypes(schema);
	const objectish = types.includes("object") || hasOwn(schema, "properties");
	if (objectish && isRecord(value)) {
		const properties = schema.properties;
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry === undefined) continue;
			const sub = properties?.[key];
			const isRequired = required.has(key);
			if (entry === "" && sub !== undefined && !isRequired) continue;
			out[key] = sub === undefined ? entry : pruneEmpty(sub, entry);
		}
		return out;
	}
	if (types.includes("array") && Array.isArray(value) && schema.items !== undefined) {
		return value.map((entry) => pruneEmpty(schema.items as JsonSchema, entry));
	}
	return value;
};

/** Issues belonging to a field path: exact match or anything nested
 * beneath it ("a" catches "a.b" and "a[0]"). */
export const issuesForPath = (
	issues: readonly ValidationIssue[],
	path: string,
): readonly ValidationIssue[] =>
	issues.filter(
		(issue) =>
			issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`),
	);

/** ajv reports `required` violations on the PARENT object ("$" or
 * "address"), naming the missing key only inside `message`
 * ("must have required property 'zip'") — the message template is
 * pinned by the ajv version @ktb/json-schema compiles with. */
const REQUIRED_MESSAGE = /^must have required property '([^']+)'$/;

/** The missing property name of a `required` issue, else undefined. */
export const missingRequiredProperty = (issue: ValidationIssue): string | undefined => {
	if (issue.keyword !== "required") return undefined;
	return REQUIRED_MESSAGE.exec(issue.message)?.[1];
};

/** Split a field path into parent display path + leaf key:
 * "address.zip" → { parent: "address", key: "zip" },
 * "name" → { parent: "$", key: "name" } (root issues live at "$"). */
export const splitFieldPath = (path: string): { parent: string; key: string } => {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return { parent: "$", key: path };
	return { parent: path.slice(0, dot), key: path.slice(dot + 1) };
};

/**
 * Issues attributable to ONE field: path-descendants via
 * {@link issuesForPath} plus `required` violations ajv reports on the
 * parent object but which name this field's key.
 */
export const issuesForField = (
	issues: readonly ValidationIssue[],
	path: string,
): readonly ValidationIssue[] => {
	const direct = issuesForPath(issues, path);
	const { parent, key } = splitFieldPath(path);
	const required = issues.filter(
		(issue) => issue.path === parent && missingRequiredProperty(issue) === key,
	);
	return required.length === 0 ? direct : [...direct, ...required];
};

/**
 * Issues for an OBJECT node's own error area: exact-path violations
 * (minus `required` issues that name one of its children — those
 * render on the child fields) plus the `required` violation naming
 * THIS field from its parent. Descendant-path issues are excluded —
 * children display them.
 */
export const issuesForObjectNode = (
	issues: readonly ValidationIssue[],
	path: string,
	name: string,
): readonly ValidationIssue[] => {
	const { parent } = splitFieldPath(path);
	return issues.filter((issue) => {
		if (issue.keyword === "required") {
			// Only the violation naming THIS field (reported on the
			// parent) belongs to the node — child `required` issues
			// (same path, different missingProperty) render below.
			return missingRequiredProperty(issue) === name && issue.path === parent;
		}
		return issue.path === path;
	});
};

/** Issues no rendered field claims — root ("$") violations and paths
 * outside `properties` (e.g. additionalProperties failures). Shown in
 * the form-level summary so they aren't silently dropped. Uses
 * {@link issuesForField} so parent-reported `required` issues count
 * as claimed by their field. */
export const unmatchedIssues = (
	issues: readonly ValidationIssue[],
	fieldPaths: readonly string[],
): readonly ValidationIssue[] =>
	issues.filter((issue) => !fieldPaths.some((path) => issuesForField([issue], path).length > 0));

/** Immutable set at a segment path (["a", 0, "b"]) — returns a new
 * object/array chain; untouched siblings keep identity. */
export const setIn = (
	value: unknown,
	segments: readonly (string | number)[],
	next: unknown,
): unknown => {
	if (segments.length === 0) return next;
	const [head, ...rest] = segments;
	if (typeof head === "number") {
		const array = Array.isArray(value) ? value : [];
		const copy = array.slice();
		copy[head] = setIn(copy[head], rest, next);
		return copy;
	}
	const object = isRecord(value) ? value : {};
	return { ...object, [head as string]: setIn(object[head as string], rest, next) };
};

/** Read at a segment path; undefined for missing/non-traversable. */
export const getIn = (value: unknown, segments: readonly (string | number)[]): unknown => {
	let current = value;
	for (const segment of segments) {
		if (typeof segment === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[segment];
		} else {
			if (!isRecord(current)) return undefined;
			current = current[segment];
		}
	}
	return current;
};
