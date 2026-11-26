import { encodePointer, Validator } from "@cfworker/json-schema";
import type { OutputUnit, Schema } from "@cfworker/json-schema";

import { assertSchema, type Issue } from "./schema.ts";

/**
 * Instance validation — delegates to
 * [`@cfworker/json-schema`](https://github.com/cfworker/cfworker)
 * (Cloudflare's own spec-tested validator, draft 2020-12), which is a
 * pure interpreter: no `eval`/`new Function` anywhere, so it is safe
 * inside workerd — both in `@cloudflare/vite-plugin` dev (where every
 * SSR module is evaluated lazily through the unsafe-eval binding) and
 * at request time in production. ajv was rejected for exactly this
 * reason: its `new Function` codegen crashed `bun run dev` with
 * "Code generation from strings disallowed".
 *
 * This module is a thin adapter that preserves the `@ktb/json-schema`
 * contract on top of the engine:
 *
 * - {@link assertSchema} still gates every compile, so only the
 *   documented subset (PROFILE.md) ever reaches the engine.
 * - Engine errors (`OutputUnit`s) are normalized to {@link Issue}s:
 *   instance locations become the dot/bracket data paths consumers
 *   expect, wrapper errors (`properties`/`items`/`allOf`/`$ref`) that
 *   only echo a child failure are dropped, `additionalProperties`
 *   boolean-schema noise is folded into the parent-level issue, and
 *   `oneOf` multi-match runs report only the `oneOf` issue itself.
 * - `required` messages keep the legacy `must have required property
 *   'x'` phrasing — plugins/forms parses that exact template
 *   (`missingRequiredProperty` in schema-utils.ts).
 * - Instance values are normalized to JSON-safe data first: `undefined`
 *   object members are dropped (absent, like ajv), array holes and
 *   other non-JSON values become `null` — the engine throws on
 *   `undefined`/function/symbol/bigint instances.
 *
 * Errors are sorted by (path, keyword, message) in code-unit order —
 * stable across runs and engines, safe to render directly in UI.
 */

/** One validation failure against instance data. `path` is a
 * dot/bracket path into the value ("$" for the root, "a.b[0]" for
 * nested); `keyword` is the JSON Schema keyword that failed;
 * `message` is the human-readable detail. Empty list = valid. */
export type ValidationIssue = Issue;

/** A compiled, reusable validator for one schema. */
export interface JsonSchemaValidator {
	/** All violations of `value`, sorted deterministically. */
	readonly validate: (value: unknown) => readonly ValidationIssue[];
	/** True when `value` satisfies the schema. */
	readonly isValid: (value: unknown) => boolean;
}

/** Convert an engine instanceLocation ("#/a/b/0", "#" for root) into
 * the dot/bracket form used in issue paths ("a.b[0]", "$" for root).
 * Segments are percent-decoded (the engine URI-encodes pointer
 * segments) then JSON-pointer-unescaped (`~1` → "/" before `~0` →
 * "~"). The engine only emits "#"-rooted locations, so the shape is
 * trusted. */
const instancePathToPath = (instanceLocation: string): string => {
	if (instanceLocation === "#") return "$";
	let out = "";
	for (const raw of instanceLocation.slice(2).split("/")) {
		const segment = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
		if (/^\d+$/.test(segment)) {
			out += `[${segment}]`;
		} else {
			out += out === "" ? segment : `.${segment}`;
		}
	}
	// A root-level array violation starts with "[" — anchor it at "$".
	return out.startsWith("[") ? `$${out}` : out;
};

const compareIssues = (a: Issue, b: Issue): number => {
	// Stryker disable next-line EqualityOperator: guarded by a.path !== b.path, so < and <= coincide here.
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	// Stryker disable next-line EqualityOperator: guarded by a.keyword !== b.keyword, so < and <= coincide here.
	if (a.keyword !== b.keyword) return a.keyword < b.keyword ? -1 : 1;
	// Stryker disable next-line ConditionalExpression, EqualityOperator: equal messages mean identical issues (path and keyword already matched), so returning 1 instead of 0 is unobservable; and < vs <= coincide inside the !== guard.
	if (a.message !== b.message) return a.message < b.message ? -1 : 1;
	return 0;
};

/** Values the engine cannot represent — `undefined`, functions,
 * symbols and bigints have no JSON Schema instance type. */
const isNonJsonValue = (value: unknown): boolean =>
	value === undefined ||
	typeof value === "function" ||
	typeof value === "symbol" ||
	typeof value === "bigint";

