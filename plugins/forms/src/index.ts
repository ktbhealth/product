import { definePlugin, type Plugin } from "@ktb/kernel";
import * as Effect from "effect/Effect";

import { FormsPage } from "./forms-page.tsx";

/**
 * Public re-exports — the @ktb/forms surface other plugins and apps
 * consume: form definitions as data (`form.def` contributions), the
 * SchemaForm renderer, the i18n catalogs and the pure schema helpers.
 */
export * from "./definition.ts";
export * from "./i18n.ts";
export * from "./schema-utils.ts";
export { FormsPage } from "./forms-page.tsx";
export { SchemaForm, type SchemaFormProps } from "./form.tsx";

/**
 * App-shell page citizen: `/forms/*` resolves contributed `form.def`
 * entries by id. The loader just echoes the request path — the
 * component re-derives the id and looks the definition up in
 * `ctx.plugins` (enabled-filtered client registry), so no server-side
 * registry access is needed. No guard: unknown/disabled ids render
 * the localized not-found state instead of a hard 404 (same visible
 * outcome for a fillable form).
 */
export const formsPagesPlugin = definePlugin({
	id: "forms.pages",
	meta: { keywords: ["forms", "ui"] },
	pages: [
		{
			id: "forms.form",
			path: "/forms/*",
			context: "app",
			component: FormsPage,
			loader: (path) => Effect.succeed(path),
		},
	],
});

/** Single-concern plugins contributed by this module. */
export const plugins: readonly Plugin[] = [formsPagesPlugin];

// Compile-time dep registry.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"forms.pages": true;
	}
}
