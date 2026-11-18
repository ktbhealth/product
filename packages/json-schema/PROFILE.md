# `@ktb/json-schema` — subset profile

`@ktb/json-schema` is the shared schema-contract layer for the
dynamic-runtime plugin stack (forms, wizards, views, api, triggers,
seed, flows). It validates **instance data** against **JSON Schema**
and validates **schema definitions** against a documented subset of
[JSON Schema draft 2020-12](https://json-schema.org/draft/2020-12/schema).

It is infra, not a plugin: pure functions, no registry contributions,
no Effect service (validation is synchronous and pure — same shape as
`@ktb/crypto` and document-store's `validate.ts`). The engine is
[ajv](https://ajv.js.org) `Ajv2020` (`ajv/dist/2020`), pure JS and
workerd-safe.

## API

```ts
import {
	assertSchema, // throws SchemaDefinitionError on out-of-subset defs
	checkSchema, // schema → Issue[] (empty = conforms)
	compileSchema, // schema → { validate(value), isValid(value) }
	validate, // one-shot: schema + value → Issue[]
	SchemaDefinitionError,
	type JsonSchema,
	type JsonSchemaObject,
	type JsonSchemaValidator,
	type Issue, // { path, keyword, message }
} from "@ktb/json-schema";
```

- `checkSchema(schema)` / `assertSchema(schema)` run at **definition
  boundaries** (collection defs, form defs, seed data) on untyped JSON.
- `compileSchema(schema)` returns a reusable validator — prefer it when
  one schema validates many values. Validators are cached per schema
  object; treat schema objects as immutable.
- `validate(schema, value)` is the one-shot convenience (compiles via
  the same cache).
- All three throw `SchemaDefinitionError` (with `.issues`) when the
  schema is outside the subset — before ajv compiles anything.
- Instance errors are `Issue`s sorted by `(path, keyword, message)` in
  code-unit order — deterministic across runs and engines. Data paths
  use dot/bracket notation (`$` root, `a.b[0]` for array items).

## Supported keywords

| Keyword                                                  | Notes                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `type`                                                   | `"string" \| "number" \| "integer" \| "boolean" \| "null" \| "object" \| "array"`, or a non-empty unique array of them |
| `properties`                                             | object of subschemas                                                                                                   |
| `required`                                               | array of unique non-empty strings                                                                                      |
| `additionalProperties`                                   | subschema (or boolean schema)                                                                                          |
| `items`                                                  | single subschema — **no tuple form** (draft 2020-12 uses `prefixItems` for tuples; not in the subset)                  |
| `enum`, `const`                                          | JSON values only                                                                                                       |
| `pattern`                                                | JS regex source — **unanchored** per spec; anchor with `^…$` for full-match semantics                                  |
| `minLength`, `maxLength`                                 | strings: character count (`.length`, UTF-16 units)                                                                     |
| `minimum`, `maximum`                                     | finite numbers, inclusive                                                                                              |
| `minItems`, `maxItems`                                   | arrays                                                                                                                 |
| `minProperties`, `maxProperties`                         | objects                                                                                                                |
| `allOf`, `anyOf`, `oneOf`                                | non-empty arrays of subschemas                                                                                         |
| `not`                                                    | subschema                                                                                                              |
| `$ref`                                                   | **internal JSON pointers only** — `"#/…"` (or `"#"`); no remote refs, no `$anchor`/`$dynamicRef`, no percent-encoding  |
| `$schema`, `title`, `description`, `default`, `$comment` | annotations — `$schema` accepted but not enforced (the subset _is_ 2020-12)                                            |

Boolean schemas (`true` = anything, `false` = nothing) are supported
everywhere a subschema is expected.

## Explicitly excluded

`$id`, `$anchor`, `$dynamicRef`/`$dynamicAnchor`, `$recursiveRef`,
`prefixItems`, `contains`, `propertyNames`, `patternProperties`,
`unevaluatedProperties`/`unevaluatedItems`, `if`/`then`/`else`,
`dependentRequired`/`dependentSchemas`, `format` (annotation-only in
2020-12 anyway), `content*` keywords, `readOnly`/`writeOnly`,
`exclusiveMinimum`/`exclusiveMaximum` (use `minimum`/`maximum` or
`not`+`const` workarounds), remote `$ref`s, and **recursive `$ref`s**
(a `$ref` cycle is a definition error). Unknown keywords are rejected —
the subset is a contract, so `min`/`max`-style typos fail loudly.

## Safety limits

| Limit                | Value                            | Why                                   |
| -------------------- | -------------------------------- | ------------------------------------- |
| `MAX_PATTERN_LENGTH` | 200 chars                        | same bound as document-store `$regex` |
| nested quantifiers   | `(a+)+`-style heuristic rejected | ReDoS defense in depth                |
| `MAX_SCHEMA_DEPTH`   | 64                               | bounds nesting incl. `$ref` hops      |
| `MAX_SCHEMA_NODES`   | 2048                             | bounds ref fan-out / document size    |
| `MAX_ISSUES`         | 100                              | bounds issue output on hostile defs   |

`pattern` uses JavaScript `RegExp` semantics (ECMA-262), matching
ajv's `pattern` keyword — not POSIX/ECMA-262-unicode mode.

## Example

```ts
const schema = {
	type: "object",
	properties: {
		name: { type: "string", minLength: 1, maxLength: 120 },
		age: { type: "integer", minimum: 0, maximum: 150 },
		role: { enum: ["physician", "secretary"] },
		consents: {
			type: "array",
			items: { $ref: "#/properties/consent" },
			minItems: 1,
		},
		// Reusable target: a real schema position doubles as the
		// $ref target. It validates `data.consent` like any property.
		consent: { type: "object" },
	},
	required: ["name", "role"],
	additionalProperties: false,
} satisfies JsonSchemaObject;
```

`$ref` targets must be reachable through allowed keywords — there is
no `$defs`/`definitions` bag in the subset. A property or combinator
branch doubles as the shared subschema; a `$ref` to `"#"` points at the
whole document (only useful for wrapping schemas).

```ts
const patient = {
	type: "object",
	properties: {
		name: { type: "string", minLength: 1 },
		age: { type: "integer", minimum: 0 },
	},
	required: ["name"],
	additionalProperties: false,
};

validate(patient, { name: "Ana", age: 42 }); // []
validate(patient, { name: 42, extra: true });
// → [
//   { path: "$", keyword: "additionalProperties", message: "must NOT have additional properties" },
//   { path: "name", keyword: "type", message: "must be string" },
// ]  (sorted; order stable)
```
