import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { and, desc, eq, ne } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { Forbidden } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";
import { runAs } from "@ktb/server-fns";

/**
 * @ktb/admin-store — the shared admin-CRUD registry factory.
 *
 * A dozen platform plugins (`schemas`, `layouts`, `templates`, …) hand-
 * copied the same drizzle-backed registry service: an `id`/`name`/
 * `description`/JSON-`payload`/`createdAt`/`updatedAt` table, a
 * name-trim + blank check, an optional natural-key uniqueness probe, a
 * payload validation gate, and `adminList`/`adminGet`/`adminCreate`/
 * `adminUpdate`/`adminRemove`/`getById` methods that re-check the
 * `PlatformAdmin` gate inside the service (defense in depth — the panel
 * guard and the server fns gate too).
 *
 * `defineAdminStore` owns that boilerplate. The plugin keeps what is
 * genuinely its own: the drizzle table, the row→meta/doc mapping, the
 * payload contract, the error `_tag`s, any extra service methods, and
 * the `Context.Service` class + `Layer.effect` shell (server fns must
 * stay literal `createServerFn` chains at each call site — see
 * @ktb/server-fns `handlers.ts` — so this package cannot mint them).
 *
 * ```ts
 * const store = defineAdminStore({
 * 	serviceName: "Schemas",
 * 	payloadField: "schema",
 * 	defaultPayload: "{}",
 * 	table: schemas,
 * 	columns: { id: schemas.id, name: schemas.name, updatedAt: schemas.updatedAt },
 * 	errors: {
 * 		notFound: "SchemaNotFound",
 * 		invalidName: "InvalidSchemaName",
 * 		nameTaken: "SchemaNameTaken",
 * 		invalidPayload: "InvalidSchema",
 * 	},
 * 	toMeta: (row): SchemaMeta => ({ … }),
 * 	toDoc: (row): SchemaDoc => ({ …toMeta(row), schema: row.schema }),
 * 	validatePayload: (json) => isStorableSchema(json),
 * 	naturalKey: {
 * 		columns: [schemas.name],
 * 		values: (name) => [name],
 * 	},
 * });
 *
 * export const SchemasLive = Layer.effect(
 * 	Schemas,
 * 	Effect.gen(function* () {
 * 		const { methods, helpers } = yield* store.build;
 * 		return Schemas.of({ ...methods, validate: pluginExtras });
 * 	}),
 * );
 * ```
 *
 * Scope: text-JSON payload columns (`text()` holding JSON) with the
 * canonical name/description write contract. Plugins whose rows are
 * keyed differently (rich-text's `title`, pages' `path`, image's
 * upload metadata, ai-model's scoped catalog, templates' `(kind, name)`
 * + `unknown` payload) do not fit and keep their hand-written
 * services.
 */

/** Create-input contract every migrated store shares: required `name`,
 * optional `description`, optional payload under `payloadField`. */
export type AdminStoreCreateInput<TPayloadField extends string> = {
	readonly name: string;
	readonly description?: string;
} & { readonly [K in TPayloadField]?: string };

/** Update-input contract: every field optional (absent = unchanged). */
export type AdminStoreUpdateInput<TPayloadField extends string> = {
	readonly name?: string;
	readonly description?: string;
} & { readonly [K in TPayloadField]?: string };

/** Column refs the factory needs — `id` (row identity + delete
 * returning), `name` is only used when `naturalKey` covers it,
 * `updatedAt` drives list ordering and the update stamp. Extra columns
 * (payload, description, createdAt) are written by property name, the
 * same keys the plugins' tables already use. */
export interface AdminStoreColumns {
	readonly id: SQLWrapper;
	readonly name: SQLWrapper;
	readonly updatedAt: SQLWrapper;
}

/** Natural-key uniqueness contract: `columns` are probed with `eq`
 * against `values(name, input)`; `name` is the normalized (trimmed)
 * write name — `values` only runs on writes that set a name (every
 * create, renames on update), so `name` is always defined here.
 * Single-field keys (every current consumer) pass `[table.name]`;
 * composite keys can pass more columns but their values must be
 * derivable from `name`/the write input alone — keys that depend on
 * the stored row (e.g. templates' `kind`) need a pre-read and stay
 * hand-written. */
export interface AdminStoreNaturalKey<TInput = unknown> {
	readonly columns: readonly [SQLWrapper, ...SQLWrapper[]];
	readonly values: (name: string, input: TInput) => readonly unknown[] | undefined;
}

