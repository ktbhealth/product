import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { assertSchema, compileSchema, SchemaDefinitionError } from "@ktb/json-schema";
import type { ValidationIssue } from "@ktb/json-schema";
import { Forbidden } from "@ktb/authz";
import { defineAdminStore } from "@ktb/admin-store";

import { schemas, type SchemaRow } from "./schema.ts";

export type { SchemaRow } from "./schema.ts";

/**
 * Schemas domain service: DB-backed JSON-Schema (draft-2020-12 subset)
 * registry edited through the /platform/schemas console. Admin methods
 * re-check the `PlatformAdmin` gate inside the service (defense in
 * depth — the panel guard and the server fns gate too); `getById` and
 * `validate` are public reads used by other plugins (e.g. the pages
 * plugin validating search params) — they need no principal.
 *
 * The CRUD core (list/get/create/update/remove + the name natural
 * key) comes from `@ktb/admin-store`'s `defineAdminStore`; this module
 * keeps the schema-payload contract (`isStorableSchema`), the
 * `validate` public read and the plugin's error tags.
 */

/** Admin-facing row without the schema payload — list endpoints. */
export interface SchemaMeta {
	readonly id: number;
	readonly name: string;
	readonly description: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** Full registry entry: meta plus the stored schema JSON text. */
export interface SchemaDoc extends SchemaMeta {
	readonly schema: string;
}

/** Result of {@link Schemas.validate} — `issues` is empty iff `valid`. */
export interface SchemaValidationResult {
	readonly valid: boolean;
	readonly issues: readonly ValidationIssue[];
}

const toMeta = (row: SchemaRow): SchemaMeta => ({
	id: row.id,
	name: row.name,
	description: row.description,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const toDoc = (row: SchemaRow): SchemaDoc => ({
	...toMeta(row),
	schema: row.schema,
});

/** True when `json` parses and conforms to the `@ktb/json-schema`
 * subset — the gate every stored schema passes through on write. */
const isStorableSchema = (json: string): boolean => {
	try {
		const parsed: unknown = JSON.parse(json);
		assertSchema(parsed);
		return true;
	} catch {
		return false;
	}
};

const store = defineAdminStore({
	serviceName: "Schemas",
	payloadField: "schema",
	defaultPayload: "{}",
	table: schemas,
	columns: { id: schemas.id, name: schemas.name, updatedAt: schemas.updatedAt },
	errors: {
		notFound: "SchemaNotFound",
		invalidName: "InvalidSchemaName",
		nameTaken: "SchemaNameTaken",
		invalidPayload: "InvalidSchema",
	},
	toMeta,
	toDoc,
	validatePayload: isStorableSchema,
	naturalKey: {
		columns: [schemas.name],
		values: (name) => [name],
	},
});

/** `adminUpdate`/`adminRemove` targeted a missing row. */
export const SchemaNotFound = store.errors.notFound;
export type SchemaNotFound = InstanceType<typeof SchemaNotFound>;

/** `adminCreate`/`adminUpdate` received a `schema` payload that is not
 * valid JSON or falls outside the `@ktb/json-schema` subset — the
 * rejected input is carried for debugging. */
export const InvalidSchema = store.errors.invalidPayload;
export type InvalidSchema = InstanceType<typeof InvalidSchema>;

/** `adminCreate`/`adminUpdate` received a blank `name`. */
export const InvalidSchemaName = store.errors.invalidName;
export type InvalidSchemaName = InstanceType<typeof InvalidSchemaName>;

/** `name` is already registered to a different row. */
export const SchemaNameTaken = store.errors.nameTaken;
export type SchemaNameTaken = InstanceType<typeof SchemaNameTaken>;

export type SchemaError =
	| Forbidden
	| SchemaNotFound
	| InvalidSchema
	| InvalidSchemaName
	| SchemaNameTaken;

export class Schemas extends Context.Service<
	Schemas,
	{
		/** Every schema, most recently updated first — meta only. */
		readonly adminList: () => Effect.Effect<readonly SchemaMeta[], Forbidden>;
		/** One schema by id (raw JSON text); null when missing. */
		readonly adminGet: (id: number) => Effect.Effect<SchemaDoc | null, SchemaError>;
		/** Insert a schema; `schema` defaults to `{}`. `null` when the
		 * insert returning comes back empty. */
		readonly adminCreate: (input: {
			readonly name: string;
			readonly description?: string;
			readonly schema?: string;
		}) => Effect.Effect<SchemaDoc | null, SchemaError>;
		/** Update name/description/schema by id; `InvalidSchema` when a
		 * supplied `schema` is not storable subset JSON,
		 * `InvalidSchemaName` on a blank name, `SchemaNameTaken` on a
		 * duplicate, `SchemaNotFound` when the row is missing. */
		readonly adminUpdate: (
			id: number,
			input: {
				readonly name?: string;
				readonly description?: string;
				readonly schema?: string;
			},
		) => Effect.Effect<SchemaDoc, SchemaError>;
		/** Delete a schema by id; `SchemaNotFound` when missing. */
		readonly adminRemove: (id: number) => Effect.Effect<void, SchemaError>;
		/** Public read by id — no admin gate (anonymous consumers may
		 * resolve schemas); null when missing. */
		readonly getById: (id: number) => Effect.Effect<SchemaDoc | null>;
		/** Validate `data` against the stored schema. Infallible: a
		 * missing row, unparseable stored JSON or an out-of-subset
		 * schema all resolve to `{ valid: false, issues: […] }` so
		 * consumers never have to special-case definition problems. */
		readonly validate: (schemaId: number, data: unknown) => Effect.Effect<SchemaValidationResult>;
	}
>()("@ktb/schemas/Schemas") {}

export const SchemasLive = Layer.effect(
	Schemas,
	Effect.gen(function* () {
		const { methods, helpers } = yield* store.build;

		return Schemas.of({
			...methods,
			validate: Effect.fn("Schemas.validate")(function* (schemaId: number, data: unknown) {
				const rows = yield* Effect.promise(() =>
					helpers.db.select().from(schemas).where(helpers.byId(schemaId)).limit(1),
				);
				const row = rows[0];
				if (row === undefined) {
					return {
						valid: false,
						issues: [
							{
								path: "$",
								keyword: "schema",
								message: `schema ${schemaId} not found`,
							},
						],
					} satisfies SchemaValidationResult;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(row.schema);
				} catch {
					return {
						valid: false,
						issues: [
							{
								path: "$",
								keyword: "schema",
								message: "stored schema is not valid JSON",
							},
						],
					} satisfies SchemaValidationResult;
				}
				try {
					const issues = compileSchema(parsed).validate(data);
					return { valid: issues.length === 0, issues } satisfies SchemaValidationResult;
				} catch (error) {
					// Out-of-subset stored schemas surface their definition
					// issues verbatim — same {path, keyword, message} shape.
					/* v8 ignore next -- assertSchema runs before ajv, so
					 * the only throw reachable here is SchemaDefinitionError */
					if (error instanceof SchemaDefinitionError) {
						return { valid: false, issues: error.issues } satisfies SchemaValidationResult;
					}
					/* v8 ignore next -- ajv compile errors outside the
					 * subset contract are defects, not data issues */
					throw error;
				}
			}),
		});
	}),
);
