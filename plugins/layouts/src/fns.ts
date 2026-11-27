import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { asAdmin, orHandled } from "@ktb/admin-store";
import { pluginHandler, run, sessionHandler } from "@ktb/server-fns";
import { PluginStates } from "@ktb/platform/plugin-states";

import { Layouts, type LayoutDoc, type LayoutMeta } from "./service.ts";

// Layouts server functions: admin CRUD is PlatformAdmin-gated (the
// /platform layout already 404s non-admins; the service re-checks
// inside runAs — defense in depth, same pattern as the schemas and
// rich-text plugins). The public `layoutDocFn` is session-optional:
// anonymous app pages may resolve stored layouts through the pages
// plugin, and the owning plugin's enabled state is checked via
// PluginStates so a disabled plugin can't leak content. Handled domain
// failures (Forbidden / LayoutNotFound / InvalidLayoutConfig /
// InvalidLayoutName / LayoutNameTaken) collapse to null/false/[] — the
// same "not visible / not saved" contract the other plugin fns use;
// other errors still propagate.

/** Serializable layout document — `config` is the raw JSON text and
 * `updatedAt` an ISO string so list UIs can format it client-side. */
export interface LayoutDocWire {
	readonly id: number;
	readonly name: string;
	readonly description: string | null;
	readonly config: string;
	readonly sectionCount: number;
	readonly updatedAt: string;
	/** Versioned Puck document (PL-014) — null while the layout uses
	 * the legacy section-slot `config`. */
	readonly builderJson: string | null;
}

/** List row for consumers that only need identity + freshness. */
export interface LayoutMetaWire {
	readonly id: number;
	readonly name: string;
	readonly description: string | null;
	readonly sectionCount: number;
	readonly updatedAt: string;
}

const toDocWire = (row: LayoutDoc): LayoutDocWire => ({
	id: row.id,
	name: row.name,
	description: row.description,
	config: row.config,
	sectionCount: row.sectionCount,
	updatedAt: row.updatedAt.toISOString(),
	builderJson: row.builderJson,
});

const toMetaWire = (row: LayoutMeta): LayoutMetaWire => ({
	id: row.id,
	name: row.name,
	description: row.description,
	sectionCount: row.sectionCount,
	updatedAt: row.updatedAt.toISOString(),
});

const CreateInput = Schema.Struct({
	name: Schema.NonEmptyString,
	description: Schema.optionalKey(Schema.String),
	config: Schema.optionalKey(Schema.String),
});
const UpdateInput = Schema.Struct({
	id: Schema.Number,
	name: Schema.optionalKey(Schema.NonEmptyString),
	description: Schema.optionalKey(Schema.String),
	config: Schema.optionalKey(Schema.String),
});
const IdInput = Schema.Struct({ id: Schema.Number });

const decodeCreate = Schema.decodeUnknownSync(CreateInput);
const decodeUpdate = Schema.decodeUnknownSync(UpdateInput);
const decodeId = Schema.decodeUnknownSync(IdInput);

const HANDLED_TAGS = [
	"Forbidden",
	"LayoutNotFound",
	"InvalidLayoutConfig",
	"InvalidLayoutName",
	"LayoutNameTaken",
] as const;

/** Create a layout (empty section list by default); `null` for
 * non-admins and handled domain failures. */
export const createLayoutFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreate(input))
	.handler(
		pluginHandler(
			"layouts.panel",
			sessionHandler(async ({ data, user }): Promise<LayoutDocWire | null> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const layouts = yield* Layouts;
						const row = yield* layouts.adminCreate(data);
						return row === null ? null : toDocWire(row);
					}),
				).catch(orHandled(HANDLED_TAGS, null));
			}),
		),
	);

/** Update a layout's name/description/config; `null` for non-admins,
 * missing rows, invalid config JSON, name conflicts and other handled
 * failures. */
export const updateLayoutFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdate(input))
	.handler(
		pluginHandler(
			"layouts.panel",
			sessionHandler(async ({ data, user }): Promise<LayoutDocWire | null> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const layouts = yield* Layouts;
						const { id, ...input } = data;
						return toDocWire(yield* layouts.adminUpdate(id, input));
					}),
				).catch(orHandled(HANDLED_TAGS, null));
			}),
		),
	);

/** Delete a layout by id; `false` for non-admins and missing rows. */
export const deleteLayoutFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeId(input))
	.handler(
		pluginHandler(
			"layouts.panel",
			sessionHandler(async ({ data, user }): Promise<boolean> => {
				return asAdmin(
					user,
					Effect.gen(function* () {
						const layouts = yield* Layouts;
						yield* layouts.adminRemove(data.id);
						return true;
					}),
				).catch(orHandled(HANDLED_TAGS, false));
			}),
		),
	);

/** Admin layout list for pickers — id/name/description/sectionCount/
 * updatedAt only, no config payload. Handled failures collapse to an
 * empty list. */
export const listLayoutsFn = createServerFn({ method: "GET" }).handler(
	pluginHandler(
		"layouts.panel",
		sessionHandler(async ({ user }): Promise<readonly LayoutMetaWire[]> => {
			return asAdmin(
				user,
				Effect.gen(function* () {
					const layouts = yield* Layouts;
					const rows = yield* layouts.adminList();
					return rows.map(toMetaWire);
				}),
			).catch(orHandled(HANDLED_TAGS, [] as readonly LayoutMetaWire[]));
		}),
	),
);

/** Public layout read by id — session-optional (anonymous app pages
 * may resolve stored layouts). Returns null when the plugin is
 * disabled or the row is missing. */
export const layoutDocFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data }): Promise<LayoutDocWire | null> => {
		const enabled = await run(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				return yield* states.isEnabled("layouts.panel");
			}),
		);
		if (!enabled) return null;
		return run(
			Effect.gen(function* () {
				const layouts = yield* Layouts;
				const row = yield* layouts.getById(data.id);
				return row === null ? null : toDocWire(row);
			}),
		);
	});
