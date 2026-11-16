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

/**
 * DB-slice messages with code-catalog fallback (PL-008 Phase 4):
 * plugin views call `sliceMessages(ctx.i18n, "ns", xMessages(locale))`
 * and keep their typed message object. String fields resolve from the
 * catalog slice (`ns.key`); misses and non-string (function) fields
 * keep the code-catalog value, so partially migrated catalogs degrade
 * gracefully. When `slice` is absent the fallback returns unchanged.
 */
export const sliceMessages = <M extends object>(
	slice:
		| { readonly locale: string; readonly catalog: Readonly<Record<string, string>> }
		| undefined,
	namespace: string,
	fallback: M,
): M => {
	if (slice === undefined) return fallback;
	const t = createCatalogT(slice.catalog, slice.locale);
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(fallback)) {
		const fb = (fallback as Record<string, unknown>)[key];
		if (typeof fb !== "string") {
			out[key] = fb;
			continue;
		}
		const full = `${namespace}.${key}`;
		const resolved = t(full);
		out[key] = resolved === full ? fb : resolved;
	}
	return out as M;
};
