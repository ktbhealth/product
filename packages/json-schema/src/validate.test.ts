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