/**
 * Normalize an instance value to JSON-safe data before validation:
 * non-JSON object members are dropped (matching `JSON.stringify`
 * semantics — `undefined` counts as absent for `required`,
 * `properties` and `additionalProperties`), non-JSON array entries and
 * a non-JSON root become `null`. Returns the input unchanged (same
 * reference) when nothing needed rewriting, so clean JSON values cost
 * no allocation. Cyclic structures are left as-is — the engine walks
 * them bounded by schema depth, same as before.
 */
const normalizeInstance = (value: unknown, seen: Set<object> = new Set()): unknown => {
	if (Array.isArray(value)) {
		if (seen.has(value)) return value;
		seen.add(value);
		let changed = false;
		const out = new Array<unknown>(value.length);
		for (let i = 0; i < value.length; i += 1) {
			const entry = value[i];
			if (isNonJsonValue(entry)) {
				out[i] = null;
				changed = true;
				continue;
			}
			const next = normalizeInstance(entry, seen);
			out[i] = next;
			if (next !== entry) changed = true;
		}
		seen.delete(value);
		return changed ? out : value;
	}
	if (typeof value === "object" && value !== null) {
		if (seen.has(value)) return value;
		seen.add(value);
		let changed = false;
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (isNonJsonValue(entry)) {
				changed = true;
				continue;
			}
			const next = normalizeInstance(entry, seen);
			out[key] = next;
			if (next !== entry) changed = true;
		}
		seen.delete(value);
		return changed ? out : value;
	}
	return isNonJsonValue(value) ? null : value;
};

/** Engine keywords that only wrap child failures — the child errors
 * carry the detail, so the wrapper is dropped. (`anyOf`, `oneOf` and
 * `not` are NOT wrappers: they are contract-level issues.) */
const WRAPPER_KEYWORDS: ReadonlySet<string> = new Set(["properties", "items", "allOf", "$ref"]);

/** `Instance does not match exactly one subschema (N matches).` — the
 * match count decides whether branch errors survive (0 matches) or are
 * dropped (>1 matches, per the Issue contract). */
const ONE_OF_MATCHES = /\((\d+) matches\)/;

/** `Instance does not have required property "key".` — rewritten to the
 * legacy ajv phrasing plugins/forms parses. */
const REQUIRED_MESSAGE = /^Instance does not have required property "(.*)"\.$/;

/** `Property "key" does not match additional properties schema.` — the
 * key identifies which member-path error belongs to the wrapper. */
const ADDITIONAL_MESSAGE = /^Property "(.*)" does not match additional properties schema\.$/;

/** Join an instanceLocation with one encoded pointer segment. */
const joinLocation = (base: string, segment: string): string =>
	base === "#" ? `#/${segment}` : `${base}/${segment}`;

/** Map one surviving engine error to an {@link Issue}. */
const toIssue = (error: OutputUnit): Issue => {
	let message = error.error;
	if (error.keyword === "required") {
		// The engine's template is fixed (`Instance does not have
		// required property "key".`), so the capture always exists.
		message = `must have required property '${REQUIRED_MESSAGE.exec(message)![1]}'`;
	}
	return {
		path: instancePathToPath(error.instanceLocation),
		// The engine reports boolean `false` schemas under the keyword
		// "false"; the contract calls it "false schema".
		keyword: error.keyword === "false" ? "false schema" : error.keyword,
		message,
	};
};

/**
 * Normalize raw engine errors into contract {@link Issue}s:
 *
 * - `oneOf` failures with more than one matching branch drop every
 *   error inside that `oneOf` (contract: only the `oneOf` issue
 *   itself); zero-match failures keep branch errors.
 * - `additionalProperties` wrappers pair with the member-path error
 *   they name: a boolean-`false` subschema folds into the parent-level
 *   `additionalProperties` issue (dropping the member "false" noise),
 *   while a real subschema keeps its member errors and loses the
 *   wrapper.
 * - Wrapper keywords are dropped; the rest map through {@link toIssue}.
 */
