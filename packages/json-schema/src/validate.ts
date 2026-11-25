import { assertSchema, type Issue } from "./schema.ts";

/**
 * Instance validation — interprets a subset schema directly against
 * instance data and reports deterministic {@link Issue}s.
 *
 * The engine is a small recursive interpreter, NOT ajv: ajv compiles
 * schemas with `new Function`, which workerd forbids outside worker
 * startup — and `@cloudflare/vite-plugin` dev evaluates every SSR
 * module lazily through its unsafe-eval binding, so even module-scope
 * `compileSchema` calls (e.g. `jobs.schedulable` validators in
 * platform.ts) crashed `bun run dev` with "Code generation from
 * strings disallowed". A pure interpreter has no codegen anywhere, so
 * it is safe in workerd dev, workerd prod (request-time validation is
 * equally restricted), Node and the browser.
 *
 * `compileSchema`/`validate` first run {@link assertSchema}, so
 * anything outside the documented subset (PROFILE.md) fails loudly
 * with a {@link SchemaDefinitionError} before interpretation.
 *
 * Errors are sorted by (path, keyword, message) in code-unit order —
 * stable across runs and engines, safe to render directly in UI.
 * Issue `path`s and `message`s deliberately mirror ajv's draft-2020-12
 * output so existing consumers and tests are unaffected.
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

/** Convert an ajv-style JSON-pointer instancePath ("/a/b/0") into the
 * dot/bracket form used in issue paths ("a.b[0]"); "" maps to "$". */
const instancePathToPath = (instancePath: string): string => {
	if (instancePath === "") return "$";
	let out = "";
	// Stryker disable next-line MethodExpression: instancePath always starts with "/", so splitting the un-sliced path only prepends an empty segment that contributes nothing to `out`.
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
	// Stryker disable next-line EqualityOperator: guarded by a.path !== b.path, so < and <= coincide here.
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	// Stryker disable next-line EqualityOperator: guarded by a.keyword !== b.keyword, so < and <= coincide here.
	if (a.keyword !== b.keyword) return a.keyword < b.keyword ? -1 : 1;
	// Stryker disable next-line ConditionalExpression, EqualityOperator: equal messages mean identical issues (path and keyword already matched), so returning 1 instead of 0 is unobservable; and < vs <= coincide inside the !== guard.
	if (a.message !== b.message) return a.message < b.message ? -1 : 1;
	return 0;
};

/** JSON-pointer escaping for one path segment ("~" → "~0", "/" → "~1"). */
const escapePointerSegment = (segment: string): string =>
	segment.replace(/~/g, "~0").replace(/\//g, "~1");

const issue = (instancePath: string, keyword: string, message: string): Issue => ({
	path: instancePathToPath(instancePath),
	keyword,
	message,
});

/** Deep equality over JSON values — object key order is insignificant,
 * array order is significant. Mirrors ajv's `equal` for `enum`/`const`.
 * `undefined` members compare by `===` (schemas/values are pure JSON
 * post-`assertSchema`, so this only matters for exotic direct calls). */
const jsonEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	// Schema-side values are pure JSON (assertSchema rejects NaN), so a
	// both-NaN comparison is unreachable — `a === b` above plus strict
	// inequality below is the complete contract for JSON data.
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const aIsArray = Array.isArray(a);
	const bIsArray = Array.isArray(b);
	if (aIsArray !== bIsArray) return false;
	if (aIsArray && bIsArray) {
		if (a.length !== b.length) return false;
		return a.every((entry, i) => jsonEqual(entry, b[i]));
	}
	const aRecord = a as Record<string, unknown>;
	const bRecord = b as Record<string, unknown>;
	const aKeys = Object.keys(aRecord);
	const bKeys = Object.keys(bRecord);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every(
		(key) =>
			Object.prototype.hasOwnProperty.call(bRecord, key) && jsonEqual(aRecord[key], bRecord[key]),
	);
};

const isObjectInstance = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Draft-2020-12 primitive type predicates, in PROFILE.md order. */
const TYPE_PREDICATES: Record<string, (value: unknown) => boolean> = {
	string: (v) => typeof v === "string",
	number: (v) => typeof v === "number",
	// ajv's integer check is `!isNaN(v) && !(v % 1)` — NOT
	// Number.isInteger: ±Infinity passes (Infinity % 1 is NaN, which
	// negates to true) while NaN itself fails. JSON cannot carry
	// non-finite numbers, so this only matters for direct calls.
	integer: (v) => typeof v === "number" && !Number.isNaN(v) && !(v % 1),
	boolean: (v) => typeof v === "boolean",
	null: (v) => v === null,
	object: isObjectInstance,
	array: (v) => Array.isArray(v),
};

type SchemaNode = Record<string, unknown>;

