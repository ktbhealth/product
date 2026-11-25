import { describe, expect, it } from "vitest";

import {
	compileSchema,
	SchemaDefinitionError,
	validate,
	type JsonSchemaObject,
	type JsonSchemaValidator,
	type ValidationIssue,
} from "./index.ts";

const person: JsonSchemaObject = {
	type: "object",
	properties: {
		name: { type: "string", minLength: 1, maxLength: 5 },
		age: { type: "integer", minimum: 0, maximum: 150 },
		role: { enum: ["physician", "secretary"] },
		admin: { type: "boolean" },
		tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
		nick: { type: ["string", "null"] },
		email: { type: "string", pattern: "^[^@]+@[^@]+$" },
		note: { const: "fixed" },
		extra: { not: { type: "null" } },
	},
	required: ["name", "role"],
	additionalProperties: false,
};

const validPerson = { name: "Ana", role: "physician", age: 42 };

describe("validate", () => {
	it("accepts a conforming value", () => {
		expect(validate(person, validPerson)).toEqual([]);
	});

	it("reports type errors with dot paths", () => {
		const issues = validate(person, { name: 42, role: "physician" });
		expect(issues).toEqual([{ path: "name", keyword: "type", message: "must be string" }]);
	});

	it("reports missing required properties at the parent path", () => {
		const issues = validate(person, { name: "Ana" });
		expect(issues).toEqual([
			{
				path: "$",
				keyword: "required",
				message: "must have required property 'role'",
			},
		]);
	});

	it("reports additionalProperties", () => {
		const issues = validate(person, { ...validPerson, bogus: 1 });
		expect(issues).toHaveLength(1);
		expect(issues[0]?.keyword).toBe("additionalProperties");
		expect(issues[0]?.path).toBe("$");
	});

	it("reports string bounds and patterns", () => {
		expect(validate(person, { ...validPerson, name: "" })[0]).toMatchObject({
			path: "name",
			keyword: "minLength",
		});
		expect(validate(person, { ...validPerson, name: "toolong" })[0]).toMatchObject({
			path: "name",
			keyword: "maxLength",
		});
		const patternIssues = validate(person, {
			...validPerson,
			email: "not-an-email",
		});
		expect(patternIssues[0]).toMatchObject({ path: "email", keyword: "pattern" });
	});

	it("reports numeric bounds and integer typing", () => {
		expect(validate(person, { ...validPerson, age: -1 })[0]).toMatchObject({
			path: "age",
			keyword: "minimum",
		});
		expect(validate(person, { ...validPerson, age: 151 })[0]).toMatchObject({
			path: "age",
			keyword: "maximum",
		});
		expect(validate(person, { ...validPerson, age: 4.5 })[0]).toMatchObject({
			path: "age",
			keyword: "type",
		});
	});

	it("reports enum and const violations", () => {
		expect(validate(person, { ...validPerson, role: "admin" })[0]).toMatchObject({
			path: "role",
			keyword: "enum",
		});
		expect(validate(person, { ...validPerson, note: "other" })[0]).toMatchObject({
			path: "note",
			keyword: "const",
		});
		expect(validate(person, { ...validPerson, note: "fixed" })).toEqual([]);
	});

	it("reports array item errors with bracket paths", () => {
		const issues = validate(person, { ...validPerson, tags: ["ok", 7] });
		expect(issues).toEqual([{ path: "tags[1]", keyword: "type", message: "must be string" }]);
	});

	it("reports array bounds", () => {
		expect(validate(person, { ...validPerson, tags: [] })[0]).toMatchObject({
			path: "tags",
			keyword: "minItems",
		});
		expect(validate(person, { ...validPerson, tags: ["a", "b", "c", "d"] })[0]).toMatchObject({
			path: "tags",
			keyword: "maxItems",
		});
	});

	it("handles type unions and not", () => {
		expect(validate(person, { ...validPerson, nick: null })).toEqual([]);
		expect(validate(person, { ...validPerson, nick: 3 })[0]).toMatchObject({
			path: "nick",
			keyword: "type",
		});
		expect(validate(person, { ...validPerson, extra: null })[0]).toMatchObject({
			path: "extra",
			keyword: "not",
		});
	});

	it("validates root-level non-object schemas", () => {
		expect(validate({ type: "string" }, "hi")).toEqual([]);
		expect(validate({ type: "string" }, 1)).toEqual([
			{ path: "$", keyword: "type", message: "must be string" },
		]);
		expect(validate({ type: "array", items: { type: "string" } }, ["a", 2])).toEqual([
			{ path: "$[1]", keyword: "type", message: "must be string" },
		]);
	});

	it("sorts errors deterministically", () => {
		// Multiple violations across paths — output must be sorted by
		// (path, keyword, message) regardless of ajv's emission order.
		const issues = validate(person, {
			name: "",
			role: "admin",
			age: -5,
			tags: "nope",
			bogus: true,
		});
		const keys = issues.map((i) => `${i.path}${i.keyword}${i.message}`);
		expect(keys).toEqual([...keys].sort());
		expect(issues.length).toBeGreaterThan(3);
	});

	it("reports nested object paths", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			properties: {
				outer: {
					type: "object",
					properties: { inner: { type: "string" } },
				},
			},
		};
		expect(validate(schema, { outer: { inner: 1 } })).toEqual([
			{ path: "outer.inner", keyword: "type", message: "must be string" },
		]);
	});

	it("sorts same-path errors by keyword then message", () => {
		const schema: JsonSchemaObject = {
			type: "string",
			minLength: 5,
			pattern: "^[0-9]+$",
		};
		const issues = validate(schema, "abc");
		expect(issues.map((i) => i.keyword)).toEqual(["minLength", "pattern"]);
	});

	it("dedupes nothing — identical errors compare equal and stay stable", () => {
		// Two identical allOf branches produce byte-identical issues;
		// the comparator must return 0 (not crash or reorder).
		const schema: JsonSchemaObject = {
			allOf: [{ type: "string" }, { type: "string" }],
		};
		const issues = validate(schema, 1);
		expect(issues).toEqual([
			{ path: "$", keyword: "type", message: "must be string" },
			{ path: "$", keyword: "type", message: "must be string" },
		]);
	});

	it("sorts many same-path keywords in both comparator directions", () => {
		// allOf branches control ajv's emission order: keywords arrive
		// unsorted (minLength → const → pattern → enum → maxLength) so
		// the comparator runs in both directions.
		const schema: JsonSchemaObject = {
			allOf: [
				{ minLength: 9 },
				{ const: "expected" },
				{ pattern: "^z" },
				{ enum: ["a", "b"] },
				{ maxLength: 1 },
			],
		};
		const issues = validate(schema, "abc");
		expect(issues.map((i) => i.keyword)).toEqual([
			"const",
			"enum",
			"maxLength",
			"minLength",
			"pattern",
		]);
	});

	it("sorts same-keyword errors by message", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["x", "y"],
		};
		const issues = validate(schema, {});
		expect(issues).toEqual([
			{
				path: "$",
				keyword: "required",
				message: "must have required property 'x'",
			},
			{
				path: "$",
				keyword: "required",
				message: "must have required property 'y'",
			},
		]);
	});

	it("sorts three same-keyword messages in both comparator directions", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["c", "a", "b"],
		};
		const issues = validate(schema, {});
		expect(issues.map((i) => i.message)).toEqual([
			"must have required property 'a'",
			"must have required property 'b'",
			"must have required property 'c'",
		]);
	});

	it("unescapes JSON-pointer segments in instance paths", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			properties: {
				"a/b": { type: "string" },
				"~k": { type: "string" },
				a1: { type: "string" },
				"1a": { type: "string" },
			},
		};
		const issues = validate(schema, { "a/b": 1, "~k": 2, a1: 3, "1a": 4 });
		expect(issues).toEqual([
			{ path: "1a", keyword: "type", message: "must be string" },
			{ path: "a/b", keyword: "type", message: "must be string" },
			{ path: "a1", keyword: "type", message: "must be string" },
			{ path: "~k", keyword: "type", message: "must be string" },
		]);
	});

	it("formats array indices of two or more digits with brackets", () => {
		const schema: JsonSchemaObject = { type: "array", items: { type: "string" } };
		const value = Array.from({ length: 11 }, (_, i) => (i === 10 ? 5 : "x"));
		expect(validate(schema, value)).toEqual([
			{ path: "$[10]", keyword: "type", message: "must be string" },
		]);
	});
});

