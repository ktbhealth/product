import { definePlugin, type Plugin } from "@ktb/kernel";

import { I18nRuntimeLive } from "./runtime.ts";
import { i18nCrdtUpdates, i18nLocales, i18nMessages, i18nNamespaces } from "./schema.ts";

export {
	i18nCrdtUpdates,
	i18nLocales,
	i18nMessages,
	i18nNamespaces,
	type I18nCrdtUpdate,
	type I18nLocale,
	type I18nMessage,
	type I18nNamespace,
} from "./schema.ts";
export { syncBaseline, type BaselineEntry, type BaselineResult } from "./baseline.ts";
export { applyTextEdit, docFromUpdates, docValue, newMessageDoc } from "./crdt.ts";
export { I18nRuntime, I18nRuntimeLive, STAMP_TTL_MS } from "./runtime.ts";
export { requestI18n, i18nLayerFor } from "./service.ts";
export { catalogStamp, listLocales, listPublishedRows } from "./store.ts";

/** i18n tables citizen (P-083). */
export const i18nTablesPlugin = definePlugin({
	id: "i18n.tables",
	tables: {
		i18nNamespaces,
		i18nLocales,
		i18nMessages,
		i18nCrdtUpdates,
	},
});

/** Runtime service citizen: per-isolate catalog cache + stamp. */
export const i18nServicesPlugin = definePlugin({
	id: "i18n.services",
	services: I18nRuntimeLive,
});

/** Test DDL mirroring the drizzle tables (better-sqlite3 has no
 * migrations; tests create the schema directly). */
export const I18N_TEST_DDL = `
CREATE TABLE i18n_namespaces (
	namespace TEXT PRIMARY KEY,
	plugin_id TEXT NOT NULL DEFAULT '',
	manifest_hash TEXT NOT NULL DEFAULT '',
	default_locale TEXT NOT NULL DEFAULT 'en',
	created_at INTEGER NOT NULL
);
CREATE TABLE i18n_locales (
	code TEXT PRIMARY KEY,
	endonym TEXT NOT NULL,
	fallbacks TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL
);
CREATE TABLE i18n_messages (
	namespace TEXT NOT NULL,
	key TEXT NOT NULL,
	locale TEXT NOT NULL,
	scope TEXT NOT NULL,
	scope_id TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL DEFAULT 'text',
	value TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'draft',
	params TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (namespace, key, locale, scope, scope_id)
);
CREATE TABLE i18n_crdt_updates (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	namespace TEXT NOT NULL,
	key TEXT NOT NULL,
	locale TEXT NOT NULL,
	scope TEXT NOT NULL,
	scope_id TEXT NOT NULL DEFAULT '',
	"update" BLOB NOT NULL,
	actor_id TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);
`;

/** Single-concern plugins contributed by this module. */
export const plugins: readonly Plugin[] = [i18nTablesPlugin, i18nServicesPlugin];

// Compile-time dep registry.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"i18n.tables": true;
		"i18n.services": true;
	}
}
