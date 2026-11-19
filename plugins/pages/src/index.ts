import { FileTextIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import { richTextServicesPlugin } from "@ktb/rich-text";
import { RichTexts } from "@ktb/rich-text/service";

import { CustomNavLinks } from "./chrome.tsx";
import { PagesAdminConsolePage } from "./platform-page.tsx";
import { customPage } from "./schema.ts";
import { CustomPages, CustomPagesLive } from "./service.ts";
import { CustomPageView } from "./views/CustomPageView.tsx";

/**
 * Custom pages plugin (T-083): admin-authored pages stored in the
 * `custom_pages` table and rendered through the generic `pages`
 * contribution — the P-059 mechanism built for exactly this. One
 * "/*" wildcard descriptor serves every unpublished path: its `guard`
 * 404s paths with no published row and its `loader` returns the row
 * plus the resolved rich-text `content`, so DB pages need no code and
 * no route files. `publishedByPath` / `navList` are public reads
 * (anonymous visitors render published pages); every admin method
 * re-checks PlatformAdmin inside the service.
 */

export const pagesTablesPlugin = definePlugin({
	id: "pages.tables",
	meta: { keywords: ["pages", "tables"] },
	tables: { customPage },
});

export const pagesServicesPlugin = definePlugin({
	id: "pages.services",
	meta: { keywords: ["pages", "services"] },
	// adminList/adminCreate/adminUpdate/adminRemove consume the
	// PlatformAdmin gate — the dep edge keeps the platform module
	// ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	// Optional edge: the delete-hook registry lives in rich-text's
	// service layer — when it is absent CustomPagesLive simply skips
	// registration (Effect.serviceOption), but ordering must put the
	// registry before this layer when both are installed.
	optionalDeps: [richTextServicesPlugin.id],
	services: CustomPagesLive,
});

/**
 * Chrome contribution (P-060): the /platform/pages console sidebar
 * entry (Presentation group) plus the app-header nav component that lists
 * published pages flagged `showInNav` — fetched at render time via the
 * plugin's public server fn, so nav membership is data, not code.
 */
export const pagesChromePlugin = definePlugin({
	id: "pages.chrome",
	meta: { keywords: ["pages", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "pages.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/pages",
					label: "Pages",
					icon: FileTextIcon,
					group: "Presentation",
				},
			},
		},
		{
			id: "pages.nav",
			region: "app.header.nav",
			content: { kind: "component", component: CustomNavLinks },
		},
		// Rich-text delete dialog actions (region owned by
		// @ktb/rich-text): offered when the document being deleted is
		// referenced by pages. `action.id`/`owner` are the contract the
		// pages delete hook's cleanup switch keys on — keep them exact.
		{
			id: "pages.delete-action-unlink",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "pages.unlink-unpublish",
					owner: "pages",
					label: "Unlink & unpublish pages",
					description: "Pages keep their settings but lose the document and return to draft.",
					destructive: false,
				},
			},
		},
		{
			id: "pages.delete-action-delete",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "pages.delete-pages",
					owner: "pages",
					label: "Delete pages too",
					description: "Permanently deletes every page using this document.",
					destructive: true,
				},
			},
		},
	],
});

/**
 * Wildcard page descriptor: claims every app path no exact descriptor
 * or file route owns. `guard` resolves the request path against the
 * published-page table (false → the host 404s exactly like an unknown
 * path); `loader` returns the row as `data`. Both receive the request
 * path — the kernel contract for wildcard pages. The component is
 * shared by every custom page; per-page content arrives via `data`.
 */
export const pagesRenderPlugin = definePlugin({
	id: "pages.render",
	meta: { keywords: ["pages", "ui"] },
	requiredDeps: [pagesServicesPlugin.id],
	// Optional edge: page bodies live in @ktb/rich-text documents. When
	// the plugin (or its service layer) is absent the loader degrades to
	// `content: null` instead of failing the page.
	optionalDeps: [richTextServicesPlugin.id],
	pages: [
		{
			id: "pages.custom",
			path: "/*",
			context: "app",
			component: CustomPageView,
			guard: (path) =>
				Effect.gen(function* () {
					const pages = yield* CustomPages;
					return (yield* pages.publishedByPath(path)) !== null;
				}),
			loader: (path) =>
				Effect.gen(function* () {
					const pages = yield* CustomPages;
					const page = yield* pages.publishedByPath(path);
					if (page === null) return null;
					// Resolve the referenced rich-text document into `content`
					// (the parsed Plate value array, or null). Pages without a
					// document — and hosts without the rich-text service —
					// render an empty body.
					let content: unknown = null;
					if (page.richTextId !== null) {
						const richTexts = yield* Effect.serviceOption(RichTexts);
						if (Option.isSome(richTexts)) {
							const doc = yield* richTexts.value.getById(page.richTextId);
							content = doc?.content ?? null;
						}
					}
					return { ...page, content };
				}),
		},
	],
});

/**
 * Panel (system console) contribution: /platform/pages is the admin
 * CRUD surface. The loader returns every row (drafts included); the
 * service re-checks the admin gate. `guard` hard-404s non-admins —
 * same contract as the /platform layout gate.
 */
export const pagesPanelPlugin = definePlugin({
	id: "pages.panel",
	meta: { keywords: ["pages", "ui"] },
	requiredDeps: [platformPanelPlugin.id, pagesServicesPlugin.id],
	// Optional edge: the console's document picker lists @ktb/rich-text
	// documents; absent the service the picker is simply empty.
	optionalDeps: [richTextServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "pages.admin",
				path: "/platform/pages",
				component: PagesAdminConsolePage,
				// Path arg unused — the admin page is exact-path — but the
				// kernel signature passes the request path.
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
						const pages = yield* CustomPages;
						const rows = yield* pages
							.adminList()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
						// Document picker options: meta only (id + title) — the
						// admin page never needs the stored Plate value. Both
						// lists degrade to empty on Forbidden / missing service.
						const richTexts = yield* Effect.serviceOption(RichTexts);
						const docs = Option.isNone(richTexts)
							? []
							: yield* richTexts.value.adminList().pipe(
									Effect.catchTag("Forbidden", () => Effect.succeed([])),
									Effect.map((list) => list.map((doc) => ({ id: doc.id, title: doc.title }))),
								);
						// The content-document field is an optional feature:
						// the console hides it entirely when the rich-text
						// service is absent (pages still keep any stored
						// richTextId — the field just isn't editable).
						return { pages: rows, docs, richTextEnabled: Option.isSome(richTexts) };
					}),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	pagesTablesPlugin,
	pagesServicesPlugin,
	pagesChromePlugin,
	pagesRenderPlugin,
	pagesPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"pages.tables": true;
		"pages.services": true;
		"pages.chrome": true;
		"pages.render": true;
		"pages.panel": true;
	}
}