export interface AdminStoreConfig<
	TTable extends SQLiteTable,
	TDoc,
	TMeta,
	TPayloadField extends string,
	TNotFound extends string,
	TInvalidName extends string,
	TNameTaken extends string,
	TInvalidPayload extends string,
	TCreateInput extends AdminStoreCreateInput<TPayloadField>,
	TUpdateInput extends AdminStoreUpdateInput<TPayloadField>,
> {
	/** Span-name prefix for the generated methods — keep it identical
	 * to the old hand-written `Effect.fn("<Service>.<method>")` names
	 * (e.g. `"Schemas"`). */
	readonly serviceName: string;
	/** The plugin's drizzle table. */
	readonly table: TTable;
	/** id/name/updatedAt column refs — see {@link AdminStoreColumns}. */
	readonly columns: AdminStoreColumns;
	/** Wire/column/error key of the JSON payload field — `"schema"`,
	 * `"config"`, … Must match the table's property name and the
	 * create/update input field name. */
	readonly payloadField: TPayloadField;
	/** Stored when a create omits the payload (e.g. `"{}"`,
	 * `'{"sections":[]}'`). */
	readonly defaultPayload: string;
	/** `_tag`s for the four generated domain errors — keep them
	 * identical to the tags the hand-written classes carried so the
	 * fns' `HANDLED_TAGS` lists and tests keep working. */
	readonly errors: {
		readonly notFound: TNotFound;
		readonly invalidName: TInvalidName;
		readonly nameTaken: TNameTaken;
		readonly invalidPayload: TInvalidPayload;
	};
	/** Row → list-row mapping (drops the payload). */
	readonly toMeta: (row: TTable["$inferSelect"]) => TMeta;
	/** Row → full document mapping. */
	readonly toDoc: (row: TTable["$inferSelect"]) => TDoc;
	/** Write-path payload gate: receives the raw payload string and
	 * returns whether it is storable. Absent = accept everything.
	 * Runs only when the payload is supplied (never on `undefined`). */
	readonly validatePayload?: (value: string) => boolean;
	/** Optional natural-key uniqueness probe — see
	 * {@link AdminStoreNaturalKey}. */
	readonly naturalKey?: AdminStoreNaturalKey<TCreateInput | TUpdateInput>;
}

/** `description` wire values: absent stays untouched on update, a
 * blank/whitespace string clears the column (stored as NULL). */
const toDescription = (value: string | undefined): string | null | undefined => {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
};

/** The service methods every admin store shares — the shape plugins
 * spread into their `Context.Service` implementation. */
export interface AdminStoreMethods<
	TDoc,
	TMeta,
	TCreateInput,
	TUpdateInput,
	TNotFound extends { readonly _tag: string },
	TInvalidName extends { readonly _tag: string },
	TNameTaken extends { readonly _tag: string },
	TInvalidPayload extends { readonly _tag: string },
> {
	/** Every row, most recently updated first — meta only. */
	readonly adminList: () => Effect.Effect<readonly TMeta[], Forbidden>;
	/** One row by id (full doc); null when missing. */
	readonly adminGet: (
		id: number,
	) => Effect.Effect<
		TDoc | null,
		AdminStoreError<TNotFound, TInvalidName, TNameTaken, TInvalidPayload>
	>;
	/** Insert a row; `null` when the insert returning comes back
	 * empty. */
	readonly adminCreate: (
		input: TCreateInput,
	) => Effect.Effect<
		TDoc | null,
		AdminStoreError<TNotFound, TInvalidName, TNameTaken, TInvalidPayload>
	>;
	/** Update name/description/payload by id; `…NotFound` when the row
	 * is missing. */
	readonly adminUpdate: (
		id: number,
		input: TUpdateInput,
	) => Effect.Effect<TDoc, AdminStoreError<TNotFound, TInvalidName, TNameTaken, TInvalidPayload>>;
	/** Delete a row by id; `…NotFound` when missing. */
	readonly adminRemove: (
		id: number,
	) => Effect.Effect<void, AdminStoreError<TNotFound, TInvalidName, TNameTaken, TInvalidPayload>>;
	/** Public read by id — no admin gate; null when missing. */
	readonly getById: (id: number) => Effect.Effect<TDoc | null>;
}

/** Union of every error the generated admin methods can fail with. */
export type AdminStoreError<
	TNotFound extends { readonly _tag: string },
	TInvalidName extends { readonly _tag: string },
	TNameTaken extends { readonly _tag: string },
	TInvalidPayload extends { readonly _tag: string },
> = Forbidden | TNotFound | TInvalidName | TNameTaken | TInvalidPayload;

