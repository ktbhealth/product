import { DatabaseIcon } from "lucide-react";
import * as Effect from "effect/Effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin, adminConsolePage } from "@ktb/platform";

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
 * (Storage group), same slot as the other admin pages.
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
					group: "Storage",
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
			adminConsolePage({
				id: "kv.entries",
				path: "/platform/kv",
				component: KvAdminConsolePage,
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
			}),
		],
	},
});

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
