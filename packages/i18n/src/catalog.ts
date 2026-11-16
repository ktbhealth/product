import { renderMessage } from "./message.ts";

/**
 * Client-side `t()` over a resolved catalog slice (PL-008 Phase 2):
 * the loader-data `catalog` record maps `namespace.key` → template
 * already resolved for scope + locale server-side, so this is a pure
 * map lookup + MF1 render — isomorphic, no Effect, no DB. Missing keys
 * render the `namespace.key` literal (the locked sentinel policy).
 */
export const createCatalogT =
	(catalog: Readonly<Record<string, string>>, locale: string) =>
	(key: string, params: Readonly<Record<string, unknown>> = {}): string => {
		const template = catalog[key];
		if (template === undefined) return key;
		return renderMessage(template, params, locale);
	};
