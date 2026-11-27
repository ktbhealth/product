import { PenLineIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { RichTextAdminConsolePage } from "./platform-page.tsx";
import { richTextElement } from "./kind.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the chrome entry, the panel page
 * descriptor (component only — the guard/loader Effects stay
 * server-side in ./index.ts) and the elementKinds manifest (P-102 —
 * the server descriptor registers via RichTextElementKindLive in the
 * services layer, never mirrored here). Dep ids are literals: importing ./index.ts
 * would pull the server graph (Db, services, Layers) into the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const richTextChromePlugin = definePlugin({
	id: "rich-text.chrome",
	meta: { keywords: ["rich-text", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "rich-text.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/rich-text",
					label: "Rich text",
					icon: PenLineIcon,
					group: "Site",
				},
			},
		},
	],
});

export const richTextPanelPlugin = definePlugin({
	id: "rich-text.panel",
	meta: { keywords: ["rich-text", "ui"] },
	requiredDeps: ["platform.panel", "rich-text.services"],
	panel: {
		pages: [
			{
				id: "rich-text.admin",
				path: "/platform/rich-text",
				component: RichTextAdminConsolePage,
			},
		],
	},
});

/** Element-kind manifest (P-102): `richTextElement.manifest` is the
 * SAME object richTextElementsPlugin carries in ./index.ts — the kind
 * is declared once in ./kind.tsx via `defineElementKind`, so client and
 * server manifests cannot drift (RichTextView is platejs-free;
 * RichTextElementEditor pulls the editor stack, which the client
 * bundle already carries via the admin console page). The server
 * descriptor registers via RichTextElementKindLive — never mirrored
 * here. */
export const richTextElementsPlugin = definePlugin({
	id: "rich-text.elements",
	meta: { keywords: ["rich-text", "ui"] },
	elementKinds: [richTextElement.manifest],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	// Mirrors richTextTablesPlugin/richTextServicesPlugin (server index.ts)
	// minus their server-only slices — tables/services never reach the
	// client bundle, but the ids must exist so dep edges and enabled-state
	// filtering line up with the server registry.
	definePlugin({ id: "rich-text.tables", meta: { keywords: ["rich-text", "tables"] } }),
	definePlugin({
		id: "rich-text.services",
		meta: { keywords: ["rich-text", "services"] },
		requiredDeps: ["platform.admin"],
	}),
	richTextChromePlugin,
	richTextPanelPlugin,
	richTextElementsPlugin,
];