/** Services the generated methods close over — yielded by
 * {@link AdminStoreBuild.helpers} so plugin extras (single-column
 * writes, public reads, delete hooks) share the same db/guard/byId
 * the CRUD methods use. */
export interface AdminStoreHelpers {
	readonly db: DbClient;
	/** `platformAdmin.requireAdmin()` — re-check inside every admin
	 * method (defense in depth). */
	readonly requireAdmin: Effect.Effect<void, Forbidden>;
	/** `eq(idColumn, id)` where-clause for the store's table. */
	readonly byId: (id: number) => SQLWrapper;
}

/** What {@link AdminStoreBuild.build} yields inside the plugin's
 * `Layer.effect`: the shared CRUD `methods` to spread into the
 * service shape, plus `helpers` for plugin-specific extras. */
export interface AdminStoreBuild<
	TDoc,
	TMeta,
	TCreateInput,
	TUpdateInput,
	TNotFound extends { readonly _tag: string },
	TInvalidName extends { readonly _tag: string },
	TNameTaken extends { readonly _tag: string },
	TInvalidPayload extends { readonly _tag: string },
> {
	readonly methods: AdminStoreMethods<
		TDoc,
		TMeta,
		TCreateInput,
		TUpdateInput,
		TNotFound,
		TInvalidName,
		TNameTaken,
		TInvalidPayload
	>;
	readonly helpers: AdminStoreHelpers;
}

/**
 * Define an admin CRUD store. Returns the generated error classes and
 * `build` — an `Effect` (requiring `Db` + `PlatformAdmin`) that yields
 * the shared methods + helpers to spread into the plugin's own
 * `Context.Service` layer.
 */
export const defineAdminStore = <
	TTable extends SQLiteTable,
	TDoc,
	TMeta,
	TPayloadField extends string,
	TNotFound extends string,
	TInvalidName extends string,
	TNameTaken extends string,
	TInvalidPayload extends string,
	TCreateInput extends AdminStoreCreateInput<TPayloadField>,
	TUpdateInput extends AdminStoreUpdateInput<TPayloadField>,
