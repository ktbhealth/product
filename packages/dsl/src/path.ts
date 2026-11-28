import { hasForbiddenPathSegment } from "./grammar.ts";

/**
 * Dotted-path accessors over plain JSON documents — the read/write
 * primitives every declarative runtime shares (conditions, templates,
 * flow `set-field` writes, view field reads).
 *
 * HARDENING CONTRACT: all object access is own-property only
 * (`Object.hasOwn`), never `in`/bare prototype-chain indexing —
 * `"__proto__"`/`"constructor"` segments must not reach
 * Object.prototype members. {@link setPath} additionally refuses any
 * path containing a forbidden segment outright (defense-in-depth for
 * hand-built defs that bypassed assert-time validation).
 */

/** Dotted-path read: `"a.b.c"` walks nested objects/arrays by numeric
 * segments. Missing segments yield `undefined`. */
export const getPath = (data: unknown, path: string): unknown => {
	let current: unknown = data;
	for (const segment of path.split(".")) {
		// Stryker disable next-line ConditionalExpression: dropping the
		// `undefined` half of this check is harmless — undefined is not an
		// object, so the typeof guard below returns undefined either way.
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			// Canonical decimal indices only (same convention setPath uses
			// for next-segment detection) — "", "1e2", "0x10", " 1" are
			// NOT array indices even though Number() parses some of them.
			if (!/^\d+$/.test(segment)) return undefined;
			current = current[Number(segment)];
			continue;
		}
		if (typeof current !== "object") return undefined;
		// Own-property walk only — `"__proto__"`/`"constructor"` segments
		// must not reach Object.prototype members.
		if (!Object.hasOwn(current, segment)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
};

/** Set `value` at a dotted `path` inside `root`, creating intermediate
 * objects (or arrays when the NEXT segment is numeric). Paths with
 * forbidden segments are refused silently — callers validate at def
 * time; this guard is defense-in-depth for hand-built defs. */
export const setPath = (root: Record<string, unknown>, path: string, value: unknown): void => {
	if (hasForbiddenPathSegment(path)) return;
	const segments = path.split(".");
	let current: Record<string, unknown> | unknown[] = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i] as string;
		const nextSegment = segments[i + 1] as string;
		const existing = (current as Record<string, unknown>)[segment];
		if (existing === null || typeof existing !== "object") {
			(current as Record<string, unknown>)[segment] = /^\d+$/.test(nextSegment) ? [] : {};
		}
		current = (current as Record<string, unknown>)[segment] as Record<string, unknown> | unknown[];
	}
	const leaf = segments[segments.length - 1] as string;
	(current as Record<string, unknown>)[leaf] = value;
};

const TEMPLATE_RE = /^\$([A-Za-z]+)\.(.+)$/;

/** Resolve a `"$<root>.<dot.path>"` template string against `scope`:
 * the root segment is an OWN property of `scope` (so `"$constructor.x"`
 * can never reach Object.prototype members) and the remainder is a
 * {@link getPath} walk. Returns `undefined` for non-templates,
 * unknown roots and unresolvable paths — callers decide whether that
 * means literal passthrough ({@link resolveTemplate}) or a hard error.
 * `scope` is typed `object` (not `Record<string, unknown>`) so callers
 * with interface-typed scopes — e.g. flows' `TransitionScope` — fit
 * without casts. */
export const resolvePath = (value: unknown, scope: object): unknown => {
	if (typeof value !== "string") return undefined;
	const match = TEMPLATE_RE.exec(value);
	if (match === null) return undefined;
	const [, root, path] = match;
	if (!Object.hasOwn(scope, root)) return undefined;
	return getPath((scope as Record<string, unknown>)[root], path);
};
