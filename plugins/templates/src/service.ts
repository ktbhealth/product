import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, desc, eq, ne } from "drizzle-orm";

import { Forbidden, Principal } from "@ktb/authz";
import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";

import { TemplateKinds, type TemplateKind } from "./kinds.ts";
import { templates, type TemplateRow } from "./schema.ts";

export type { TemplateRow } from "./schema.ts";
export { TemplateKinds, TemplateKindsLive, makeTemplateKinds } from "./kinds.ts";
export type { TemplateKind, TemplateKindsShape } from "./kinds.ts";

/**
 * Templates domain service: DB-backed snapshot registry edited through
 * the /platform/templates console. A template is `{ kind, name,
 * description, payload }` where `payload` is opaque kind-specific JSON
 * produced/consumed by the kind's `TemplateKind` descriptor (see
 * ./kinds.ts — kind owners register via `TemplateKinds`, e.g. the
 * layouts plugin's `"layout"` kind). Admin methods re-check the
 * `PlatformAdmin` gate inside the service (defense in depth — the
 * panel guard and the server fns gate too); `getById` is a public read
 * other plugins may use — it needs no principal.
 *
 * Templates are SNAPSHOTS, not live references (P-107): `instantiate`
 * only deserializes the payload back into the kind's source form —
 * the caller (an admin surface in the owning plugin) feeds it through
 * that plugin's own create path, so template rows never dangle when
 * sources are deleted and no delete-hook cleanup is needed.
 */

/** `adminUpdate`/`adminRemove`/`instantiate` targeted a missing row. */
export class TemplateNotFound extends Data.TaggedError("TemplateNotFound")<{
	readonly id: number;
}> {}

/** `save`/`adminUpdate` received a blank `name`. */
export class InvalidTemplateName extends Data.TaggedError("InvalidTemplateName")<{
	readonly name: string;
}> {}

/** `name` is already registered to a different row of the same kind. */
export class TemplateNameTaken extends Data.TaggedError("TemplateNameTaken")<{
	readonly kind: string;
	readonly name: string;
}> {}

/** The requested `kind` has no registered `TemplateKind` descriptor —
 * the owning plugin is absent/disabled or the kind id is wrong. */
export class UnknownTemplateKind extends Data.TaggedError("UnknownTemplateKind")<{
	readonly kind: string;
}> {}

/** A payload failed the kind's `validate` (or `serialize`/
 * `deserialize` failed, or the result is not JSON-safe) — `issues`
 * carries the kind's human-readable reasons when it reported any. */
export class InvalidTemplatePayload extends Data.TaggedError("InvalidTemplatePayload")<{
	readonly kind: string;
	readonly issues: readonly string[];
}> {}

export type TemplateError =
	| Forbidden
	| TemplateNotFound
	| InvalidTemplateName
	| TemplateNameTaken
	| UnknownTemplateKind
	| InvalidTemplatePayload;

