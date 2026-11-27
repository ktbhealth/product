import * as Effect from "effect/Effect";
import { BoxesIcon, FileClockIcon, GlobeIcon, LanguagesIcon } from "lucide-react";
import * as Option from "effect/Option";

import { auditServicesPlugin } from "@ktb/audit";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminGuard, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";
import { rbacServicesPlugin } from "@ktb/rbac-plugin";

import { I18nAdmin } from "./contract.ts";
import { I18nAdminLive } from "./admin.ts";
import {
	I18nDraftsPlatformPage,
	I18nIndexRedirect,
	I18nLocalesPlatformPage,
	I18nNamespacesPlatformPage,
	I18nPlatformPage,
} from "./platform-page.tsx";
import { I18nRuntimeLive } from "./runtime.ts";
import {
	i18nCrdtUpdates,
	i18nLocales,
	i18nMessages,
	i18nNamespaces,
	i18nRevision,
} from "./schema.ts";

export {
	i18nCrdtUpdates,
	i18nLocales,
	i18nMessages,
	i18nNamespaces,
	i18nRevision,
	type I18nCrdtUpdate,
	type I18nLocale,
	type I18nMessage,
	type I18nNamespace,
	type I18nRevision,
} from "./schema.ts";
export { syncBaseline, prepareBaselineEntries } from "./baseline.ts";
export type { BaselineEntry, BaselineResult } from "./baseline.ts";
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
export { I18nRuntime, I18nRuntimeLive, MAX_CACHE_ENTRIES, STAMP_TTL_MS } from "./runtime.ts";
export { SEED_RETRY_COOLDOWN_MS } from "./runtime.ts";
export { requestI18n, i18nLayerFor } from "./service.ts";
export { catalogSlice, stableSlice } from "./slice.ts";
export { resolveRequestI18n, DEFAULT_LOCALE } from "./request.ts";
export {
	catalogStamp,
	bumpCatalogRevision,
	listEnabledLocales,
	listLocales,
	listPublishedRows,
} from "./store.ts";

/** i18n tables citizen (P-083). */
export const i18nTablesPlugin = definePlugin({
	id: "i18n.tables",
	meta: { keywords: ["i18n", "tables"] },
	tables: {
		i18nNamespaces,
		i18nLocales,
		i18nMessages,
		i18nCrdtUpdates,
		i18nRevision,
	},
});

/** Runtime service citizen: per-isolate catalog cache + stamp. */
export const i18nServicesPlugin = definePlugin({
	id: "i18n.services",
	meta: { keywords: ["i18n", "services"] },
	services: I18nRuntimeLive,
});

/** i18n admin service citizen (P-083): panel read/write path.
 * Defined here (not admin.ts) so the arch plugin-contract rule can
 * resolve the `plugins` entry — it only follows same-file consts. */
export const i18nAdminServicesPlugin = definePlugin({
	id: "i18n.admin.services",
	meta: { keywords: ["i18n", "services", "admin"] },
	// i18n.services first: publish() invalidates the shared isolate
	// cache — the runtime must be the SAME instance, not a private one.
	requiredDeps: [platformAdminPlugin.id, rbacServicesPlugin.id, "i18n.services"],
	optionalDeps: [auditServicesPlugin.id],
	services: I18nAdminLive,
});

// Chrome contribution: the console sidebar entries (P-060 region).
export const i18nChromePlugin = definePlugin({
	id: "i18n.chrome",
	meta: { keywords: ["i18n", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "i18n.sidebar.messages",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/i18n/messages",
					label: "Messages",
					icon: LanguagesIcon,
					group: "Internationalization",
				},
			},
		},
		{
			id: "i18n.sidebar.locales",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/i18n/locales",
					label: "Locales",
					icon: GlobeIcon,
					group: "Internationalization",
				},
			},
		},
		{
			id: "i18n.sidebar.drafts",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/i18n/drafts",
					label: "Drafts",
					icon: FileClockIcon,
					group: "Internationalization",
				},
			},
		},
		{
			id: "i18n.sidebar.namespaces",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/i18n/namespaces",
					label: "Namespaces",
					icon: BoxesIcon,
					group: "Internationalization",
				},
			},
		},
	],
});

/** Read gate shared by every /platform/i18n page: rbac grant OR admin
 * allowlist — non-readers get a hard 404. */
const i18nReadGuard = () =>
	Effect.gen(function* () {
		const permissionsOpt = yield* Effect.serviceOption(Permissions);
		if (Option.isSome(permissionsOpt)) {
			const ok = yield* permissionsOpt.value.can("i18n", "messages.read");
			if (ok) return true;
		}
		return yield* platformAdminGuard();
	});

// Panel (system console) contribution: the /platform/i18n subtree is
// mounted by the platform plugin's physical route; this declares the
// pages. /platform/i18n itself redirects to the messages matrix.
export const i18nPanelPlugin = definePlugin({
	id: "i18n.panel",
	meta: { keywords: ["i18n", "ui", "admin"] },
	requiredDeps: [platformPanelPlugin.id, i18nAdminServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "i18n.index",
				path: "/platform/i18n",
				component: I18nIndexRedirect,
				guard: i18nReadGuard,
			},
			{
				id: "i18n.messages",
				path: "/platform/i18n/messages",
				component: I18nPlatformPage,
				guard: i18nReadGuard,
				loader: () =>
					Effect.gen(function* () {
						const admin = yield* I18nAdmin;
						// Namespaces + locales only — message rows are fetched
						// per selected namespace (i18nNamespaceMessagesFn) so
						// the loader never ships the whole table.
						const empty = { namespaces: [], locales: [] };
						return yield* Effect.all({
							namespaces: admin.namespaces(),
							locales: admin.locales(),
						}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(empty)));
					}),
			},
			{
				id: "i18n.locales",
				path: "/platform/i18n/locales",
				component: I18nLocalesPlatformPage,
				guard: i18nReadGuard,
				loader: () =>
					Effect.gen(function* () {
						const admin = yield* I18nAdmin;
						const empty = { locales: [] };
						return yield* admin.locales().pipe(
							Effect.map((locales) => ({ locales })),
							Effect.catchTag("Forbidden", () => Effect.succeed(empty)),
						);
					}),
			},
			{
				id: "i18n.drafts",
				path: "/platform/i18n/drafts",
				component: I18nDraftsPlatformPage,
				guard: i18nReadGuard,
				loader: () =>
					Effect.gen(function* () {
						const admin = yield* I18nAdmin;
						const empty = { drafts: [], locales: [] };
						return yield* Effect.all({
							// Global scope only — admin.messages forces scope
							// global for plain read-grant holders; hasDraft
							// captures staged edits on published rows too.
							drafts: admin.messages({ hasDraft: true }),
							locales: admin.locales(),
						}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(empty)));
					}),
			},
			{
				id: "i18n.namespaces",
				path: "/platform/i18n/namespaces",
				component: I18nNamespacesPlatformPage,
				guard: i18nReadGuard,
				loader: () =>
					Effect.gen(function* () {
						const admin = yield* I18nAdmin;
						const empty = { namespaces: [], coverage: [], locales: [] };
						return yield* Effect.all({
							namespaces: admin.namespaces(),
							coverage: admin.coverage(),
							locales: admin.locales(),
						}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(empty)));
					}),
			},
		],
	},
});

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