describe("boolean schemas", () => {
	it("true accepts anything, false accepts nothing", () => {
		expect(validate(true, { anything: [1, "x"] })).toEqual([]);
		expect(validate(false, 1)).toEqual([
			{ path: "$", keyword: "false schema", message: "boolean schema is false" },
		]);
		const v = compileSchema(false);
		expect(v.isValid(1)).toBe(false);
		expect(v.validate(1)).toHaveLength(1);
	});
});

describe("compileSchema", () => {
	it("returns a reusable validator", () => {
		const validator: JsonSchemaValidator = compileSchema(person);
		expect(validator.isValid(validPerson)).toBe(true);
		expect(validator.isValid({ name: "Ana" })).toBe(false);
		expect(validator.validate(validPerson)).toEqual([]);
		const issues: readonly ValidationIssue[] = validator.validate({
			...validPerson,
			age: "x",
		});
		expect(issues[0]).toMatchObject({ path: "age", keyword: "type" });
	});

	it("caches compiled validators per schema object", () => {
		const schema: JsonSchemaObject = { type: "string" };
		expect(compileSchema(schema)).toBe(compileSchema(schema));
	});

	it("caches equivalent schemas by serialized JSON, not just identity", () => {
		// Wire round-trips rebuild schema objects (JSON.parse output) —
		// the WeakMap misses on the new identity, but the serialized
		// document is identical, so the compiled validator is shared.
		const a: JsonSchemaObject = { type: "object", properties: { n: { type: "string" } } };
		const b = JSON.parse(JSON.stringify(a)) as JsonSchemaObject;
		expect(compileSchema(a)).toBe(compileSchema(b));
	});

	it("does not evict JSON-keyed validators below the cache cap", () => {
		// Two distinct schemas must both stay cached — inserting `b`
		// cannot evict `a` while the map is under the limit.
		const a: JsonSchemaObject = { type: "string", minLength: 0 };
		const b: JsonSchemaObject = { type: "string", minLength: 1 };
		compileSchema(a);
		compileSchema(b);
		const reparsed = JSON.parse(JSON.stringify(a)) as JsonSchemaObject;
		expect(compileSchema(reparsed)).toBe(compileSchema(a));
	});

	it("evicts the oldest JSON-keyed validator exactly at the cache cap", () => {
		// VALIDATOR_CACHE_LIMIT distinct schemas: the 101st insert evicts
		// the first — one past the cap must already be gone.
		const first: JsonSchemaObject = { type: "string", minLength: 0 };
		compileSchema(first);
		for (let i = 1; i <= 100; i += 1) {
			compileSchema({ type: "string", minLength: i });
		}
		const reparsed = JSON.parse(JSON.stringify(first)) as JsonSchemaObject;
		expect(compileSchema(reparsed)).not.toBe(compileSchema(first));
	});

	it("keeps the identity-cached validator stable across JSON-cache eviction", () => {
		// The WeakMap pins schema OBJECT → validator even after the
		// JSON-keyed entry is evicted and a twin object recompiles —
		// compileSchema(sameObject) must keep returning the original.
		// (Distinct shape: other cache tests reuse {type:"string",
		// minLength:i} keys, which would hit instead of evicting.)
		const s: JsonSchemaObject = { type: "integer", minimum: 0 };
		const v1 = compileSchema(s);
		for (let i = 1; i <= 105; i += 1) {
			compileSchema({ type: "integer", minimum: i });
		}
		// A different object with identical JSON recompiles under s's
		// (evicted-then-reinserted) JSON key.
		const twin = JSON.parse(JSON.stringify(s)) as JsonSchemaObject;
		compileSchema(twin);
		expect(compileSchema(s)).toBe(v1);
	});

	it("evicts the oldest JSON-keyed validator past the cache cap", () => {
		// >100 distinct serialized schemas force FIFO eviction; the
		// first schema's validator must be recompiled (new identity).
		const first: JsonSchemaObject = { type: "string", minLength: 0 };
		compileSchema(first);
		for (let i = 1; i <= 105; i += 1) {
			compileSchema({ type: "string", minLength: i });
		}
		const reparsed = JSON.parse(JSON.stringify(first)) as JsonSchemaObject;
		expect(compileSchema(reparsed)).not.toBe(compileSchema(first));
	});

	it("supports $ref to internal pointers", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			properties: {
				name: { type: "string" },
				alias: { $ref: "#/properties/name" },
			},
		};
		expect(validate(schema, { name: "a", alias: "b" })).toEqual([]);
		expect(validate(schema, { name: "a", alias: 3 })[0]).toMatchObject({
			path: "alias",
			keyword: "type",
		});
	});

	it("supports allOf/anyOf/oneOf combinators", () => {
		const schema: JsonSchemaObject = {
			allOf: [{ type: "object" }, { required: ["a"] }],
			anyOf: [{ properties: { a: { const: 1 } } }, { properties: { a: { const: 2 } } }],
			oneOf: [{ type: "object" }],
		};
		expect(validate(schema, { a: 1 })).toEqual([]);
		expect(validate(schema, { a: 3 }).length).toBeGreaterThan(0);
	});
});

