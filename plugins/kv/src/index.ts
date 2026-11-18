import { DatabaseIcon } from "lucide-react";
import * as Effect from "effect/Effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";

import { KvAdmin, KvAdminLive } from "./admin.ts";
import { kvEntries } from "./schema.ts";
import { KvLive } from "./service.ts";
import { KvAdminConsolePage } from "./platform-page.tsx";

export { kvEntries, type KvEntryRow } from "./schema.ts";
export {
	DEFAULT_KEYS_LIMIT,
	Kv,
	KvConflictError,
	KvLive,
	KvNotFoundError,
	KvTypeError,
	KvValidationError,
	MAX_FIELD_LENGTH,
	MAX_KEYS_LIMIT,
	MAX_VALUE_BYTES,
	type KvEntry,
	type KvError,
	type KvKeysOptions,
	type KvScope,
	type KvSetOptions,
	type KvShape,
} from "./service.ts";
export {
	DEFAULT_ADMIN_LIMIT,
	KvAdmin,
	KvAdminLive,
	MAX_ADMIN_LIMIT,
	type KvAdminEntry,
	type KvAdminError,
	type KvAdminFilter,
	type KvAdminList,
	type KvAdminNamespaceCount,
	type KvAdminScope,
	type KvAdminSetInput,
	type KvAdminShape,
	type KvAdminTarget,
} from "./admin.ts";

/** kv tables citizen (P-090). */
export const kvTablesPlugin = definePlugin({
	id: "kv.tables",
	meta: { keywords: ["kv", "tables"] },
	tables: {
		kvEntries,
	},
});

/** kv service citizen (P-090): TTL'd namespaced key/value state. */
export const kvServicesPlugin = definePlugin({
	id: "kv.services",
	meta: { keywords: ["kv", "services"] },
	services: KvLive,
});

/** kv admin service citizen (P-090 console): platform-admin read/write
 * over every namespace/scope slice — see admin.ts for the scope and
 * TTL semantics. Defined here (not admin.ts) so the arch
 * plugin-contract rule can resolve the `plugins` entry — it only
 * follows same-file consts (same convention as i18n.admin.services). */
export const kvAdminServicesPlugin = definePlugin({
	id: "kv.admin.services",
	meta: { keywords: ["kv", "services", "admin"] },
	requiredDeps: [platformAdminPlugin.id],
	services: KvAdminLive,
});

/**
 * Chrome contribution (P-060): the /platform/kv console sidebar entry
 * (System group), same slot as the other admin pages.
 */
export const kvChromePlugin = definePlugin({
	id: "kv.chrome",
	meta: { keywords: ["kv", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "kv.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/kv",
					label: "Key-Value",
					icon: DatabaseIcon,
					group: "System",
				},
			},
		},
	],
});

/**
 * Panel (system console) contribution: /platform/kv is the admin
 * entries browser. The loader returns the first page of entries
 * across all scopes plus the namespace overview; the service re-checks
 * the admin gate. `guard` hard-404s non-admins — same contract as the
 * /platform layout gate and the pages/i18n consoles.
 */
export const kvPanelPlugin = definePlugin({
	id: "kv.panel",
	meta: { keywords: ["kv", "ui", "admin"] },
	requiredDeps: [platformPanelPlugin.id, kvAdminServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "kv.entries",
				path: "/platform/kv",
				component: KvAdminConsolePage,
				guard: (_path) =>
					Effect.gen(function* () {
						const platformAdmin = yield* PlatformAdmin;
						return yield* platformAdmin.requireAdmin().pipe(
							Effect.as(true),
							Effect.catchTag("Forbidden", () => Effect.succeed(false)),
						);
					}),
				loader: (_path) =>
					Effect.gen(function* () {
						const admin = yield* KvAdmin;
						const empty = { items: [], total: 0, namespaces: [] };
						return yield* Effect.all({
							list: admin.list({ limit: 50 }),
							namespaces: admin.namespaces(),
						}).pipe(
							Effect.map(({ list, namespaces }) => ({
								items: list.items,
								total: list.total,
								namespaces,
							})),
							Effect.catchTag("Forbidden", () => Effect.succeed(empty)),
						);
					}),
			},
		],
	},
});

/** Test DDL mirroring the drizzle table (better-sqlite3 has no
 * migrations; tests create the schema directly). */
export const KV_TEST_DDL = `
CREATE TABLE kv_entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	namespace TEXT NOT NULL,
	"key" TEXT NOT NULL,
	tenant_id INTEGER,
	owner_id TEXT,
	value TEXT NOT NULL,
	expires_at INTEGER,
	version INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	tenant_key INTEGER GENERATED ALWAYS AS (coalesce("tenant_id", -1)) VIRTUAL,
	owner_key TEXT GENERATED ALWAYS AS (coalesce("owner_id", '')) VIRTUAL
);
CREATE UNIQUE INDEX kv_entries_uidx ON kv_entries (namespace, "key", tenant_key, owner_key);
CREATE INDEX kv_entries_expiry_idx ON kv_entries (expires_at);
CREATE INDEX kv_entries_scope_idx ON kv_entries (namespace, tenant_id, owner_id);
`;

/** Single-concern plugins contributed by this module. */
export const plugins: readonly Plugin[] = [
	kvTablesPlugin,
	kvServicesPlugin,
	kvAdminServicesPlugin,
	kvChromePlugin,
	kvPanelPlugin,
];

// Compile-time dep registry.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"kv.tables": true;
		"kv.services": true;
		"kv.admin.services": true;
		"kv.chrome": true;
		"kv.panel": true;
	}
}
