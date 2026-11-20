import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Schema } from "effect";

import { Forbidden } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";
import { RichTexts } from "@ktb/rich-text/service";
import {
	RichTextDeleteHooks,
	type RichTextDeleteHook,
	type RichTextReferencerItem,
} from "@ktb/rich-text/delete-hooks";

import { layouts, type LayoutRow } from "./schema.ts";

export type { LayoutRow } from "./schema.ts";

/**
 * Layouts domain service: DB-backed page-body layouts edited through
 * the /platform/layouts console. A layout is an ordered list of named
 * sections; each section binds a content slot (`kind` + `refId`) —
 * today only `"rich-text"` slots referencing `rich_text` documents.
 * Admin methods re-check the `PlatformAdmin` gate inside the service
 * (defense in depth — the panel guard and the server fns gate too);
 * `getById` and `resolveForPage` are public reads other plugins (the
 * pages plugin rendering `pages.layout_id`) use — they need no
 * principal.
 */

/** `adminUpdate`/`adminRemove` targeted a missing row. */
export class LayoutNotFound extends Data.TaggedError("LayoutNotFound")<{
	readonly id: number;
}> {}

/** `adminCreate`/`adminUpdate` received a blank `name`. */
export class InvalidLayoutName extends Data.TaggedError("InvalidLayoutName")<{
	readonly name: string;
}> {}

/** `name` is already registered to a different row. */
export class LayoutNameTaken extends Data.TaggedError("LayoutNameTaken")<{
	readonly name: string;
}> {}

/** `adminCreate`/`adminUpdate` received a `config` payload that is not
 * valid JSON or does not match the layout config contract — the
 * rejected input is carried for debugging. */
export class InvalidLayoutConfig extends Data.TaggedError("InvalidLayoutConfig")<{
	readonly config: string;
}> {}

export type LayoutError =
	| Forbidden
	| LayoutNotFound
	| InvalidLayoutName
	| LayoutNameTaken
	| InvalidLayoutConfig;

/**
 * Frozen config contract (P-102 phase 2):
 * `{ sections: [{ id, title, kind: "rich-text", refId }] }` — ordered
 * sections; `kind` is forward-compatible with a future element-kind
 * registry (only `"rich-text"` is valid today). `refId` is the
 * `rich_text` document id, or null for an empty slot (also the state
 * the `layouts.unlink-slots` delete cleanup writes).
 */
export interface LayoutSection {
	readonly id: string;
	readonly title: string;
	readonly kind: "rich-text";
	readonly refId: number | null;
}

export interface LayoutConfig {
	readonly sections: readonly LayoutSection[];
}

/** effect/Schema gate every stored config passes through on write. */
const LayoutConfigSchema = Schema.Struct({
	sections: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			title: Schema.String,
			kind: Schema.Literal("rich-text"),
			refId: Schema.NullOr(Schema.Int),
		}),
	),
});