describe("schema definition errors", () => {
	it("validate and compileSchema reject out-of-subset schemas", () => {
		const bad = { type: "strnig" };
		expect(() => validate(bad, "x")).toThrow(SchemaDefinitionError);
		expect(() => compileSchema(bad)).toThrow(SchemaDefinitionError);
		expect(() => compileSchema({ unknownKeyword: true })).toThrow(SchemaDefinitionError);
	});
});

describe("interpreter edge cases", () => {
	it("deep-equals enum and const candidates structurally", () => {
		const schema: JsonSchemaObject = {
			enum: [{ a: [1, { b: 2 }] }, [1, 2], "x", null],
			const: { k: { nested: [true, null] } },
		};
		// Both keywords must hold — pick values satisfying each in turn.
		expect(validate({ enum: [{ a: [1, { b: 2 }] }] }, { a: [1, { b: 2 }] })).toEqual([]);
		expect(
			validate({ const: { k: { nested: [true, null] } } }, { k: { nested: [true, null] } }),
		).toEqual([]);
		// Key order is insignificant; array order is significant.
		expect(validate({ const: { a: 1, b: 2 } }, { b: 2, a: 1 })).toEqual([]);
		expect(validate({ const: [1, 2] }, [2, 1])).toEqual([
			{ path: "$", keyword: "const", message: "must be equal to constant" },
		]);
		expect(validate(schema, { a: [1, { b: 2 }] })).toEqual([
			{ path: "$", keyword: "const", message: "must be equal to constant" },
		]);
	});

	it("reports every jsonEqual mismatch shape", () => {
		// Different key counts.
		expect(validate({ const: { a: 1 } }, { a: 1, b: 2 })).toEqual([
			{ path: "$", keyword: "const", message: "must be equal to constant" },
		]);
		// Missing key on the candidate side.
		expect(validate({ const: { a: 1, b: 2 } }, { a: 1 })).toEqual([
			{ path: "$", keyword: "const", message: "must be equal to constant" },
		]);
		// Array vs object.
		expect(validate({ const: [1] }, { 0: 1 })).toEqual([
			{ path: "$", keyword: "const", message: "must be equal to constant" },
		]);
		// Array length mismatch.
		expect(validate({ const: [1, 2] }, [1])).toEqual([
			{ path: "$", keyword: "const", message: "must be equal to constant" },
		]);
		// Primitive vs object and object vs null.
		expect(validate({ const: 5 }, { a: 1 })).toEqual([
			{ path: "$", keyword: "const", message: "must be equal to constant" },
		]);
		expect(validate({ const: { a: 1 } }, null)).toEqual([
			{ path: "$", keyword: "const", message: "must be equal to constant" },
		]);
		// Nested member mismatch inside an otherwise-equal object.
		expect(validate({ const: { a: { b: [1] } } }, { a: { b: [2] } })).toEqual([
			{ path: "$", keyword: "const", message: "must be equal to constant" },
		]);
	});

	it("validates additionalProperties subschemas at member paths", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			properties: { a: { type: "string" } },
			additionalProperties: { type: "number" },
		};
		expect(validate(schema, { a: "x", b: 1, c: "no" })).toEqual([
			{ path: "c", keyword: "type", message: "must be number" },
		]);
		// additionalProperties without a properties bag treats every key as extra.
		expect(
			validate({ type: "object", additionalProperties: { type: "string" } }, { x: 1 }),
		).toEqual([{ path: "x", keyword: "type", message: "must be string" }]);
		// `true` is the explicit allow-all form.
		expect(validate({ type: "object", additionalProperties: true }, { x: 1 })).toEqual([]);
	});

	it("enforces object property count bounds", () => {
		expect(validate({ type: "object", minProperties: 2 }, { a: 1 })).toEqual([
			{ path: "$", keyword: "minProperties", message: "must NOT have fewer than 2 properties" },
		]);
		expect(validate({ type: "object", maxProperties: 1 }, { a: 1, b: 2 })).toEqual([
			{ path: "$", keyword: "maxProperties", message: "must NOT have more than 1 properties" },
		]);
		// Bounds ignore non-object instances.
		expect(validate({ minProperties: 5, maxProperties: 0 }, "x")).toEqual([]);
	});

	it("reports oneOf branch errors only when no branch passes", () => {
		const schema: JsonSchemaObject = {
			oneOf: [{ type: "string" }, { type: "number" }],
		};
		// Zero passing branches: inner errors plus the oneOf error.
		expect(validate(schema, true)).toEqual([
			{ path: "$", keyword: "oneOf", message: "must match exactly one schema in oneOf" },
			{ path: "$", keyword: "type", message: "must be number" },
			{ path: "$", keyword: "type", message: "must be string" },
		]);
		// Two passing branches: only the oneOf error — branch issues are
		// empty anyway, but a failing third branch's issues are dropped.
		const threeWay: JsonSchemaObject = {
			oneOf: [{ type: "number" }, { minimum: 0 }, { type: "string" }],
		};
		expect(validate(threeWay, 5)).toEqual([
			{ path: "$", keyword: "oneOf", message: "must match exactly one schema in oneOf" },
		]);
		// Exactly one passing branch is valid — for a non-number the
		// bare `{ minimum: 0 }` branch imposes nothing and passes.
		expect(validate(threeWay, true)).toEqual([]);
	});

	it("drops failing-branch errors when anyOf has a passing branch", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			properties: {
				x: { anyOf: [{ type: "string", minLength: 3 }, { type: "number" }] },
			},
		};
		expect(validate(schema, { x: "ab" })).toEqual([
			{ path: "x", keyword: "anyOf", message: "must match a schema in anyOf" },
			{ path: "x", keyword: "minLength", message: "must NOT have fewer than 3 characters" },
			{ path: "x", keyword: "type", message: "must be number" },
		]);
		expect(validate(schema, { x: 4 })).toEqual([]);
	});

	it("evaluates boolean subschemas in every position", () => {
		expect(
			validate({ type: "object", properties: { x: false, y: true } }, { x: 1, y: "anything" }),
		).toEqual([{ path: "x", keyword: "false schema", message: "boolean schema is false" }]);
		expect(validate({ type: "array", items: false }, [1])).toEqual([
			{ path: "$[0]", keyword: "false schema", message: "boolean schema is false" },
		]);
		expect(validate({ allOf: [false] }, 1)).toEqual([
			{ path: "$", keyword: "false schema", message: "boolean schema is false" },
		]);
		// `not: false` can never be valid, so `not` always passes.
		expect(validate({ not: false }, 1)).toEqual([]);
	});

	it("skips undefined-valued properties like ajv", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			properties: { b: { type: "string" } },
			required: ["a"],
		};
		// `undefined` counts as absent for `required` and `properties`.
		expect(validate(schema, { a: 1, b: undefined })).toEqual([]);
		expect(validate(schema, { b: "x" })).toEqual([
			{ path: "$", keyword: "required", message: "must have required property 'a'" },
		]);
	});

	it("resolves multi-segment $ref pointers and ref-to-ref chains", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			properties: {
				outer: {
					type: "object",
					properties: { inner: { type: "string" } },
				},
				a: { type: "integer" },
				b: { $ref: "#/properties/a" },
				c: { $ref: "#/properties/b" },
				d: { $ref: "#/properties/outer/properties/inner" },
			},
		};
		expect(validate(schema, { outer: {}, a: 1, b: 2, c: 3, d: "s" })).toEqual([]);
		expect(validate(schema, { outer: {}, a: 1, b: "x", c: "y", d: 4 })).toEqual([
			{ path: "b", keyword: "type", message: "must be integer" },
			{ path: "c", keyword: "type", message: "must be integer" },
			{ path: "d", keyword: "type", message: "must be string" },
		]);
	});

	it("covers remaining primitive types and ignored keyword positions", () => {
		expect(validate({ type: "number" }, 1.5)).toEqual([]);
		expect(validate({ type: "number" }, "x")).toEqual([
			{ path: "$", keyword: "type", message: "must be number" },
		]);
		expect(validate({ type: "null" }, null)).toEqual([]);
		expect(validate({ type: "null" }, 0)).toEqual([
			{ path: "$", keyword: "type", message: "must be null" },
		]);
		// String/number/array/object keywords do not apply to other types.
		expect(validate({ minLength: 9, minimum: 9, minItems: 9, minProperties: 9 }, true)).toEqual([]);
	});

	it("isValid mirrors validate emptiness for both outcomes", () => {
		const validator = compileSchema({ type: "string" });
		expect(validator.isValid("x")).toBe(true);
		expect(validator.isValid(1)).toBe(false);
		// Boolean schemas expose both isValid outcomes too.
		expect(compileSchema(true).isValid({ any: "thing" })).toBe(true);
		expect(compileSchema(false).isValid(1)).toBe(false);
	});

	it("checks the boolean primitive type", () => {
		expect(validate({ type: "boolean" }, true)).toEqual([]);
		expect(validate({ type: "boolean" }, 1)).toEqual([
			{ path: "$", keyword: "type", message: "must be boolean" },
		]);
	});
});