/** Admin-facing row without the payload — list endpoints. */
export interface TemplateMeta {
	readonly id: number;
	readonly kind: string;
	readonly name: string;
	readonly description: string | null;
	readonly createdBy: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** Full template: meta plus the stored kind payload (opaque JSON). */
export interface TemplateDoc extends TemplateMeta {
	readonly payload: unknown;
}

/** Result of {@link Templates.instantiate} — the kind id plus the
 * deserialized source object the owning plugin knows how to consume. */
export interface TemplateInstance {
	readonly kind: string;
	readonly source: unknown;
}

const toMeta = (row: TemplateRow): TemplateMeta => ({
	id: row.id,
	kind: row.kind,
	name: row.name,
	description: row.description,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const toDoc = (row: TemplateRow): TemplateDoc => ({
	...toMeta(row),
	payload: row.payload,
});

/** `description` wire values: absent stays untouched on update, a
 * blank/whitespace string clears the column (stored as NULL). */
const toDescription = (value: string | undefined): string | null | undefined => {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
};

/** JSON-safety gate every stored payload passes through on write —
 * `undefined`/circular/unserializable values would corrupt the JSON
 * column or silently drop fields. */
const isJsonSafe = (value: unknown): boolean => {
	if (value === undefined) return false;
	try {
		return JSON.stringify(value) !== undefined;
	} catch {
		return false;
	}
};

export class Templates extends Context.Service<
	Templates,
	{
		/** Every template, most recently updated first — meta only (the
		 * payload never leaves the service layer on list). */
		readonly adminList: () => Effect.Effect<readonly TemplateMeta[], Forbidden>;
		/** Templates of one kind, most recently updated first — meta
		 * only. `UnknownTemplateKind` when the kind is not registered. */
		readonly listByKind: (kind: string) => Effect.Effect<readonly TemplateMeta[], TemplateError>;
		/** One template by id (full payload); null when missing. */
		readonly adminGet: (id: number) => Effect.Effect<TemplateDoc | null, TemplateError>;
		/** Public read by id — no admin gate; null when missing. */
		readonly getById: (id: number) => Effect.Effect<TemplateDoc | null>;
		/** Save a template snapshot. `source` is serialized through the
		 * kind's `serialize`; `payload` is stored as-is after
		 * `validate` — exactly one of the two should be supplied
		 * (`payload` wins when both are). `UnknownTemplateKind` when the
		 * kind is not registered, `InvalidTemplatePayload` when the
		 * payload fails validation or is not JSON-safe,
		 * `InvalidTemplateName` on a blank name, `TemplateNameTaken` on
		 * a duplicate within the kind. `null` when the insert
		 * returning comes back empty. */
		readonly save: (input: {
			readonly kind: string;
			readonly name: string;
			readonly description?: string;
			readonly source?: unknown;
			readonly payload?: unknown;
		}) => Effect.Effect<TemplateDoc | null, TemplateError>;
		/** Update name/description/payload by id; `payload` re-validates
		 * against the row's kind (`UnknownTemplateKind` when that kind
		 * is no longer registered and a payload is supplied),
		 * `InvalidTemplateName` on a blank name, `TemplateNameTaken` on
		 * a duplicate, `TemplateNotFound` when the row is missing. */
		readonly adminUpdate: (
			id: number,
			input: {
				readonly name?: string;
				readonly description?: string;
				readonly payload?: unknown;
			},
		) => Effect.Effect<TemplateDoc, TemplateError>;
		/** Delete a template by id; `TemplateNotFound` when missing. */
		readonly adminRemove: (id: number) => Effect.Effect<void, TemplateError>;
		/** Deserialize a stored template back into its kind's source
		 * form — the caller feeds `source` through the owning plugin's
		 * own create path (a template is a snapshot, not a live row).
		 * `null` when the row is missing or its kind is no longer
		 * registered; `InvalidTemplatePayload` when `deserialize`
		 * fails. */
		readonly instantiate: (id: number) => Effect.Effect<TemplateInstance | null, TemplateError>;
	}
>()("@ktb/templates/Templates") {}

export const TemplatesLive = Layer.effect(
	Templates,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		const kinds = yield* TemplateKinds;

		const requireAdmin = platformAdmin.requireAdmin();

		const byId = (id: number) => eq(templates.id, id);

		/** Resolve the kind descriptor or fail `UnknownTemplateKind`. */
		const requireKind = (kind: string) => {
			const descriptor = kinds.get(kind);
			return descriptor === undefined
				? Effect.fail(new UnknownTemplateKind({ kind }))
				: Effect.succeed(descriptor);
		};

		/** Serialize (when `source` is supplied) then validate the
		 * payload candidate — the single write-path gate. */
		const checkedPayload = (
			descriptor: TemplateKind,
			input: { readonly source?: unknown; readonly payload?: unknown },
		): Effect.Effect<unknown, InvalidTemplatePayload> =>
			Effect.gen(function* () {
				let payload: unknown;
				if (input.payload !== undefined) {
					payload = input.payload;
				} else {
					payload = yield* descriptor
						.serialize(input.source ?? null)
						.pipe(
							Effect.mapError(
								() => new InvalidTemplatePayload({ kind: descriptor.kind, issues: [] }),
							),
						);
				}
				const issues = yield* descriptor
					.validate(payload)
					.pipe(
						Effect.mapError(
							() => new InvalidTemplatePayload({ kind: descriptor.kind, issues: [] }),
						),
					);
				if (issues.length > 0 || !isJsonSafe(payload)) {
					return yield* new InvalidTemplatePayload({
						kind: descriptor.kind,
						issues: issues.length > 0 ? issues : ["payload is not JSON-serializable"],
					});
				}
				return payload;
			});

		/** First row matching `(kind, name)`, optionally excluding
		 * `excludeId` (update path — the row's own name is not a
		 * conflict). */
		const findByName = (kind: string, name: string, excludeId?: number) =>
			db
				.select({ id: templates.id })
				.from(templates)
				.where(
					excludeId === undefined
						? and(eq(templates.kind, kind), eq(templates.name, name))
						: and(eq(templates.kind, kind), eq(templates.name, name), ne(templates.id, excludeId)),
				)
				.limit(1);

		return Templates.of({
			adminList: Effect.fn("Templates.adminList")(function* () {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(templates).orderBy(desc(templates.updatedAt)),
				);
				return rows.map(toMeta);
			}),
			listByKind: Effect.fn("Templates.listByKind")(function* (kind: string) {
				yield* requireAdmin;
				yield* requireKind(kind);
				const rows = yield* Effect.promise(() =>
					db
						.select()
						.from(templates)
						.where(eq(templates.kind, kind))
						.orderBy(desc(templates.updatedAt)),
				);
				return rows.map(toMeta);
			}),
			adminGet: Effect.fn("Templates.adminGet")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(templates).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
			getById: Effect.fn("Templates.getById")(function* (id: number) {
				const rows = yield* Effect.promise(() =>
					db.select().from(templates).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
			save: Effect.fn("Templates.save")(function* (input: {
				readonly kind: string;
				readonly name: string;
				readonly description?: string;
				readonly source?: unknown;
				readonly payload?: unknown;
			}) {
				yield* requireAdmin;
				const name = input.name.trim();
				if (name === "") return yield* new InvalidTemplateName({ name: input.name });
				const descriptor = yield* requireKind(input.kind);
				const payload = yield* checkedPayload(descriptor, input);
				const taken = yield* Effect.promise(() => findByName(input.kind, name));
				if (taken.length > 0) {
					return yield* new TemplateNameTaken({ kind: input.kind, name });
				}
				const principal = yield* Principal;
				const now = new Date();
				const rows = yield* Effect.promise(() =>
					db
						.insert(templates)
						.values({
							kind: input.kind,
							name,
							description: toDescription(input.description) ?? null,
							payload,
							createdBy: principal?.email ?? null,
							createdAt: now,
							updatedAt: now,
						})
						.returning(),
				);
				const row = rows[0];
				/* v8 ignore next -- insert().returning() always yields the row */
				return row === undefined ? null : toDoc(row);
			}),
			adminUpdate: Effect.fn("Templates.adminUpdate")(function* (
				id: number,
				input: {
					readonly name?: string;
					readonly description?: string;
					readonly payload?: unknown;
				},
			) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(templates).where(byId(id)).limit(1),
				);
				const row = rows[0];
				if (row === undefined) return yield* new TemplateNotFound({ id });
				let name: string | undefined;
				if (input.name !== undefined) {
					const trimmed = input.name.trim();
					if (trimmed === "") return yield* new InvalidTemplateName({ name: input.name });
					const taken = yield* Effect.promise(() => findByName(row.kind, trimmed, id));
					if (taken.length > 0) {
						return yield* new TemplateNameTaken({ kind: row.kind, name: trimmed });
					}
					name = trimmed;
				}
				let payload: unknown;
				let payloadSet = false;
				if (input.payload !== undefined) {
					const descriptor = yield* requireKind(row.kind);
					payload = yield* checkedPayload(descriptor, { payload: input.payload });
					payloadSet = true;
				}
				const description = toDescription(input.description);
				const set: {
					name?: string;
					description?: string | null;
					payload?: unknown;
					updatedAt: Date;
				} = { updatedAt: new Date() };
				if (name !== undefined) set.name = name;
				if (description !== undefined) set.description = description;
				if (payloadSet) set.payload = payload;
				const updated = yield* Effect.promise(() =>
					db.update(templates).set(set).where(byId(id)).returning(),
				);
				const updatedRow = updated[0];
				/* v8 ignore next -- the row was just read and the update is
				 * keyed by the same id; an empty returning means a
				 * concurrent delete between select and update */
				if (updatedRow === undefined) return yield* new TemplateNotFound({ id });
				return toDoc(updatedRow);
			}),
			adminRemove: Effect.fn("Templates.adminRemove")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.delete(templates).where(byId(id)).returning({ id: templates.id }),
				);
				if (rows.length === 0) return yield* new TemplateNotFound({ id });
			}),
			instantiate: Effect.fn("Templates.instantiate")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(templates).where(byId(id)).limit(1),
				);
				const row = rows[0];
				if (row === undefined) return null;
				const descriptor = kinds.get(row.kind);
				// The kind owner may be absent/disabled — the snapshot
				// stays listed (admin can delete it) but cannot be
				// instantiated until the kind registers again.
				if (descriptor === undefined) return null;
				const source = yield* descriptor.deserialize(row.payload).pipe(
					Effect.mapError(
						() =>
							new InvalidTemplatePayload({
								kind: row.kind,
								issues: ["payload failed kind deserialization"],
							}),
					),
				);
				return { kind: row.kind, source } satisfies TemplateInstance;
			}),
		});
	}),
);
