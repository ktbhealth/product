/**
 * Shared DSL grammar — the identifier/collection/permission regexes and
 * prototype-pollution denylist that every declarative-definition plugin
 * (wizards, triggers, flows, views, api, document-store) validates
 * against. Extracted from the plugins so the spellings can never drift:
 * a collection name accepted by one def kind is accepted by all of
 * them, and a forbidden path segment is forbidden everywhere.
 *
 * Dependency-free by contract — plugins/, packages/ and apps/ all
 * consume this package.
 */

/** Plain-object check shared by every def validator — arrays are NOT
 * records even though `typeof [] === "object"`. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Prototype-polluting path segments — refused in field paths,
 * mapping keys and step ids for hygiene. A `"__proto__"` segment would
 * hit the Object.prototype setter on write paths and read inherited
 * members on unguarded lookups. */
export const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

/** True when any dot-separated segment of `path` is forbidden. */
export const hasForbiddenPathSegment = (path: string): boolean =>
	path.split(".").some((seg) => FORBIDDEN_PATH_SEGMENTS.has(seg));

/** Collection names — the shape document-store collection names use.
 * Lowercase slug with dots/dashes/underscores, max 100 chars. */
export const COLLECTION_NAME_RE = /^[a-z][a-z0-9._-]{0,99}$/;

/** Permission strings use the rbac catalog spelling
 * (`"resource.action"`, e.g. `"patient.read"`, `"audit.read"`). */
export const PERMISSION_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

/** Hook ids — handler keys on the *Hooks registries (wizards, triggers,
 * flows). Identifier-ish, dots/dashes/underscores allowed. */
export const HOOK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Lowercase slug ids — wizard/trigger/flow/view definition ids double
 * as URL segments and diagnostic keys. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Dotted field path into a record's `data` document. Segments are
 * identifier-shaped (field names) or numeric (array indices, per
 * document-store's getPath); prototype-polluting segments are refused
 * for hygiene even though reads cannot mutate. */
export const FIELD_PATH_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

/** A string that is a legal {@link FIELD_PATH_RE} path free of
 * forbidden segments — the shared `isFieldPath` guard. */
export const isFieldPath = (value: unknown): value is string =>
	typeof value === "string" && FIELD_PATH_RE.test(value) && !hasForbiddenPathSegment(value);

/** URL key charset — the `<key>` segment of `/api/documents/<key>`.
 * Slug-safe so keys round-trip through paths and query strings. */
export const API_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
