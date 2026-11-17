/**
 * TypeScript types for the `@ktb/json-schema` subset profile — see
 * PROFILE.md for the normative keyword list and limits. These types
 * describe exactly what `checkSchema` accepts: consumers get compile-
 * time checking for the subset while the runtime checker stays the
 * source of truth for untyped/JSON-carried schemas.
 */

/** The seven JSON Schema primitive types (draft 2020-12). */
export type JsonSchemaTypeName =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "null"
	| "object"
	| "array";

/**
 * A schema in the subset: either a boolean (`true` accepts anything,
 * `false` accepts nothing) or a schema object carrying only the
 * documented keywords. All members are optional — `{}` is the
 * "anything" schema.
 */
export type JsonSchema = boolean | JsonSchemaObject;

export interface JsonSchemaObject {
	/** Recommended: "https://json-schema.org/draft/2020-12/schema".
	 * Accepted but not enforced — the subset IS 2020-12. */
	readonly $schema?: string;
	/** Internal JSON pointer only ("#/..."), never remote, never
	 * recursive — see PROFILE.md. */
	readonly $ref?: string;
	readonly type?: JsonSchemaTypeName | readonly JsonSchemaTypeName[];
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: JsonSchema;
	readonly items?: JsonSchema;
	readonly enum?: readonly unknown[];
	readonly const?: unknown;
	readonly pattern?: string;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly minProperties?: number;
	readonly maxProperties?: number;
	readonly allOf?: readonly JsonSchema[];
	readonly anyOf?: readonly JsonSchema[];
	readonly oneOf?: readonly JsonSchema[];
	readonly not?: JsonSchema;
	// Annotations — carried for consumers (forms render them), ignored
	// by validation.
	readonly title?: string;
	readonly description?: string;
	readonly default?: unknown;
	readonly $comment?: string;
}