/** Resolve an internal `$ref` pointer ("#/…") against the root schema
 * document. `assertSchema` has already guaranteed the pointer is
 * well-formed, internal and non-recursive — a bare "#" always resolves
 * to an ancestor and is rejected as a `$ref` cycle, so only "#/…"
 * pointers reach this function. */
const resolveRef = (root: SchemaNode, ref: string): unknown => {
	let node: unknown = root;
	for (const rawSegment of ref.slice(2).split("/")) {
		// JSON-pointer unescape: "~1" → "/" BEFORE "~0" → "~".
		const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
		node = (node as Record<string, unknown>)[segment];
	}
	return node;
};

/**
 * Interpret `schema` against `value`, returning every violation with
 * ajv-compatible instance paths. `instancePath` is the ajv-style
 * JSON-pointer path of `value` inside the root document ("" at the
 * root); `root` is the top-level schema object `$ref`s resolve
 * against.
 */
const validateNode = (
	schema: unknown,
	value: unknown,
	instancePath: string,
	root: SchemaNode,
): Issue[] => {
	// Boolean schemas are legal everywhere a subschema is expected.
	if (schema === true) return [];
	if (schema === false) {
		return [issue(instancePath, "false schema", "boolean schema is false")];
	}
	const node = schema as SchemaNode;
	const issues: Issue[] = [];

	// $ref — internal pointer, resolved against the root document.
	// Draft 2020-12: $ref does not suppress sibling keywords, so both
	// the referenced schema and the rest of this node are evaluated.
	if (typeof node.$ref === "string") {
		issues.push(...validateNode(resolveRef(root, node.$ref), value, instancePath, root));
	}

	// type — single name or a non-empty list; one error covers the
	// whole union ("must be string,null").
	const typeKeyword = node.type;
	if (typeKeyword !== undefined) {
		const types = (Array.isArray(typeKeyword) ? typeKeyword : [typeKeyword]) as readonly string[];
		// assertSchema has already restricted `type` to the seven
		// PROFILE.md names, so the predicate lookup always hits.
		if (!types.some((t) => TYPE_PREDICATES[t]!(value))) {
			issues.push(issue(instancePath, "type", `must be ${types.join(",")}`));
		}
	}

	// enum / const — apply to every instance type.
	if (node.enum !== undefined) {
		const allowed = node.enum as readonly unknown[];
		if (!allowed.some((candidate) => jsonEqual(candidate, value))) {
			issues.push(issue(instancePath, "enum", "must be equal to one of the allowed values"));
		}
	}
	if (node.const !== undefined && !jsonEqual(node.const, value)) {
		issues.push(issue(instancePath, "const", "must be equal to constant"));
	}

	// String keywords — only apply to string instances.
	if (typeof value === "string") {
		if (typeof node.pattern === "string" && !(new RegExp(node.pattern) as RegExp).test(value)) {
			issues.push(issue(instancePath, "pattern", `must match pattern "${node.pattern}"`));
		}
		if (typeof node.minLength === "number" && value.length < node.minLength) {
			issues.push(
				issue(instancePath, "minLength", `must NOT have fewer than ${node.minLength} characters`),
			);
		}
		if (typeof node.maxLength === "number" && value.length > node.maxLength) {
			issues.push(
				issue(instancePath, "maxLength", `must NOT have more than ${node.maxLength} characters`),
			);
		}
	}

	// Number keywords — only apply to number instances. The failure
	// tests are negated comparisons (`!(v >= min)`), matching ajv:
	// NaN fails every bound even though `NaN < min` is false.
	if (typeof value === "number") {
		if (typeof node.minimum === "number" && !(value >= node.minimum)) {
			issues.push(issue(instancePath, "minimum", `must be >= ${node.minimum}`));
		}
		if (typeof node.maximum === "number" && !(value <= node.maximum)) {
			issues.push(issue(instancePath, "maximum", `must be <= ${node.maximum}`));
		}
	}

	// Array keywords — only apply to array instances.
	if (Array.isArray(value)) {
		if (node.items !== undefined) {
			value.forEach((entry, index) => {
				issues.push(...validateNode(node.items, entry, `${instancePath}/${index}`, root));
			});
		}
		if (typeof node.minItems === "number" && value.length < node.minItems) {
			issues.push(
				issue(instancePath, "minItems", `must NOT have fewer than ${node.minItems} items`),
			);
		}
		if (typeof node.maxItems === "number" && value.length > node.maxItems) {
			issues.push(
				issue(instancePath, "maxItems", `must NOT have more than ${node.maxItems} items`),
			);
		}
	}

	// Object keywords — only apply to plain-object instances.
	if (isObjectInstance(value)) {
		const declared =
			node.properties !== undefined &&
			typeof node.properties === "object" &&
			node.properties !== null
				? (node.properties as Record<string, unknown>)
				: undefined;

		if (declared !== undefined) {
			for (const [key, subschema] of Object.entries(declared)) {
				// ajv treats `undefined` members as absent (they cannot
				// occur in JSON documents anyway).
				// Stryker disable next-line ConditionalExpression: `value[key] !== undefined` vs truthiness — an explicit `undefined` member is skipped either way only when falsy; the !== form is the documented ajv semantic.
				if (value[key] !== undefined) {
					issues.push(
						...validateNode(
							subschema,
							value[key],
							`${instancePath}/${escapePointerSegment(key)}`,
							root,
						),
					);
				}
			}
		}

		if (Array.isArray(node.required)) {
			for (const key of node.required as readonly string[]) {
				if (value[key] === undefined) {
					issues.push(issue(instancePath, "required", `must have required property '${key}'`));
				}
			}
		}

		const additional = node.additionalProperties;
		if (additional !== undefined && additional !== true) {
			const declaredKeys =
				declared === undefined ? new Set<string>() : new Set(Object.keys(declared));
			for (const key of Object.keys(value)) {
				if (declaredKeys.has(key)) continue;
				if (additional === false) {
					issues.push(
						issue(instancePath, "additionalProperties", "must NOT have additional properties"),
					);
				} else {
					issues.push(
						...validateNode(
							additional,
							value[key],
							`${instancePath}/${escapePointerSegment(key)}`,
							root,
						),
					);
				}
			}
		}

		const keyCount = Object.keys(value).length;
		if (typeof node.minProperties === "number" && keyCount < node.minProperties) {
			issues.push(
				issue(
					instancePath,
					"minProperties",
					`must NOT have fewer than ${node.minProperties} properties`,
				),
			);
		}
		if (typeof node.maxProperties === "number" && keyCount > node.maxProperties) {
			issues.push(
				issue(
					instancePath,
					"maxProperties",
					`must NOT have more than ${node.maxProperties} properties`,
				),
			);
		}
	}

	// Combinators — apply to every instance type.
	if (Array.isArray(node.allOf)) {
		for (const subschema of node.allOf as readonly unknown[]) {
			issues.push(...validateNode(subschema, value, instancePath, root));
		}
	}
	if (Array.isArray(node.anyOf)) {
		const branches = node.anyOf as readonly unknown[];
		const branchIssues = branches.map((subschema) =>
			validateNode(subschema, value, instancePath, root),
		);
		if (branchIssues.every((branch) => branch.length > 0)) {
			for (const branch of branchIssues) issues.push(...branch);
			issues.push(issue(instancePath, "anyOf", "must match a schema in anyOf"));
		}
	}
	if (Array.isArray(node.oneOf)) {
		const branches = node.oneOf as readonly unknown[];
		const branchIssues = branches.map((subschema) =>
			validateNode(subschema, value, instancePath, root),
		);
		const passing = branchIssues.filter((branch) => branch.length === 0).length;
		if (passing !== 1) {
			// ajv reports the failing branches' own errors only when NO
			// branch passes; with 2+ passes the sole violation is the
			// oneOf keyword itself.
			if (passing === 0) {
				for (const branch of branchIssues) issues.push(...branch);
			}
			issues.push(issue(instancePath, "oneOf", "must match exactly one schema in oneOf"));
		}
	}
	if (node.not !== undefined) {
		const inner = validateNode(node.not, value, instancePath, root);
		// `not` inverts validity only — the subschema's own issues are
		// never reported.
		if (inner.length === 0) {
			issues.push(issue(instancePath, "not", "must NOT be valid"));
		}
	}

	return issues;
};

