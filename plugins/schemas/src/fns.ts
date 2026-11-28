import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { asAdmin, orHandled } from "@ktb/admin-store";
import { pluginHandler, run, sessionHandler } from "@ktb/server-fns";
import { PluginStates } from "@ktb/platform/plugin-states";

import {
	Schemas,
	type SchemaDoc,
	type SchemaMeta,
	type SchemaValidationResult,
} from "./service.ts";

// Schemas server functions: admin CRUD is PlatformAdmin-gated (the
// /platform layout already 404s non-admins; the service re-checks
// inside runAs — defense in depth, same pattern as the rich-text
// plugin). The public `schemaDocFn`/`validateSchemaFn` are
// session-optional: anonymous app pages may resolve and validate
// against stored schemas, and the owning plugin's enabled state is
// checked via PluginStates so a disabled plugin can't leak content.
// Handled domain failures (Forbidden / SchemaNotFound / InvalidSchema /
// InvalidSchemaName / SchemaNameTaken) collapse to null/false/[] — the
// same "not visible / not saved" contract the other plugin fns use;
// other errors still propagate.

/** Serializable schema document — `schema` is the raw JSON text and
 * `updatedAt` an ISO string so list UIs can format it client-side. */
export interface SchemaDocWire {
	readonly id: number;
	readonly name: string;
	readonly description: string | null;
	readonly schema: string;
	readonly updatedAt: string;
}

/** List row for consumers that only need identity + freshness. */
export interface SchemaMetaWire {
	readonly id: number;
	readonly name: string;
	readonly description: string | null;
	readonly updatedAt: string;
}

/** Wire shape of {@link SchemaValidationResult} — already plain JSON
 * (`{path, keyword, message}` issues). */
export type SchemaValidationWire = SchemaValidationResult;

const toDocWire = (row: SchemaDoc): SchemaDocWire => ({
	id: row.id,
	name: row.name,
	description: row.description,
	schema: row.schema,
	updatedAt: row.updatedAt.toISOString(),
});

const toMetaWire = (row: SchemaMeta): SchemaMetaWire => ({
	id: row.id,
	name: row.name,
	description: row.description,
	updatedAt: row.updatedAt.toISOString(),
});

const EMPTY_RESULT: SchemaValidationWire = { valid: false, issues: [] };

const CreateInput = Schema.Struct({
	name: Schema.NonEmptyString,
	description: Schema.optionalKey(Schema.String),
	schema: Schema.optionalKey(Schema.String),
});
const UpdateInput = Schema.Struct({
	id: Schema.Number,
	name: Schema.optionalKey(Schema.NonEmptyString),
	description: Schema.optionalKey(Schema.String),
	schema: Schema.optionalKey(Schema.String),
});
const IdInput = Schema.Struct({ id: Schema.Number });
const ValidateInput = Schema.Struct({
	schemaId: Schema.Number,
	data: Schema.Unknown,
});

const decodeCreate = Schema.decodeUnknownSync(CreateInput);
const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);
const decodeId = Schema.decodeUnknownSync(IdInput);
const decodeValidate = Schema.decodeUnknownSync(ValidateInput);

const HANDLED_TAGS = [
	"Forbidden",
	"SchemaNotFound",
	"InvalidSchema",
	"InvalidSchemaName",
	"SchemaNameTaken",
] as const;

/** Create a schema (defaults to `{}`, optional name/description);
 * `null` for non-admins and handled domain failures. */
export const createSchemaFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(
		pluginHandler(
			"schemas.panel",
			sessionHandler(async ({ data, user }): Promise<SchemaDocWire | null> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const schemas = yield* Schemas;
						const row = yield* schemas.adminCreate(data);
						return row === null ? null : toDocWire(row);
					}),
				).catch(orHandled(HANDLED_TAGS, null));
			}),
		),
	);

/** Update a schema's name/description/schema; `null` for non-admins,
 * missing rows, invalid schema JSON, name conflicts and other handled
 * failures. */
export const updateSchemaFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(
		pluginHandler(
			"schemas.panel",
			sessionHandler(async ({ data, user }): Promise<SchemaDocWire | null> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const schemas = yield* Schemas;
						const { id, ...input } = data;
						return toDocWire(yield* schemas.adminUpdate(id, input));
					}),
				).catch(orHandled(HANDLED_TAGS, null));
			}),
		),
	);

/** Delete a schema by id; `false` for non-admins and missing rows. */
export const deleteSchemaFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		pluginHandler(
			"schemas.panel",
			sessionHandler(async ({ data, user }): Promise<boolean> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const schemas = yield* Schemas;
						yield* schemas.adminRemove(data.id);
						return true;
					}),
				).catch(orHandled(HANDLED_TAGS, false));
			}),
		),
	);

/** Admin schema list for pickers — id/name/description/updatedAt
 * only, no schema payload. Handled failures collapse to an empty
 * list. */
export const listSchemasFn = createServerFn({ method: "GET" }).handler(
	pluginHandler(
		"schemas.panel",
		sessionHandler(async ({ user }): Promise<readonly SchemaMetaWire[]> => {
			return asAdmin(
				user,
				Effect.gen(function* () {
					const schemas = yield* Schemas;
					const rows = yield* schemas.adminList();
					return rows.map(toMetaWire);
				}),
			).catch(orHandled(HANDLED_TAGS, [] as readonly SchemaMetaWire[]));
		}),
	),
);

/** Public schema read by id — session-optional (anonymous app pages
 * may resolve stored schemas). Returns null when the plugin is
 * disabled or the row is missing. */
export const schemaDocFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<SchemaDocWire | null> => {
		const enabled = await run(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				return yield* states.isEnabled("schemas.panel");
			}),
		);
		if (!enabled) return null;
		return run(
			Effect.gen(function* () {
				const schemas = yield* Schemas;
				const row = yield* schemas.getById(data.id);
				return row === null ? null : toDocWire(row);
			}),
		);
	});

/** Validate `data` against a stored schema — session-optional like
 * `schemaDocFn`. Handled failures collapse to `{valid:false,issues:[]}`;
 * the service itself reports missing/malformed schemas as issues. */
export const validateSchemaFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeValidate(input))
	.handler(async ({ data }): Promise<SchemaValidationWire> => {
		const enabled = await run(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				return yield* states.isEnabled("schemas.panel");
			}),
		);
		if (!enabled) return EMPTY_RESULT;
		return run(
			Effect.gen(function* () {
				const schemas = yield* Schemas;
				return yield* schemas.validate(data.schemaId, data.data);
			}),
		).catch(orHandled(HANDLED_TAGS, EMPTY_RESULT));
	});
