import type { JsonSchema } from "./types.ts";

/**
 * Subset-conformance checker for `@ktb/json-schema` (see PROFILE.md).
 *
 * `checkSchema` walks an untyped schema document and reports every way
 * it falls outside the supported draft-2020-12 subset: unknown keywords,
 * malformed keyword values, remote/recursive/unresolvable `$ref`s, and
 * unsafe `pattern` regexes. It is deliberately stricter than the JSON
 * Schema meta-schema — the subset is a contract, so anything outside it
 * is a definition error, not a validation detail.
 *
 * Safety bounds (ReDoS / pathological documents):
 * - `pattern` sources are capped at {@link MAX_PATTERN_LENGTH} chars and
 *   screened with the same nested-quantifier heuristic as
 *   plugins/document-store (`(a+)+`-style catastrophic backtracking).
 * - Schema documents are capped at {@link MAX_SCHEMA_DEPTH} nesting
 *   levels and {@link MAX_SCHEMA_NODES} visited nodes; `$ref` targets
 *   are walked inline so ref chains count against the same budget.
 * - Circular JS objects and recursive `$ref`s are rejected — a schema
 *   is a finite tree (plus non-recursive internal refs).
 * - Issue output is capped at {@link MAX_ISSUES} entries so a hostile
 *   document can't flood the reporter.
 */

/** One problem found in a schema definition. `path` is a JSON-pointer-
 * style location inside the schema document ("/properties/a/pattern");
 * `keyword` names the offending keyword (or "schema"/"$ref" for
 * structural problems); `message` is human-readable. */
export interface Issue {
	readonly path: string;
	readonly keyword: string;
	readonly message: string;
}

/** `pattern` source length cap — same bound as document-store queries. */
export const MAX_PATTERN_LENGTH = 200;
/** Maximum schema nesting depth (object/array/combinator/$ref hops). */
export const MAX_SCHEMA_DEPTH = 64;
/** Maximum schema nodes visited per check — bounds ref fan-out. */
export const MAX_SCHEMA_NODES = 2048;
/** Maximum issues reported per check — bounds hostile documents. */
export const MAX_ISSUES = 100;

/** The seven draft-2020-12 primitive types. */
export const JSON_SCHEMA_TYPES = [
	"string",
	"number",
	"integer",
	"boolean",
	"null",
	"object",
	"array",
] as const;

const TYPE_NAMES: ReadonlySet<string> = new Set(JSON_SCHEMA_TYPES);

/** Keywords the subset understands. Anything else is rejected — a typo
 * like `min`/`max` (document-store vocabulary) fails loudly instead of
 * silently validating nothing. */
const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
	// Structure / typing
	"$schema",
	"$ref",
	"type",
	"enum",
	"const",
	// Object
	"properties",
	"required",
	"additionalProperties",
	"minProperties",
	"maxProperties",
	// Array
	"items",
	"minItems",
	"maxItems",
	// String / number bounds
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	// Combinators
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	// Annotations (ignored by validation, kept for form/wizard UIs)
	"title",
	"description",
	"default",
	"$comment",
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const typeName = (v: unknown): string => (Array.isArray(v) ? "array" : typeof v);

/** JSON-value check for `enum`/`const` payloads — rejects undefined,
 * functions, symbols and circular structures (seen-set). */
const isJsonValue = (value: unknown, seen: Set<unknown>): boolean => {
	if (value === null) return true;
	switch (typeof value) {
		case "string":
		case "boolean":
			return true;
		case "number":
			return Number.isFinite(value);
		case "object": {
			if (seen.has(value)) return false;
			if (!Array.isArray(value)) {
				const proto = Object.getPrototypeOf(value);
				if (proto !== Object.prototype && proto !== null) return false;
			}
			seen.add(value);
			const ok = Array.isArray(value)
				? value.every((v) => isJsonValue(v, seen))
				: Object.values(value as Record<string, unknown>).every((v) => isJsonValue(v, seen));
			seen.delete(value);
			return ok;
		}
		default:
			return false;
	}
};

/** Same nested-quantifier heuristic as document-store's query guard —
 * flags a quantified group whose body contains a quantifier
 * (`(a+)+`, `(\d*)*`). Deliberately not a full regex parser; patterns
 * here come from trusted server-side schema defs, this is defense in
 * depth, not a security boundary. */