>(
	config: AdminStoreConfig<
		TTable,
		TDoc,
		TMeta,
		TPayloadField,
		TNotFound,
		TInvalidName,
		TNameTaken,
		TInvalidPayload,
		TCreateInput,
		TUpdateInput
	>,
) => {
	const notFound = Data.TaggedError(config.errors.notFound)<{ readonly id: number }>;
	const invalidName = Data.TaggedError(config.errors.invalidName)<{ readonly name: string }>;
	const nameTaken = Data.TaggedError(config.errors.nameTaken)<{ readonly name: string }>;
	const invalidPayload = Data.TaggedError(config.errors.invalidPayload)<
		Record<TPayloadField, string>
	>;

	const build = Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		const requireAdmin = platformAdmin.requireAdmin();

		const byId = (id: number) => eq(config.columns.id, id);

		/** First row matching the natural-key values, optionally
		 * excluding `excludeId` (update path — the row's own key is
		 * not a conflict). */
		const findByKey = (values: readonly unknown[], excludeId?: number) =>
			Effect.promise(() => {
				const key = config.naturalKey;
				/* v8 ignore next -- callers only reach findByKey when
				 * config.naturalKey is defined */
				if (key === undefined) return Promise.resolve([] as never[]);
				const match = key.columns.map((column, index) => eq(column, values[index]));
				return db
					.select()
					.from(config.table)
					.where(
						excludeId === undefined
							? and(...match)
							: and(...match, ne(config.columns.id, excludeId)),
					)
					.limit(1);
			});

		/** Normalize a write input's payload: undefined stays
		 * undefined (unchanged on update / default on create), anything
		 * else must pass `validatePayload` or the write fails
		 * `…InvalidPayload`. */
		const checkedPayload = (
			input: AdminStoreUpdateInput<TPayloadField>,
		): Effect.Effect<string | undefined, InstanceType<typeof invalidPayload>> => {
			const value = input[config.payloadField];
			if (value === undefined) return Effect.succeed(undefined);
			if (config.validatePayload !== undefined && !config.validatePayload(value)) {
				return Effect.fail(
					// The mapped args type stays generic over TPayloadField
					// inside the factory body — the runtime shape is always
					// `{ [payloadField]: value }`.
					new invalidPayload({
						[config.payloadField]: value,
					} as never),
				);
			}
			return Effect.succeed(value);
		};

		const methods: AdminStoreMethods<
			TDoc,
			TMeta,
			TCreateInput,
			TUpdateInput,
			InstanceType<typeof notFound>,
			InstanceType<typeof invalidName>,
			InstanceType<typeof nameTaken>,
			InstanceType<typeof invalidPayload>
		> = {
			adminList: Effect.fn(`${config.serviceName}.adminList`)(function* () {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(config.table).orderBy(desc(config.columns.updatedAt)),
				);
				return rows.map(config.toMeta);
			}),
			adminGet: Effect.fn(`${config.serviceName}.adminGet`)(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(config.table).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : config.toDoc(row);
			}),
			adminCreate: Effect.fn(`${config.serviceName}.adminCreate`)(function* (input: TCreateInput) {
				yield* requireAdmin;
				const name = input.name.trim();
				if (name === "") return yield* new invalidName({ name: input.name });
				const payloadJson = yield* checkedPayload(input);
				if (config.naturalKey !== undefined) {
					const values = config.naturalKey.values(name, input);
					if (values !== undefined) {
						const taken = yield* findByKey(values);
						if (taken.length > 0) return yield* new nameTaken({ name });
					}
				}
				const now = new Date();
				const rows = yield* Effect.promise(() =>
					db
						.insert(config.table)
						.values({
							name,
							description: toDescription(input.description) ?? null,
							[config.payloadField]: payloadJson ?? config.defaultPayload,
							createdAt: now,
							updatedAt: now,
						} as TTable["$inferInsert"])
						.returning(),
				);
				const row = rows[0];
				/* v8 ignore next -- sqlite insert .returning() always yields the row */
				return row === undefined ? null : config.toDoc(row);
			}),
			adminUpdate: Effect.fn(`${config.serviceName}.adminUpdate`)(function* (
				id: number,
				input: TUpdateInput,
			) {
				yield* requireAdmin;
				let name: string | undefined;
				if (input.name !== undefined) {
					const trimmed = input.name.trim();
					if (trimmed === "") return yield* new invalidName({ name: input.name });
					if (config.naturalKey !== undefined) {
						const values = config.naturalKey.values(trimmed, input);
						if (values !== undefined) {
							const taken = yield* findByKey(values, id);
							if (taken.length > 0) return yield* new nameTaken({ name: trimmed });
						}
					}
					name = trimmed;
				}
				const payloadJson = yield* checkedPayload(input);
				const description = toDescription(input.description);
				const set: Record<string, unknown> = { updatedAt: new Date() };
				if (name !== undefined) set.name = name;
				if (description !== undefined) set.description = description;
				if (payloadJson !== undefined) set[config.payloadField] = payloadJson;
				const rows = yield* Effect.promise(() =>
					db
						.update(config.table)
						.set(set as TTable["$inferInsert"])
						.where(byId(id))
						.returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new notFound({ id });
				return config.toDoc(row);
			}),
			adminRemove: Effect.fn(`${config.serviceName}.adminRemove`)(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.delete(config.table).where(byId(id)).returning(),
				);
				if (rows.length === 0) return yield* new notFound({ id });
			}),
			getById: Effect.fn(`${config.serviceName}.getById`)(function* (id: number) {
				const rows = yield* Effect.promise(() =>
					db.select().from(config.table).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : config.toDoc(row);
			}),
		};

		return {
			methods,
			helpers: { db, requireAdmin, byId },
		} satisfies AdminStoreBuild<
			TDoc,
			TMeta,
			TCreateInput,
			TUpdateInput,
			InstanceType<typeof notFound>,
			InstanceType<typeof invalidName>,
			InstanceType<typeof nameTaken>,
			InstanceType<typeof invalidPayload>
		>;
	});

	return {
		errors: { notFound, invalidName, nameTaken, invalidPayload },
		build,
	};
};

/** Run `eff` as the session user after the PlatformAdmin gate — the
 * shared `asAdmin` preamble every admin-plugin `fns.ts` hand-wrote. */
export const asAdmin = <A, E>(
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

/** `_tag`-membership check for the handled-failure collapse plugin fns
 * apply to service errors (`null`/`false`/`[]` fallbacks). */
export const isHandledError = (error: unknown, tags: readonly string[]): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	tags.includes(String((error as { _tag?: unknown })._tag));

/** `.catch` callback collapsing handled domain failures to `fallback`
 * and rethrowing everything else — replaces the per-fn `isHandled`
 * blocks:
 *
 *   return asAdmin(user, eff).catch(orHandled(HANDLED_TAGS, null));
 */
export const orHandled =
	<T>(tags: readonly string[], fallback: T) =>
	(error: unknown): T => {
		if (isHandledError(error, tags)) return fallback;
		throw error;
	};