/** Admin-facing row without the config payload — list endpoints. */
export interface LayoutMeta {
	readonly id: number;
	readonly name: string;
	readonly description: string | null;
	/** Section count parsed leniently from the stored config (0 when
	 * the JSON is corrupt — the row still lists). */
	readonly sectionCount: number;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** Full layout: meta plus the stored config JSON text. */
export interface LayoutDoc extends LayoutMeta {
	readonly config: string;
}

/** One resolved section for public rendering: the slot's title plus
 * the referenced document's parsed content (`null`-free — unresolved
 * slots are skipped by `resolveForPage`). */
export interface ResolvedLayoutSection {
	readonly id: string;
	readonly title: string;
	readonly content: unknown;
}

/** Seed written by `adminCreate` when no config text is supplied. */
const EMPTY_CONFIG = '{"sections":[]}';

/** Console route this plugin owns — the referencer `path` target the
 * rich-text delete dialog links to. */
const LAYOUTS_CONSOLE = "/platform/layouts";

/** Tolerant config parse: stored JSON that fails the contract
 * resolves null (corrupt rows degrade instead of breaking reads). */
const parseConfig = (json: string): LayoutConfig | null => {
	try {
		const parsed: unknown = JSON.parse(json);
		return Schema.decodeUnknownSync(LayoutConfigSchema)(parsed) as LayoutConfig;
	} catch {
		return null;
	}
};

const toMeta = (row: LayoutRow): LayoutMeta => ({
	id: row.id,
	name: row.name,
	description: row.description,
	sectionCount: parseConfig(row.config)?.sections.length ?? 0,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const toDoc = (row: LayoutRow): LayoutDoc => ({
	...toMeta(row),
	config: row.config,
});

/** `description` wire values: absent stays untouched on update, a
 * blank/whitespace string clears the column (stored as NULL). */
const toDescription = (value: string | undefined): string | null | undefined => {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
};

/** True when `json` parses and conforms to the layout config contract —
 * the gate every stored config passes through on write. */
const isStorableConfig = (json: string): boolean => {
	try {
		const parsed: unknown = JSON.parse(json);
		Schema.decodeUnknownSync(LayoutConfigSchema)(parsed);
		return true;
	} catch {
		return false;
	}
};

/** Normalize a write input's config text: undefined stays undefined
 * (unchanged on update / default on create), anything else must be
 * storable contract JSON or the write fails `InvalidLayoutConfig`. */
const checkedConfig = (
	config: string | undefined,
): Effect.Effect<string | undefined, InvalidLayoutConfig> =>
	config !== undefined && !isStorableConfig(config)
		? Effect.fail(new InvalidLayoutConfig({ config }))
		: Effect.succeed(config);

/** True when the stored config references `docId` in any section slot. */
const configReferencesDoc = (json: string, docId: number): boolean =>
	parseConfig(json)?.sections.some((section) => section.refId === docId) ?? false;

export class Layouts extends Context.Service<
	Layouts,
	{
		/** Every layout, most recently updated first — meta only (the
		 * config payload never leaves the service layer on list). */
		readonly adminList: () => Effect.Effect<readonly LayoutMeta[], Forbidden>;
		/** One layout by id (raw config text); null when missing. */
		readonly adminGet: (id: number) => Effect.Effect<LayoutDoc | null, LayoutError>;
		/** Insert a layout; `config` defaults to an empty section list.
		 * `null` when the insert returning comes back empty. */
		readonly adminCreate: (input: {
			readonly name: string;
			readonly description?: string;
			readonly config?: string;
		}) => Effect.Effect<LayoutDoc | null, LayoutError>;
		/** Update name/description/config by id; `InvalidLayoutConfig`
		 * when a supplied `config` violates the contract,
		 * `InvalidLayoutName` on a blank name, `LayoutNameTaken` on a
		 * duplicate, `LayoutNotFound` when the row is missing. */
		readonly adminUpdate: (
			id: number,
			input: {
				readonly name?: string;
				readonly description?: string;
				readonly config?: string;
			},
		) => Effect.Effect<LayoutDoc, LayoutError>;
		/** Delete a layout by id; `LayoutNotFound` when missing. */
		readonly adminRemove: (id: number) => Effect.Effect<void, LayoutError>;
		/** Public read by id — no admin gate; null when missing. */
		readonly getById: (id: number) => Effect.Effect<LayoutDoc | null>;
		/** Resolve a layout for public page rendering: the ordered
		 * sections with each `"rich-text"` slot's document content
		 * resolved through the rich-text service. Infallible and
		 * degrading: a missing layout resolves null, a corrupt config
		 * or absent rich-text service resolves an empty list, and
		 * slots whose document is missing/corrupt are skipped — a
		 * page bound to a layout never breaks on slot problems. */
		readonly resolveForPage: (
			layoutId: number,
		) => Effect.Effect<readonly ResolvedLayoutSection[] | null>;
	}
>()("@ktb/layouts/Layouts") {}

/**
 * Rich-text delete-hook participation: this plugin references
 * `rich_text` documents inside layout config slots, so it reports
 * referencing layouts to the delete dialog (`usage`) and executes the
 * admin's choice (`cleanup`). "layouts.unlink-slots" keeps every
 * layout but empties the matching slots (`refId: null`); "layouts
 * .delete-layouts" removes the referencing rows outright. Action ids
 * owned by other plugins are a silent no-op so one dialog choice can
 * cascade through several hooks.
 */
export const layoutsRichTextDeleteHook = (db: DbClient): RichTextDeleteHook => ({
	id: "layouts",
	usage: (docId) =>
		Effect.promise(async () => {
			const rows = await db
				.select({ id: layouts.id, name: layouts.name, config: layouts.config })
				.from(layouts);
			return rows
				.filter((row) => configReferencesDoc(row.config, docId))
				.map((row): RichTextReferencerItem => ({
					id: row.id,
					title: row.name,
					path: LAYOUTS_CONSOLE,
				}));
		}),
	cleanup: (docId, actionId) => {
		if (actionId === "layouts.unlink-slots") {
			return Effect.promise(async () => {
				const rows = await db.select().from(layouts);
				const now = new Date();
				for (const row of rows) {
					const config = parseConfig(row.config);
					if (config === null || !config.sections.some((s) => s.refId === docId)) continue;
					const next: LayoutConfig = {
						sections: config.sections.map((section) =>
							section.refId === docId ? { ...section, refId: null } : section,
						),
					};
					await db
						.update(layouts)
						.set({ config: JSON.stringify(next), updatedAt: now })
						.where(eq(layouts.id, row.id));
				}
			}).pipe(Effect.asVoid);
		}
		if (actionId === "layouts.delete-layouts") {
			return Effect.promise(async () => {
				const rows = await db.select({ id: layouts.id, config: layouts.config }).from(layouts);
				const ids = rows
					.filter((row) => configReferencesDoc(row.config, docId))
					.map((row) => row.id);
				if (ids.length > 0) await db.delete(layouts).where(inArray(layouts.id, ids));
			}).pipe(Effect.asVoid);
		}
		return Effect.void;
	},
});

export const LayoutsLive = Layer.effect(
	Layouts,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		// Optional edge: the rich-text plugin's delete-hook registry is
		// absent when rich-text (or its service layer) is not installed —
		// layouts then simply register nothing. The `optionalDeps` edge on
		// layouts.services keeps the registry built first when present.
		const deleteHooks = yield* Effect.serviceOption(RichTextDeleteHooks);
		if (Option.isSome(deleteHooks)) {
			yield* deleteHooks.value.register(layoutsRichTextDeleteHook(db));
		}
		// Optional edge: slot content resolves through the rich-text
		// service — absent it, resolveForPage skips every slot instead
		// of failing. The `optionalDeps` edge keeps it built first when
		// present.
		const richTexts = yield* Effect.serviceOption(RichTexts);

		const requireAdmin = platformAdmin.requireAdmin();

		const byId = (id: number) => eq(layouts.id, id);

		/** First row matching `name`, optionally excluding `excludeId`
		 * (update path — the row's own name is not a conflict). */
		const findByName = (name: string, excludeId?: number) =>
			db
				.select({ id: layouts.id })
				.from(layouts)
				.where(
					excludeId === undefined
						? eq(layouts.name, name)
						: and(eq(layouts.name, name), ne(layouts.id, excludeId)),
				)
				.limit(1);

		return Layouts.of({
			adminList: Effect.fn("Layouts.adminList")(function* () {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(layouts).orderBy(desc(layouts.updatedAt)),
				);
				return rows.map(toMeta);
			}),
			adminGet: Effect.fn("Layouts.adminGet")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.select().from(layouts).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
			adminCreate: Effect.fn("Layouts.adminCreate")(function* (input: {
				readonly name: string;
				readonly description?: string;
				readonly config?: string;
			}) {
				yield* requireAdmin;
				const name = input.name.trim();
				if (name === "") return yield* new InvalidLayoutName({ name: input.name });
				const configJson = yield* checkedConfig(input.config);
				const taken = yield* Effect.promise(() => findByName(name));
				if (taken.length > 0) return yield* new LayoutNameTaken({ name });
				const now = new Date();
				const rows = yield* Effect.promise(() =>
					db
						.insert(layouts)
						.values({
							name,
							description: toDescription(input.description) ?? null,
							config: configJson ?? EMPTY_CONFIG,
							createdAt: now,
							updatedAt: now,
						})
						.returning(),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
			adminUpdate: Effect.fn("Layouts.adminUpdate")(function* (
				id: number,
				input: {
					readonly name?: string;
					readonly description?: string;
					readonly config?: string;
				},
			) {
				yield* requireAdmin;
				let name: string | undefined;
				if (input.name !== undefined) {
					const trimmed = input.name.trim();
					if (trimmed === "") return yield* new InvalidLayoutName({ name: input.name });
					const taken = yield* Effect.promise(() => findByName(trimmed, id));
					if (taken.length > 0) return yield* new LayoutNameTaken({ name: trimmed });
					name = trimmed;
				}
				const configJson = yield* checkedConfig(input.config);
				const description = toDescription(input.description);
				const set: {
					name?: string;
					description?: string | null;
					config?: string;
					updatedAt: Date;
				} = { updatedAt: new Date() };
				if (name !== undefined) set.name = name;
				if (description !== undefined) set.description = description;
				if (configJson !== undefined) set.config = configJson;
				const rows = yield* Effect.promise(() =>
					db.update(layouts).set(set).where(byId(id)).returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new LayoutNotFound({ id });
				return toDoc(row);
			}),
			adminRemove: Effect.fn("Layouts.adminRemove")(function* (id: number) {
				yield* requireAdmin;
				const rows = yield* Effect.promise(() =>
					db.delete(layouts).where(byId(id)).returning({ id: layouts.id }),
				);
				if (rows.length === 0) return yield* new LayoutNotFound({ id });
			}),
			getById: Effect.fn("Layouts.getById")(function* (id: number) {
				const rows = yield* Effect.promise(() =>
					db.select().from(layouts).where(byId(id)).limit(1),
				);
				const row = rows[0];
				return row === undefined ? null : toDoc(row);
			}),
			resolveForPage: Effect.fn("Layouts.resolveForPage")(function* (layoutId: number) {
				const rows = yield* Effect.promise(() =>
					db.select().from(layouts).where(byId(layoutId)).limit(1),
				);
				const row = rows[0];
				if (row === undefined) return null;
				const config = parseConfig(row.config);
				if (config === null) return [];
				const resolved: ResolvedLayoutSection[] = [];
				for (const section of config.sections) {
					// Only "rich-text" slots resolve today — unknown kinds
					// (forward-compat) are skipped like unresolved slots.
					if (section.kind !== "rich-text" || section.refId === null) continue;
					let content: unknown = null;
					if (Option.isSome(richTexts)) {
						const doc = yield* richTexts.value.getById(section.refId);
						content = doc?.content ?? null;
					}
					if (content === null) continue;
					resolved.push({ id: section.id, title: section.title, content });
				}
				return resolved;
			}),
		});
	}),
);

/**
 * Test-only DDL mirroring the `layouts` migration — re-exported for
 * sibling test files (same convention as `SCHEMAS_TEST_DDL` in
 * plugins/schemas). Never used by production code.
 */
export const LAYOUTS_TEST_DDL = `
CREATE TABLE layouts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	description TEXT,
	config TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX layouts_updated_idx ON layouts (updated_at);
`;