const normalizeErrors = (errors: readonly OutputUnit[]): Issue[] => {
	const dropped = new Set<number>();

	for (const [index, error] of errors.entries()) {
		if (error.keyword !== "oneOf") continue;
		// The engine always reports the match count; >1 means the
		// contract keeps only the oneOf issue itself. Its branch errors
		// form a contiguous block right after the oneOf error (the
		// engine splices the oneOf error ahead of them): marked errors
		// carry the branch schemaLocation, while boolean-`false` leaf
		// errors only carry the instance location — recognized by
		// keyword while inside the block. The scan stops at the first
		// error that is neither, which belongs to a later keyword.
		const matches = Number(ONE_OF_MATCHES.exec(error.error)![1]);
		if (matches <= 1) continue;
		const prefix = `${error.keywordLocation}/`;
		for (let j = index + 1; j < errors.length; j += 1) {
			const other = errors[j];
			if (!other.keywordLocation.startsWith(prefix) && other.keyword !== "false") break;
			dropped.add(j);
		}
	}

	for (const [index, error] of errors.entries()) {
		if (error.keyword !== "additionalProperties" || dropped.has(index)) continue;
		// The engine always names the offending property; the encoded
		// segment locates its member-path error.
		const childLocation = joinLocation(
			error.instanceLocation,
			encodePointer(ADDITIONAL_MESSAGE.exec(error.error)![1]),
		);
		const pairIndex = errors.findIndex(
			(other, otherIndex) =>
				otherIndex !== index &&
				!dropped.has(otherIndex) &&
				other.keyword === "false" &&
				other.instanceLocation === childLocation,
		);
		if (pairIndex === -1) {
			dropped.add(index);
		} else {
			dropped.add(pairIndex);
		}
	}

	const issues: Issue[] = [];
	for (const [index, error] of errors.entries()) {
		if (dropped.has(index) || WRAPPER_KEYWORDS.has(error.keyword)) continue;
		issues.push(toIssue(error));
	}
	return issues.sort(compareIssues);
};

/** Wrap a schema as a {@link JsonSchemaValidator} backed by the
 * engine — one `Validator` collecting all errors for {@link
 * JsonSchemaValidator.validate}, one short-circuiting for
 * {@link JsonSchemaValidator.isValid}. */
const wrapEngine = (schema: boolean | Schema): JsonSchemaValidator => {
	const engine = new Validator(schema, "2020-12", false);
	const engineFast = new Validator(schema, "2020-12", true);
	return {
		validate: (value) => normalizeErrors(engine.validate(normalizeInstance(value)).errors),
		isValid: (value) => engineFast.validate(normalizeInstance(value)).valid,
	};
};

/** Compiled validators keyed by schema object identity — schemas are
 * treated as immutable defs (the same convention as document-store
 * collection defs). */
const validatorCache = new WeakMap<object, JsonSchemaValidator>();

/**
 * String-keyed companion cache for callers whose schema objects are
 * re-materialized per request (e.g. wizard step schemas arriving as
 * fresh `JSON.parse` output on every run view — the WeakMap above
 * misses on every new object identity and engine setup repeats each
 * time). Two schema documents with identical JSON are semantically
 * identical — the subset is pure JSON data — so sharing one compiled
 * validator is safe. Bounded FIFO: schemas are immutable, so eviction
 * only costs a re-setup.
 */
const VALIDATOR_CACHE_LIMIT = 100;
const validatorCacheByJson = new Map<string, JsonSchemaValidator>();

const cacheValidator = (key: string, validator: JsonSchemaValidator): void => {
	if (validatorCacheByJson.size >= VALIDATOR_CACHE_LIMIT) {
		// FIFO eviction — Map iteration is insertion-ordered; a map at
		// the cap is never empty, so the first key always exists.
		validatorCacheByJson.delete(validatorCacheByJson.keys().next().value as string);
	}
	validatorCacheByJson.set(key, validator);
};

/**
 * Compile `schema` into a reusable validator. Throws
 * {@link SchemaDefinitionError} when the schema is outside the subset.
 * Prefer this over {@link validate} when the same schema validates many
 * values (form defs, collection schemas).
 */
export const compileSchema = (schema: unknown): JsonSchemaValidator => {
	assertSchema(schema);
	if (typeof schema === "boolean") {
		return wrapEngine(schema);
	}
	const cached = validatorCache.get(schema);
	if (cached !== undefined) return cached;
	// Schema docs are pure JSON (assertSchema rejected everything
	// else), so stringify is total here and doubles as the stable
	// cross-identity cache key.
	const jsonKey = JSON.stringify(schema);
	const byJson = validatorCacheByJson.get(jsonKey);
	if (byJson !== undefined) {
		validatorCache.set(schema, byJson);
		return byJson;
	}
	// JsonSchemaObject's readonly arrays don't line up with the
	// engine's mutable Schema type — the documents are pure JSON, so
	// the cast is safe.
	const validator = wrapEngine(schema as unknown as Schema);
	validatorCache.set(schema, validator);
	cacheValidator(jsonKey, validator);
	return validator;
};

/**
 * One-shot validation: compile `schema` (cached per schema object) and
 * return every violation of `value`, sorted deterministically.
 * Throws {@link SchemaDefinitionError} for out-of-subset schemas.
 */
export const validate = (schema: unknown, value: unknown): readonly ValidationIssue[] =>
	compileSchema(schema).validate(value);
