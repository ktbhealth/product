import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { pluginHandler, run, runAs, sessionHandler } from "@ktb/server-fns";
import { PlatformAdmin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";

import {
	Templates,
	type TemplateDoc,
	type TemplateInstance,
	type TemplateMeta,
} from "./service.ts";

// Templates server functions: admin CRUD + instantiate are
// PlatformAdmin-gated (the /platform layout already 404s non-admins;
// the service re-checks inside runAs — defense in depth, same pattern
// as the schemas/layouts plugins). The public `templateDocFn` is
// session-optional: anonymous consumers may resolve stored templates,
// and the owning plugin's enabled state is checked via PluginStates so
// a disabled plugin can't leak content. Handled domain failures
// (Forbidden / TemplateNotFound / InvalidTemplateName /
// TemplateNameTaken / UnknownTemplateKind / InvalidTemplatePayload)
// collapse to null/false/[] — the same "not visible / not saved"
// contract the other plugin fns use; other errors still propagate.

/** JSON-safe wire value — template payloads/sources are opaque kind
 * JSON by contract (the service gates them with `isJsonSafe`), and the
 * server-fn serializability check rejects bare `unknown`. */
export type TemplateJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly TemplateJsonValue[]
	| { readonly [key: string]: TemplateJsonValue };

/** Serializable template meta — `payload` stays server-side on list
 * endpoints; `updatedAt`/`createdAt` are ISO strings so list UIs can
 * format them client-side. */
export interface TemplateMetaWire {
	readonly id: number;
	readonly kind: string;
	readonly name: string;
	readonly description: string | null;
	readonly createdBy: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Full template document — `payload` is the opaque kind JSON. */
export interface TemplateDocWire extends TemplateMetaWire {
	readonly payload: TemplateJsonValue;
}

/** Wire shape of {@link TemplateInstance} — `source` is the kind's
 * deserialized object, plain JSON by contract. */
export interface TemplateInstanceWire {
	readonly kind: string;
	readonly source: TemplateJsonValue;
}

const toMetaWire = (row: TemplateMeta): TemplateMetaWire => ({
	id: row.id,
	kind: row.kind,
	name: row.name,
	description: row.description,
	createdBy: row.createdBy,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString(),
});

const toDocWire = (row: TemplateDoc): TemplateDocWire => ({
	...toMetaWire(row),
	// Stored payloads passed the JSON-safety gate on write.
	payload: row.payload as TemplateJsonValue,
});

/** Run `eff` as the session user after the PlatformAdmin gate. */
const asAdmin = <A, E>(
	user: { readonly id: string; readonly email?: string },
	eff: Effect.Effect<A, E, unknown>,
): Promise<A> =>
	runAs(
		user,
		Effect.gen(function* () {
			const platformAdmin = yield* PlatformAdmin;
			yield* platformAdmin.requireAdmin();
			return yield* eff;
		}),
	);

const SaveInput = Schema.Struct({
	kind: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	description: Schema.optionalKey(Schema.String),
	source: Schema.optionalKey(Schema.Unknown),
	payload: Schema.optionalKey(Schema.Unknown),
});
const UpdateInput = Schema.Struct({
	id: Schema.Number,
	name: Schema.optionalKey(Schema.NonEmptyString),
	description: Schema.optionalKey(Schema.String),
	payload: Schema.optionalKey(Schema.Unknown),
});
const IdInput = Schema.Struct({ id: Schema.Number });

const decodeSave = Schema.decodeUnknownSync(SaveInput);
const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);
const decodeId = Schema.decodeUnknownSync(IdInput);

const HANDLED_TAGS = [
	"Forbidden",
	"TemplateNotFound",
	"InvalidTemplateName",
	"TemplateNameTaken",
	"UnknownTemplateKind",
	"InvalidTemplatePayload",
] as const;

const isHandled = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	(HANDLED_TAGS as readonly string[]).includes(String((error as { _tag?: unknown })._tag));

/** Save a template snapshot — `source` is serialized through the
 * kind's `serialize`, `payload` stored after `validate` (payload wins
 * when both are supplied); `null` for non-admins, unknown kinds,
 * invalid payloads, name conflicts and other handled failures. */
export const saveTemplateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeSave(input))
	.handler(
		pluginHandler(
			"templates.panel",
			sessionHandler(async ({ data, user }): Promise<TemplateDocWire | null> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const templates = yield* Templates;
						const row = yield* templates.save(data);
						return row === null ? null : toDocWire(row);
					}),
				).catch((error: unknown) => {
					if (isHandled(error)) return null;
					throw error;
				});
			}),
		),
	);

/** Update a template's name/description/payload; `null` for
 * non-admins, missing rows, unknown kinds, invalid payloads, name
 * conflicts and other handled failures. */
export const updateTemplateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(
		pluginHandler(
			"templates.panel",
			sessionHandler(async ({ data, user }): Promise<TemplateDocWire | null> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const templates = yield* Templates;
						const { id, ...input } = data;
						return toDocWire(yield* templates.adminUpdate(id, input));
					}),
				).catch((error: unknown) => {
					if (isHandled(error)) return null;
					throw error;
				});
			}),
		),
	);

/** Delete a template by id; `false` for non-admins and missing rows. */
export const deleteTemplateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		pluginHandler(
			"templates.panel",
			sessionHandler(async ({ data, user }): Promise<boolean> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const templates = yield* Templates;
						yield* templates.adminRemove(data.id);
						return true;
					}),
				).catch((error: unknown) => {
					if (isHandled(error)) return false;
					throw error;
				});
			}),
		),
	);

/** Instantiate a template: deserialize the stored payload into the
 * kind's source form. Admin-gated — the caller feeds `source` through
 * the owning plugin's own (also admin-gated) create path. `null` for
 * non-admins, missing rows and unregistered kinds. */
export const instantiateTemplateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		pluginHandler(
			"templates.panel",
			sessionHandler(async ({ data, user }): Promise<TemplateInstanceWire | null> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const templates = yield* Templates;
						const instance: TemplateInstance | null = yield* templates.instantiate(data.id);
						return instance === null
							? null
							: { kind: instance.kind, source: instance.source as TemplateJsonValue };
					}),
				).catch((error: unknown) => {
					if (isHandled(error)) return null;
					throw error;
				});
			}),
		),
	);

/** Admin template list for pickers — id/kind/name/description/
 * createdBy/timestamps only, no payload. Handled failures collapse to
 * an empty list. */
export const listTemplatesFn = createServerFn({ method: "GET" }).handler(
	pluginHandler(
		"templates.panel",
		sessionHandler(async ({ user }): Promise<readonly TemplateMetaWire[]> => {
			return asAdmin(
				user,
				Effect.gen(function* () {
					const templates = yield* Templates;
					const rows = yield* templates.adminList();
					return rows.map(toMetaWire);
				}),
			).catch((error: unknown) => {
				if (isHandled(error)) return [] as readonly TemplateMetaWire[];
				throw error;
			});
		}),
	),
);

/** Public template read by id — session-optional (anonymous consumers
 * may resolve stored templates). Returns null when the plugin is
 * disabled or the row is missing. */
export const templateDocFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<TemplateDocWire | null> => {
		const enabled = await run(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				return yield* states.isEnabled("templates.panel");
			}),
		);
		if (!enabled) return null;
		return run(
			Effect.gen(function* () {
				const templates = yield* Templates;
				const row = yield* templates.getById(data.id);
				return row === null ? null : toDocWire(row);
			}),
		);
	});
