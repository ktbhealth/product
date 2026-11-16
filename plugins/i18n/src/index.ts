import * as Effect from "effect/Effect";
import { LanguagesIcon } from "lucide-react";
import * as Option from "effect/Option";

import { auditServicesPlugin } from "@ktb/audit";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";
import { rbacServicesPlugin } from "@ktb/rbac-plugin";

import { I18nAdmin } from "./contract.ts";
import { I18nAdminLive } from "./admin.ts";
import { I18nPlatformPage } from "./platform-page.tsx";
import type { I18nPageData } from "./views/I18nPage.tsx";
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
export { I18nAdmin, I18nValidationError } from "./contract.ts";
export type {
	I18nAdminShape,
	I18nExportPayload,
	LocaleInfo,
	MessageId,
	NamespaceInfo,
	SaveDraftInput,
} from "./contract.ts";
export { I18nAdminLive } from "./admin.ts";
export { I18nRuntime, I18nRuntimeLive, STAMP_TTL_MS } from "./runtime.ts";
export { requestI18n, i18nLayerFor } from "./service.ts";
export { catalogSlice, stableSlice } from "./slice.ts";
export { resolveRequestI18n, DEFAULT_LOCALE } from "./request.ts";
export { catalogStamp, listEnabledLocales, listLocales, listPublishedRows } from "./store.ts";

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

/** i18n admin service citizen (P-083): panel read/write path.
 * Defined here (not admin.ts) so the ktb-arch plugin-contract rule can
 * resolve the `plugins` entry — it only follows same-file consts. */
export const i18nAdminServicesPlugin = definePlugin({
	id: "i18n.admin.services",
	// i18n.services first: publish() invalidates the shared isolate
	// cache — the runtime must be the SAME instance, not a private one.
	requiredDeps: [platformAdminPlugin.id, rbacServicesPlugin.id, "i18n.services"],
	optionalDeps: [auditServicesPlugin.id],
	services: I18nAdminLive,
});

// Chrome contribution: the console sidebar entry (P-060 region).
export const i18nChromePlugin = definePlugin({
	id: "i18n.chrome",
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "i18n.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/i18n", label: "Translations", icon: LanguagesIcon, group: "System" },
			},
		},
	],
});

// Panel (system console) contribution: /platform/i18n is mounted by the
// platform plugin's physical route subtree; this declares the page.
export const i18nPanelPlugin = definePlugin({
	id: "i18n.panel",
	requiredDeps: [platformPanelPlugin.id, i18nAdminServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "i18n.messages",
				path: "/platform/i18n",
				component: I18nPlatformPage,
				// Read gate mirrors the service: rbac grant OR admin
				// allowlist — non-readers get a hard 404.
				guard: () =>
					Effect.gen(function* () {
						const permissionsOpt = yield* Effect.serviceOption(Permissions);
						if (Option.isSome(permissionsOpt)) {
							const ok = yield* permissionsOpt.value.can("i18n", "messages.read");
							if (ok) return true;
						}
						const platformAdmin = yield* PlatformAdmin;
						return yield* platformAdmin.requireAdmin().pipe(
							Effect.as(true),
							Effect.catchTag("Forbidden", () => Effect.succeed(false)),
						);
					}),
				loader: () =>
					Effect.gen(function* () {
						const admin = yield* I18nAdmin;
						const empty: I18nPageData = { namespaces: [], locales: [], messages: [] };
						return yield* Effect.all({
							namespaces: admin.namespaces(),
							locales: admin.locales(),
							messages: admin.messages(),
						}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(empty)));
					}),
			},
		],
	},
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
	draft_value TEXT,
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
export const plugins: readonly Plugin[] = [
	i18nTablesPlugin,
	i18nServicesPlugin,
	i18nAdminServicesPlugin,
	i18nChromePlugin,
	i18nPanelPlugin,
];

// Compile-time dep registry.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"i18n.tables": true;
		"i18n.services": true;
		"i18n.admin.services": true;
		"i18n.chrome": true;
		"i18n.panel": true;
	}
}
