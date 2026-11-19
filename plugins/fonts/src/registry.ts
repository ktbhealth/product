import type { Json } from "effect/Schema";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Db } from "@ktb/db";

/**
 * FontProviders — the font-source adapter registry. Each adapter
 * declares a `kind` and can list the catalog entries it offers; the
 * `Fonts` service syncs a provider row's `font_families` from its
 * adapter's catalog.
 *
 * The built-in adapters ("local" theme_assets fonts, "googlefonts"
 * embedded catalog) are registered by the services layer at build
 * time; other plugins register additional kinds the same way —
 * `yield* FontProviders` then `register`, inside their own services
 * layer, never per-request.
 */

/** One catalog entry an adapter offers for sync. */
export interface FontCatalogEntry {
	readonly family: string;
	readonly weights?: readonly number[];
	readonly meta?: Record<string, Json>;
}

export interface FontProviderAdapter {
	/** Registry key — stored on `font_providers.kind`. */
	readonly kind: string;
	/** Catalog entries the provider can offer. Runs with `Db` in
	 * context (the caller provides it — see service.ts). */
	readonly list: () => Effect.Effect<readonly FontCatalogEntry[], unknown, Db>;
}

export class FontProviders extends Context.Service<
	FontProviders,
	{
		/** Register an adapter. Re-registering a kind replaces the
		 * previous adapter (last wins — deterministic in topo order). */
		readonly register: (adapter: FontProviderAdapter) => void;
		/** Look up an adapter without listing — sync/introspection. */
		readonly get: (kind: string) => FontProviderAdapter | undefined;
		/** Registered kinds, sorted — feeds the admin "add provider" picker. */
		readonly kinds: () => readonly string[];
	}
>()("@ktb/fonts/FontProviders") {}

/** Empty registry — adapters register at services-layer build. */
export const FontProvidersLive = Layer.sync(FontProviders, () => {
	const adapters = new Map<string, FontProviderAdapter>();
	return FontProviders.of({
		register: (adapter) => {
			adapters.set(adapter.kind, adapter);
		},
		get: (kind) => adapters.get(kind),
		kinds: () => [...adapters.keys()].sort(),
	});
});

export type FontProvidersService = FontProviders["Service"];
