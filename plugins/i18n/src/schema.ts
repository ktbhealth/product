import { sql } from "drizzle-orm";
import {
	blob,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type { MessageKind, MessageParam } from "@ktb/i18n";

/**
 * i18n tables (P-083 / ADR-0003). Copy is data: `i18n_messages` is the
 * canonical store AND the fallback — baseline copy is imported as
 * `global`/`published` rows, nothing message-shaped ships in the bundle.
 * Logical key: (namespace, key, locale, scope, scope_id).
 */

/** One row per contributed namespace — owner plugin, manifest hash,
 * default locale. `manifest_hash` lets CI detect contract drift. */
export const i18nNamespaces = sqliteTable("i18n_namespaces", {
	/** Dotted namespace, e.g. `patients.messages`. */
	namespace: text("namespace").primaryKey(),
	/** Owning plugin id, e.g. `patients.services`; "" for host. */
	pluginId: text("plugin_id").notNull().default(""),
	manifestHash: text("manifest_hash").notNull().default(""),
	defaultLocale: text("default_locale").notNull().default("en"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
});

/** Enabled locales — runtime data, no rebuild needed for new languages. */
export const i18nLocales = sqliteTable("i18n_locales", {
	/** BCP-47 code, e.g. `pt-BR`. */
	code: text("code").primaryKey(),
	endonym: text("endonym").notNull(),
	/** Ordered fallback chain excluding self; last entry is the default. */
	fallbacks: text("fallbacks", { mode: "json" }).$type<readonly string[]>().notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
});

/**
 * The message store. `value` is the materialized read model — CRDT ops
 * live in `i18n_crdt_updates` and are folded into `value` on apply, so
 * `t()` never touches CRDT. `version` is the optimistic-concurrency /
 * cache-stamp counter.
 */
export const i18nMessages = sqliteTable(
	"i18n_messages",
	{
		namespace: text("namespace").notNull(),
		key: text("key").notNull(),
		locale: text("locale").notNull(),
		/** `global` | `tenant` | `portal`. */
		scope: text("scope").$type<"global" | "tenant" | "portal">().notNull(),
		/** Tenant/portal id within the scope; "" for global. */
		scopeId: text("scope_id").notNull().default(""),
		kind: text("kind").$type<MessageKind>().notNull().default("text"),
		value: text("value").notNull(),
		/** Staged edit awaiting publish; `value` stays live until then.
		 * NULL = no pending draft. */
		draftValue: text("draft_value"),
		status: text("status").$type<"draft" | "published">().notNull().default("draft"),
		/** Declared param signature (names + formatter hints). */
		params: text("params", { mode: "json" }).$type<readonly MessageParam[]>().notNull(),
		version: integer("version").notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.namespace, table.key, table.locale, table.scope, table.scopeId] }),
		index("i18n_messages_ns_locale_idx").on(table.namespace, table.locale),
		uniqueIndex("i18n_messages_key_idx").on(
			table.namespace,
			table.key,
			table.locale,
			table.scope,
			table.scopeId,
		),
	],
);

/**
 * Loro CRDT op log — one row per applied update per message. Reads use
 * the materialized `i18n_messages.value`; this log exists for merge,
 * audit and (optionally) live cursors. `update` is a Loro binary update.
 */
export const i18nCrdtUpdates = sqliteTable(
	"i18n_crdt_updates",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		namespace: text("namespace").notNull(),
		key: text("key").notNull(),
		locale: text("locale").notNull(),
		scope: text("scope").$type<"global" | "tenant" | "portal">().notNull(),
		scopeId: text("scope_id").notNull().default(""),
		/** Loro export bytes. */
		update: blob("update").notNull(),
		actorId: text("actor_id").notNull().default(""),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		index("i18n_crdt_msg_idx").on(
			table.namespace,
			table.key,
			table.locale,
			table.scope,
			table.scopeId,
		),
	],
);

export type I18nNamespace = typeof i18nNamespaces.$inferSelect;
export type I18nLocale = typeof i18nLocales.$inferSelect;
export type I18nMessage = typeof i18nMessages.$inferSelect;
export type I18nCrdtUpdate = typeof i18nCrdtUpdates.$inferSelect;