const NESTED_QUANTIFIER_RE = /\([^()]*[+*?{][^()]*\)\s*[+*?{]/;

interface WalkState {
	readonly issues: Issue[];
	/** Nodes visited so far — shared across the whole document incl.
	 * inline-walked `$ref` targets. */
	nodes: number;
	/** Schema objects on the current descent path — catches both
	 * direct JS-object cycles and recursive `$ref` resolution. */
	readonly objectStack: Set<object>;
}

const pushIssue = (state: WalkState, path: string, keyword: string, message: string): void => {
	if (state.issues.length < MAX_ISSUES) {
		state.issues.push({ path, keyword, message });
	}
};

const isNonNegativeInteger = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 0;

/** RFC 6901 unescape: `~1` → `/` first, then `~0` → `~` (so `~01`
 * decodes to `~1`, not `/`). */
const unescapePointerSegment = (segment: string): string =>
	segment.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Resolve an internal `$ref` ("#" or "#/a/b/0") against the schema
 * root. Returns the target node, or null when the pointer is malformed
 * or does not resolve. Percent-encoding and remote refs are rejected
 * by the caller before this runs.
 */
const resolvePointer = (root: unknown, ref: string): unknown => {
	// Callers only pass "#" or "#/…" — see checkRef.
	if (ref === "#") return root;
	let current: unknown = root;
	for (const rawSegment of ref.slice(2).split("/")) {
		const segment = unescapePointerSegment(rawSegment);
		if (Array.isArray(current)) {
			if (!/^\d+$/.test(segment)) return null;
			const index = Number(segment);
			if (index >= current.length) return null;
			current = current[index];
			continue;
		}
		if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return null;
		current = current[segment];
	}
	return current;
};

const checkRef = (
	ref: unknown,
	path: string,
	root: unknown,
	state: WalkState,
	depth: number,
): void => {
	if (typeof ref !== "string") {
		pushIssue(state, path, "$ref", "$ref must be a string");
		return;
	}
	if (ref === "#" || ref.startsWith("#/")) {
		if (ref.includes("%")) {
			pushIssue(
				state,
				path,
				"$ref",
				"$ref must be a plain JSON pointer — percent-encoding is not supported",
			);
			return;
		}
		const target = resolvePointer(root, ref);
		if (target === null || target === undefined) {
			pushIssue(state, path, "$ref", `$ref "${ref}" does not resolve inside the schema`);
			return;
		}
		// Walk the target inline: ref chains and fan-out count against
		// the node/depth budgets, and the objectStack catches recursion
		// (a $ref back to an ancestor object).
		walkSchema(target, path, root, state, depth + 1);
		return;
	}
	pushIssue(
		state,
		path,
		"$ref",
		`$ref "${ref}" is not an internal JSON pointer — remote refs are not supported`,
	);
};

const checkType = (value: unknown, path: string, state: WalkState): void => {
	const entries = Array.isArray(value) ? value : [value];
	if (entries.length === 0) {
		pushIssue(state, path, "type", "type array must not be empty");
		return;
	}
	const seen = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "string" || !TYPE_NAMES.has(entry)) {
			pushIssue(
				state,
				path,
				"type",
				`type must be one of ${JSON_SCHEMA_TYPES.join(", ")} or an array of them`,
			);
			return;
		}
		if (seen.has(entry)) {
			pushIssue(state, path, "type", `duplicate type "${entry}"`);
			return;
		}
		seen.add(entry);
	}
};

const checkStringArray = (
	value: unknown,
	path: string,
	keyword: string,
	state: WalkState,
): void => {
	if (!Array.isArray(value)) {
		pushIssue(state, path, keyword, `${keyword} must be an array`);
		return;
	}
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0) {
			pushIssue(state, path, keyword, `${keyword} entries must be non-empty strings`);
			return;
		}
		if (seen.has(entry)) {
			pushIssue(state, path, keyword, `${keyword} entries must be unique`);
			return;
		}
		seen.add(entry);
	}
};

const checkBound = (value: unknown, path: string, keyword: string, state: WalkState): void => {
	if (!isNonNegativeInteger(value)) {
		pushIssue(state, path, keyword, `${keyword} must be a non-negative integer`);
	}
};

const checkNumberBound = (
	value: unknown,
	path: string,
	keyword: string,
	state: WalkState,
): void => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		pushIssue(state, path, keyword, `${keyword} must be a finite number`);
	}
};

const checkSchemaArray = (
	value: unknown,
	path: string,
	keyword: string,
	root: unknown,
	state: WalkState,
	depth: number,
): void => {
	if (!Array.isArray(value) || value.length === 0) {
		pushIssue(state, path, keyword, `${keyword} must be a non-empty array of schemas`);
		return;
	}
	value.forEach((sub, i) => walkSchema(sub, `${path}/${i}`, root, state, depth + 1));
};

