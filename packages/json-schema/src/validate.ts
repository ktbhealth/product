import Ajv2020, { type ErrorObject, type SchemaObject, type ValidateFunction } from "ajv/dist/2020";

import { assertSchema, type Issue } from "./schema.ts";

/**
 * Instance validation — compiles a subset schema to a reusable
 * validator and maps ajv errors into deterministic {@link Issue}s.
 *
 * The engine is ajv's draft-2020-12 build (`ajv/dist/2020`): pure JS,
 * no Node APIs, safe for workerd. `compileSchema`/`validate` first run
 * {@link assertSchema}, so anything outside the documented subset
 * (PROFILE.md) fails loudly with a {@link SchemaDefinitionError}
 * before ajv ever sees it.
 *
 * Errors are sorted by (path, keyword, message) in code-unit order —
 * stable across runs and engines, safe to render directly in UI.
 */

/** One validation failure against instance data. `path` is a
 * dot/bracket path into the value ("$" for the root, "a.b[0]" for
 * nested); `keyword` is the JSON Schema keyword that failed;
 * `message` is ajv's human-readable detail. Empty list = valid. */
export type ValidationIssue = Issue;

/** A compiled, reusable validator for one schema. */
export interface JsonSchemaValidator {
	/** All violations of `value`, sorted deterministically. */
	readonly validate: (value: unknown) => readonly ValidationIssue[];
	/** True when `value` satisfies the schema. */
	readonly isValid: (value: unknown) => boolean;
}

const ajv = new Ajv2020({
	allErrors: true,
	strict: false,
	logger: false,
});

/** Convert an ajv JSON-pointer instancePath ("/a/b/0") into the
 * dot/bracket form used in issue paths ("a.b[0]"); "" maps to "$". */
const instancePathToPath = (instancePath: string): string => {
	if (instancePath === "") return "$";
	let out = "";
	for (const raw of instancePath.slice(1).split("/")) {
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
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
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	if (a.keyword !== b.keyword) return a.keyword < b.keyword ? -1 : 1;
	if (a.message !== b.message) return a.message < b.message ? -1 : 1;
	return 0;
};

const toIssue = (error: ErrorObject): ValidationIssue => ({
	path: instancePathToPath(error.instancePath),
	keyword: error.keyword,
	// ajv sets `message` on every validation error it produces; the type
	// marks it optional only for custom-keyword shapes the subset never
	// reaches (subset keywords are all standard).
	message: error.message as string,
});

/** Compiled validators keyed by schema object identity — schemas are
 * treated as immutable defs (the same convention as document-store
 * collection defs). Boolean schemas bypass the cache. */
const validatorCache = new WeakMap<object, JsonSchemaValidator>();

/**
 * String-keyed companion cache for callers whose schema objects are
 * re-materialized per request (e.g. wizard step schemas arriving as
 * fresh `JSON.parse` output on every run view — the WeakMap above
 * misses on every new object identity and ajv recompiles each time).
 * Two schema documents with identical JSON are semantically identical
 * — the subset is pure JSON data — so sharing one compiled validator
 * is safe. Bounded FIFO: schemas are immutable, so eviction only
 * costs a recompile.
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

const wrap = (validateFn: ValidateFunction): JsonSchemaValidator => ({
	validate: (value) => {
		const valid = validateFn(value);
		// ajv sets `errors` to null on success and the error array on
		// failure — `?? []` covers the null case for valid input.
		const errors = validateFn.errors ?? [];
		return valid ? [] : errors.map(toIssue).sort(compareIssues);
	},
	isValid: (value) => validateFn(value),
});

/**
 * Compile `schema` into a reusable validator. Throws
 * {@link SchemaDefinitionError} when the schema is outside the subset.
 * Prefer this over {@link validate} when the same schema validates many
 * values (form defs, collection schemas).
 */
export const compileSchema = (schema: unknown): JsonSchemaValidator => {
	assertSchema(schema);
	if (typeof schema === "boolean") {
		// ajv accepts boolean schemas directly.
		return wrap(ajv.compile(schema));
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
	const validator = wrap(ajv.compile(schema as SchemaObject));
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
