import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, desc, eq, ne } from "drizzle-orm";

import { assertSchema, compileSchema, SchemaDefinitionError } from "@ktb/json-schema";
import type { ValidationIssue } from "@ktb/json-schema";
import { Forbidden } from "@ktb/authz";
import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";

import { schemas, type SchemaRow } from "./schema.ts";

export type { SchemaRow } from "./schema.ts";

/**
 * Schemas domain service: DB-backed JSON-Schema (draft-2020-12 subset)
 * registry edited through the /platform/schemas console. Admin methods
 * re-check the `PlatformAdmin` gate inside the service (defense in
 * depth — the panel guard and the server fns gate too); `getById` and
 * `validate` are public reads used by other plugins (e.g. the pages
 * plugin validating search params) — they need no principal.
 */

/** `adminUpdate`/`adminRemove` targeted a missing row. */
export class SchemaNotFound extends Data.TaggedError("SchemaNotFound")<{
	readonly id: number;
}> {}

/** `adminCreate`/`adminUpdate` received a `schema` payload that is not
 * valid JSON or falls outside the `@ktb/json-schema` subset — the
 * rejected input is carried for debugging. */
export class InvalidSchema extends Data.TaggedError("InvalidSchema")<{
	readonly schema: string;
}> {}

/** `adminCreate`/`adminUpdate` received a blank `name`. */
export class InvalidSchemaName extends Data.TaggedError("InvalidSchemaName")<{
	readonly name: string;
}> {}

/** `name` is already registered to a different row. */
export class SchemaNameTaken extends Data.TaggedError("SchemaNameTaken")<{
	readonly name: string;
}> {}

export type SchemaError =
	| Forbidden
	| SchemaNotFound
	| InvalidSchema
	| InvalidSchemaName
	| SchemaNameTaken;

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

/** Seed written by `adminCreate` when no schema text is supplied —
 * the permissive "anything" schema. */
const EMPTY_SCHEMA = "{}";

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

/** `description` wire values: absent stays untouched on update, a
 * blank/whitespace string clears the column (stored as NULL). */
const toDescription = (value: string | undefined): string | null | undefined => {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
};

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

/** Normalize a write input's schema text: undefined stays undefined
 * (unchanged on update / default on create), anything else must be
 * storable JSON or the write fails `InvalidSchema`. */
const checkedSchema = (
	json: string | undefined,
): Effect.Effect<string | undefined, InvalidSchema> =>
	json !== undefined && !isStorableSchema(json)
		? Effect.fail(new InvalidSchema({ schema: json }))
		: Effect.succeed(json);

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
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;

		const requireAdmin = platformAdmin.requireAdmin();

		const byId = (id: number) => eq(schemas.id, id);

		/** First row matching `name`, optionally excluding `excludeId`
		 * (update path — the row's own name is not a conflict). */
		const findByName = (name: string, excludeId?: number) =>
			db
				.select({ id: schemas.id })
				.from(schemas)
				.where(
					excludeId === undefined
						? eq(schemas.name, name)
						: and(eq(schemas.name, name), ne(schemas.id, excludeId)),
				)
				.limit(1);

		return Schemas.of({
			adminList: Effect.fn("Schemas.adminList")(function* () {
				yield* requireAdmin;
				return yield* Effect.promise(() =>
					db
						.select({
							id: schemas.id,
							name: schemas.name,
							description: schemas.description,
							createdAt: schemas.createdAt,
							updatedAt: schemas.updatedAt,
						})
						.from(schemas)
						.orderBy(desc(schemas.updatedAt)),
				);
			}),
			adminGet: Effect.fn("Schemas.adminGet")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(schemas).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
			adminCreate: Effect.fn("Schemas.adminCreate")(function* (input: {
				readonly name: string;
				readonly description?: string;
				readonly schema?: string;
			}) {
				yield* requireAdmin;
				const name = input.name.trim();
				if (name === "") return yield* new InvalidSchemaName({ name: input.name });
				const schemaJson = yield* checkedSchema(input.schema);
				const taken = yield* Effect.promise(() => findByName(name));
				if (taken.length > 0) return yield* new SchemaNameTaken({ name });
				const now = new Date();
				const rows = yield* Effect.promise(() =>
					db
						.insert(schemas)
						.values({
							name,
							description: toDescription(input.description) ?? null,
							schema: schemaJson ?? EMPTY_SCHEMA,
							createdAt: now,
							updatedAt: now,
						})
						.returning(),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
			adminUpdate: Effect.fn("Schemas.adminUpdate")(function* (
				id: number,
				input: {
					readonly name?: string;
					readonly description?: string;
					readonly schema?: string;
				},
			) {
				yield* requireAdmin;
				let name: string | undefined;
				if (input.name !== undefined) {
					const trimmed = input.name.trim();
					if (trimmed === "") return yield* new InvalidSchemaName({ name: input.name });
					const taken = yield* Effect.promise(() => findByName(trimmed, id));
					if (taken.length > 0) return yield* new SchemaNameTaken({ name: trimmed });
					name = trimmed;
				}
				const schemaJson = yield* checkedSchema(input.schema);
				const description = toDescription(input.description);
				const set: {
					name?: string;
					description?: string | null;
					schema?: string;
					updatedAt: Date;
				} = { updatedAt: new Date() };
				if (name !== undefined) set.name = name;
				if (description !== undefined) set.description = description;
				if (schemaJson !== undefined) set.schema = schemaJson;
				const rows = yield* Effect.promise(() =>
					db.update(schemas).set(set).where(byId(id)).returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new SchemaNotFound({ id });
				return toDoc(row);
			}),
			adminRemove: Effect.fn("Schemas.adminRemove")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.delete(schemas).where(byId(id)).returning({ id: schemas.id }),
				);
				if (rows.length === 0) return yield* new SchemaNotFound({ id });
			}),
			getById: Effect.fn("Schemas.getById")(function* (id: number) {
				const rows = yield* Effect.promise(() =>
					db.select().from(schemas).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
			validate: Effect.fn("Schemas.validate")(function* (schemaId: number, data: unknown) {
				const rows = yield* Effect.promise(() =>
					db.select().from(schemas).where(byId(schemaId)).limit(1),
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

/**
 * Test-only DDL mirroring the `schemas` migration — re-exported for
 * sibling test files (same convention as `RICH_TEXT_TEST_DDL` in
 * plugins/rich-text). Never used by production code.
 */
export const SCHEMAS_TEST_DDL = `
CREATE TABLE schemas (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	description TEXT,
	schema TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX schemas_updated_idx ON schemas (updated_at);
`;