/** Wrap an interpreted schema as a {@link JsonSchemaValidator} —
 * every call sorts issues into the deterministic (path, keyword,
 * message) order consumers rely on. */
const wrapInterpreted = (schema: unknown): JsonSchemaValidator => ({
	validate: (value) => validateNode(schema, value, "", schema as SchemaNode).sort(compareIssues),
	isValid: (value) => validateNode(schema, value, "", schema as SchemaNode).length === 0,
});

/** Compiled validators keyed by schema object identity — schemas are
 * treated as immutable defs (the same convention as document-store
 * collection defs). */
const validatorCache = new WeakMap<object, JsonSchemaValidator>();

/**
 * String-keyed companion cache for callers whose schema objects are
 * re-materialized per request (e.g. wizard step schemas arriving as
 * fresh `JSON.parse` output on every run view — the WeakMap above
 * misses on every new object identity and the interpreter setup
 * repeats each time). Two schema documents with identical JSON are
 * semantically identical — the subset is pure JSON data — so sharing
 * one compiled validator is safe. Bounded FIFO: schemas are immutable,
 * so eviction only costs a re-setup.
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
		return schema
			? { validate: () => [], isValid: () => true }
			: {
					validate: () => [issue("", "false schema", "boolean schema is false")],
					isValid: () => false,
				};
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
	const validator = wrapInterpreted(schema);
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
