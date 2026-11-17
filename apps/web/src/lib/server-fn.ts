/**
 * Server-function dispatch helpers. TanStack Start routes server-fn
 * calls to `/<serverFnBase>/<serverFnId>` — the id is the createServerFn
 * identifier the compiler generated (sha256 of `file--export` by
 * default), the same string the access log records as `path`.
 */

/** Default `serverFns.base` (see @tanstack/start-plugin-core schema);
 * the router basepath, when configured, prefixes it — matched by
 * substring so a basepath doesn't hide the id. */
const SERVER_FN_BASE = "/_serverFn/";

/**
 * Extract the createServerFn id from a request pathname, or undefined
 * for non-server-fn paths. Only the first segment after the base is the
 * id — anything deeper is payload, not identity.
 */
export const serverFnIdFromPathname = (pathname: string): string | undefined => {
	const base = pathname.indexOf(SERVER_FN_BASE);
	if (base === -1) return undefined;
	const id = pathname.slice(base + SERVER_FN_BASE.length).split("/")[0];
	return id === "" ? undefined : id;
};