const checkKeyword = (
	key: string,
	value: unknown,
	path: string,
	root: unknown,
	state: WalkState,
	depth: number,
): void => {
	switch (key) {
		case "$schema":
		case "title":
		case "description":
		case "$comment":
			if (typeof value !== "string") {
				pushIssue(state, path, key, `${key} must be a string`);
			}
			return;
		case "default":
			if (!isJsonValue(value, new Set())) {
				pushIssue(state, path, key, "default must be a JSON value");
			}
			return;
		case "$ref":
			checkRef(value, path, root, state, depth);
			return;
		case "type":
			checkType(value, path, state);
			return;
		case "properties": {
			if (!isPlainObject(value)) {
				pushIssue(state, path, key, "properties must be an object of schemas");
				return;
			}
			for (const [name, sub] of Object.entries(value)) {
				walkSchema(sub, `${path}/${escapeSegment(name)}`, root, state, depth + 1);
			}
			return;
		}
		case "required":
			checkStringArray(value, path, key, state);
			return;
		case "additionalProperties":
		case "items":
		case "not":
			walkSchema(value, path, root, state, depth + 1);
			return;
		case "enum": {
			if (!Array.isArray(value)) {
				pushIssue(state, path, key, "enum must be an array");
				return;
			}
			for (const entry of value) {
				if (!isJsonValue(entry, new Set())) {
					pushIssue(state, path, key, "enum entries must be JSON values");
					return;
				}
			}
			return;
		}
		case "const":
			if (!isJsonValue(value, new Set())) {
				pushIssue(state, path, key, "const must be a JSON value");
			}
			return;
		case "pattern": {
			if (typeof value !== "string") {
				pushIssue(state, path, key, "pattern must be a string");
				return;
			}
			if (value.length > MAX_PATTERN_LENGTH) {
				pushIssue(state, path, key, `pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
				return;
			}
			if (NESTED_QUANTIFIER_RE.test(value)) {
				pushIssue(state, path, key, "pattern has nested quantifiers (ReDoS risk)");
				return;
			}
			try {
				new RegExp(value);
			} catch {
				pushIssue(state, path, key, "pattern is not a valid regular expression");
			}
			return;
		}
		case "minLength":
		case "maxLength":
		case "minItems":
		case "maxItems":
		case "minProperties":
		case "maxProperties":
			checkBound(value, path, key, state);
			return;
		case "minimum":
		case "maximum":
			checkNumberBound(value, path, key, state);
			return;
		case "allOf":
		case "anyOf":
		case "oneOf":
			checkSchemaArray(value, path, key, root, state, depth);
			return;
	}
	// No default: walkSchema filters keys against ALLOWED_KEYWORDS
	// before dispatching, so every reachable key is handled above.
};

/** Escape a property name for JSON-pointer-style issue paths. */
const escapeSegment = (segment: string): string => segment.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * Walk one schema node. `path` is the JSON-pointer location inside the
 * schema document (used only for issue reporting). Boolean schemas are
 * valid leaves. `root` is the document root for `$ref` resolution.
 */
const walkSchema = (
	node: unknown,
	path: string,
	root: unknown,
	state: WalkState,
	depth: number,
): void => {
	if (state.nodes >= MAX_SCHEMA_NODES) {
		pushIssue(state, path, "schema", `schema exceeds ${MAX_SCHEMA_NODES} nodes`);
		return;
	}
	state.nodes += 1;
	if (depth > MAX_SCHEMA_DEPTH) {
		pushIssue(state, path, "schema", `schema exceeds depth ${MAX_SCHEMA_DEPTH}`);
		return;
	}
	if (typeof node === "boolean") return;
	if (!isPlainObject(node)) {
		pushIssue(state, path, "schema", `schema must be an object or boolean, got ${typeName(node)}`);
		return;
	}
	if (state.objectStack.has(node)) {
		pushIssue(
			state,
			path,
			"$ref",
			"recursive schema — $ref cycles and circular objects are not supported",
		);
		return;
	}
	state.objectStack.add(node);
	try {
		for (const [key, value] of Object.entries(node)) {
			if (!ALLOWED_KEYWORDS.has(key)) {
				pushIssue(
					state,
					`${path}/${escapeSegment(key)}`,
					key,
					`unknown keyword "${key}" — not in the @ktb/json-schema subset`,
				);
				continue;
			}
			checkKeyword(key, value, `${path}/${escapeSegment(key)}`, root, state, depth);
		}
	} finally {
		state.objectStack.delete(node);
	}
};

/**
 * Check `schema` against the subset profile. Returns the list of
 * issues found (empty = conforms). Pure and synchronous; safe to call
 * on untyped JSON at def-assertion boundaries.
 */
export const checkSchema = (schema: unknown): Issue[] => {
	const state: WalkState = { issues: [], nodes: 0, objectStack: new Set() };
	walkSchema(schema, "", schema, state, 0);
	return state.issues;
};

/** Error thrown by `assertSchema`/`compileSchema` on a schema that
 * violates the subset — carries the full issue list. */
export class SchemaDefinitionError extends Error {
	readonly issues: readonly Issue[];

	constructor(issues: readonly Issue[]) {
		super(
			`invalid @ktb/json-schema schema (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues
				.map((i) => `${i.path || "/"} ${i.keyword}: ${i.message}`)
				.join("; ")}`,
		);
		this.name = "SchemaDefinitionError";
		this.issues = issues;
	}
}

/** Assert `schema` conforms to the subset; throws
 * {@link SchemaDefinitionError} carrying every issue otherwise. On
 * success narrows `schema` to {@link JsonSchema}. */
export function assertSchema(schema: unknown): asserts schema is JsonSchema {
	const issues = checkSchema(schema);
	if (issues.length > 0) throw new SchemaDefinitionError(issues);
}
