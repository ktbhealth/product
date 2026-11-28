import { isParametrizedMessage, renderMessage, zipArgs } from "./message.ts";

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
 * Flatten a (possibly nested) message catalog to dot-path leaves —
 * `{ sections: { identification: "ID" } }` → `sections.identification`.
 * Non-string leaves (function messages) are returned too so callers can
 * warn/skip; only plain objects recurse (arrays stay atomic leaves).
 */
export const flattenCatalog = (
	catalog: Readonly<Record<string, unknown>>,
	prefix = "",
): ReadonlyArray<{ readonly path: string; readonly value: unknown }> => {
	const out: Array<{ path: string; value: unknown }> = [];
	for (const [key, value] of Object.entries(catalog)) {
		const path = prefix === "" ? key : `${prefix}.${key}`;
		// Recurse into PLAIN objects only — exotic objects (Date, Map,
		// class instances) have no enumerable message entries and would
		// silently vanish; they belong in the leaf branch like arrays.
		if (isPlainObject(value)) {
			out.push(...flattenCatalog(value, path));
		} else {
			out.push({ path, value });
		}
	}
	return out;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

/** Matches an MF1 param token (`{name}`, `{n, plural, …}`) — used to
 * detect templates that need runtime params. */
const PARAM_TOKEN_RE = /\{[A-Za-z_][^}]*\}/;

/**
 * DB-slice messages with code-catalog fallback (PL-008 Phase 4):
 * plugin views call `sliceMessages(ctx.i18n, "ns", xMessages(locale))`
 * and keep their typed message object. String leaves resolve from the
 * catalog slice (`ns.dot.path`); misses, non-string (function) fields
 * and param-bearing DB templates keep the code-catalog value, so
 * partially migrated catalogs degrade gracefully. When `slice` is
 * absent the fallback returns unchanged.
 *
 * Param-bearing templates are skipped for STRING leaves because the
 * sliced catalog is pre-rendered — there is no call site to supply
 * `{name}` values, so overlaying one would blank the params.
 * ParametrizedMessage function leaves are the migration path: the
 * wrapper re-binds positional args to the (possibly DB-overridden)
 * template at call time, so param-bearing DB templates apply to them.
 */
export const sliceMessages = <M extends object>(
	slice:
		| { readonly locale: string; readonly catalog: Readonly<Record<string, string>> }
		| undefined,
	namespace: string,
	fallback: M,
): M => {
	if (slice === undefined) return fallback;
	const walk = (node: unknown, path: string): unknown => {
		if (typeof node === "string") {
			const full = `${namespace}.${path}`;
			const template = slice.catalog[full];
			if (template === undefined || PARAM_TOKEN_RE.test(template)) return node;
			return renderMessage(template, {}, slice.locale);
		}
		if (isParametrizedMessage(node)) {
			// DB template wins; the code catalog's i18nTemplate is the
			// fallback. Args zip against the CODE param names — the DB
			// row stores the rendered params signature separately.
			const template = slice.catalog[`${namespace}.${path}`] ?? node.i18nTemplate;
			const params = node.i18nParams;
			return Object.assign(
				(...args: readonly unknown[]) =>
					renderMessage(template, zipArgs(params, args), slice.locale),
				{ i18nTemplate: template, i18nParams: params },
			);
		}
		if (node !== null && typeof node === "object" && !Array.isArray(node)) {
			const out: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(node)) {
				out[key] = walk(value, path === "" ? key : `${path}.${key}`);
			}
			return out;
		}
		return node;
	};
	return walk(fallback, "") as M;
};
