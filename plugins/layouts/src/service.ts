import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { eq, inArray } from "drizzle-orm";
import { Schema } from "effect";

import { Forbidden } from "@ktb/authz";
import { type DbClient } from "@ktb/db";
import { defineAdminStore } from "@ktb/admin-store";
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
 *
 * The CRUD core (list/get/create/update/remove + the name natural
 * key) comes from `@ktb/admin-store`'s `defineAdminStore`; this module
 * keeps the layout-config contract, the builder-document write, the
 * public `resolveForPage` read, the rich-text delete-hook
 * participation and the plugin's error tags.
 */

/** `adminSetBuilderJson` received a `builderJson` payload that is not
 * valid JSON or not a JSON object — same handled-failure contract as
 * `InvalidLayoutConfig`. */
export class InvalidBuilderDoc extends Data.TaggedError("InvalidBuilderDoc")<{
	readonly builderJson: string;
}> {}

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

/** effect/Schema gate every stored config passes through on write —
 * exported for the `"layout"` template kind's payload validation
 * (./template-kind.ts). */
export const LayoutConfigSchema = Schema.Struct({
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

/** Full layout: meta plus the stored config JSON text and the
 * builder document (PL-014 — null when the layout still uses the
 * legacy section-slot `config`). */
export interface LayoutDoc extends LayoutMeta {
	readonly config: string;
	readonly builderJson: string | null;
}

/** One resolved section for public rendering: the slot's title plus
 * the referenced document's parsed content (`null`-free — unresolved
 * slots are skipped by `resolveForPage`). */
export interface ResolvedLayoutSection {
	readonly id: string;
	readonly title: string;
	readonly content: unknown;
}

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
	builderJson: row.builderJson,
});

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

/** True when the stored config references `docId` in any section slot. */
const configReferencesDoc = (json: string, docId: number): boolean =>
	parseConfig(json)?.sections.some((section) => section.refId === docId) ?? false;

const store = defineAdminStore({
	serviceName: "Layouts",
	payloadField: "config",
	defaultPayload: '{"sections":[]}',
	table: layouts,
	columns: { id: layouts.id, name: layouts.name, updatedAt: layouts.updatedAt },
	errors: {
		notFound: "LayoutNotFound",
		invalidName: "InvalidLayoutName",
		nameTaken: "LayoutNameTaken",
		invalidPayload: "InvalidLayoutConfig",
	},
	toMeta,
	toDoc,
	validatePayload: isStorableConfig,
	naturalKey: {
		columns: [layouts.name],
		values: (name) => [name],
	},
});

/** `adminUpdate`/`adminRemove`/`adminSetBuilderJson` targeted a missing
 * row. */
export const LayoutNotFound = store.errors.notFound;
export type LayoutNotFound = InstanceType<typeof LayoutNotFound>;

/** `adminCreate`/`adminUpdate` received a blank `name`. */
export const InvalidLayoutName = store.errors.invalidName;
export type InvalidLayoutName = InstanceType<typeof InvalidLayoutName>;

/** `name` is already registered to a different row. */
export const LayoutNameTaken = store.errors.nameTaken;
export type LayoutNameTaken = InstanceType<typeof LayoutNameTaken>;

/** `adminCreate`/`adminUpdate` received a `config` payload that is not
 * valid JSON or does not match the layout config contract — the
 * rejected input is carried for debugging. */
export const InvalidLayoutConfig = store.errors.invalidPayload;
export type InvalidLayoutConfig = InstanceType<typeof InvalidLayoutConfig>;

export type LayoutError =
	| Forbidden
	| LayoutNotFound
	| InvalidLayoutName
	| LayoutNameTaken
	| InvalidLayoutConfig
	| InvalidBuilderDoc;

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
		/** Write the layout's `builderJson` (PL-014): `null` clears the
		 * builder document (the layout falls back to the legacy
		 * section-slot `config`), a string must parse to a JSON object
		 * (the versioned `{version, data}` wrapper is validated by the
		 * writer — this service only guarantees JSON-object shape).
		 * `LayoutNotFound` when missing, `InvalidBuilderDoc` on
		 * malformed input. */
		readonly adminSetBuilderJson: (
			id: number,
			builderJson: string | null,
		) => Effect.Effect<LayoutDoc, LayoutError>;
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

/** Console route this plugin owns — the referencer `path` target the
 * rich-text delete dialog links to. */
const LAYOUTS_CONSOLE = "/platform/layouts";

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
		// Optional edge: the rich-text plugin's delete-hook registry is
		// absent when rich-text (or its service layer) is not installed —
		// layouts then simply register nothing. The `optionalDeps` edge on
		// layouts.services keeps the registry built first when present.
		const deleteHooks = yield* Effect.serviceOption(RichTextDeleteHooks);
		// Optional edge: slot content resolves through the rich-text
		// service — absent it, resolveForPage skips every slot instead
		// of failing. The `optionalDeps` edge keeps it built first when
		// present.
		const richTexts = yield* Effect.serviceOption(RichTexts);
		const { methods, helpers } = yield* store.build;
		if (Option.isSome(deleteHooks)) {
			yield* deleteHooks.value.register(layoutsRichTextDeleteHook(helpers.db));
		}

		return Layouts.of({
			...methods,
			adminSetBuilderJson: Effect.fn("Layouts.adminSetBuilderJson")(function* (
				id: number,
				builderJson: string | null,
			) {
				yield* helpers.requireAdmin;
				if (builderJson !== null) {
					let parsed: unknown;
					try {
						parsed = JSON.parse(builderJson);
					} catch {
						return yield* new InvalidBuilderDoc({ builderJson });
					}
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						return yield* new InvalidBuilderDoc({ builderJson });
					}
				}
				const rows = yield* Effect.promise(() =>
					helpers.db
						.update(layouts)
						.set({ builderJson, updatedAt: new Date() })
						.where(helpers.byId(id))
						.returning(),
				);
				const row = rows[0];
				if (row === undefined) return yield* new LayoutNotFound({ id });
				return toDoc(row);
			}),
			resolveForPage: Effect.fn("Layouts.resolveForPage")(function* (layoutId: number) {
				const rows = yield* Effect.promise(() =>
					helpers.db.select().from(layouts).where(helpers.byId(layoutId)).limit(1),
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
