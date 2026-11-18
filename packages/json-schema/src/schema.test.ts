import { describe, expect, it } from "vitest";

import {
	assertSchema,
	checkSchema,
	JSON_SCHEMA_TYPES,
	MAX_ISSUES,
	MAX_PATTERN_LENGTH,
	MAX_SCHEMA_DEPTH,
	MAX_SCHEMA_NODES,
	SchemaDefinitionError,
	type Issue,
} from "./index.ts";

const issueAt = (schema: unknown, path: string): Issue | undefined =>
	checkSchema(schema).find((i) => i.path === path);

describe("checkSchema — structure", () => {
	it("accepts booleans and empty objects", () => {
		expect(checkSchema(true)).toEqual([]);
		expect(checkSchema(false)).toEqual([]);
		expect(checkSchema({})).toEqual([]);
	});

	it("rejects non-object non-boolean schemas", () => {
		for (const bad of [42, "x", null, [1, 2], undefined]) {
			const issues = checkSchema(bad);
			expect(issues).toHaveLength(1);
			expect(issues[0]?.keyword).toBe("schema");
			expect(issues[0]?.path).toBe("");
		}
	});

	it("rejects circular JS objects", () => {
		const schema: Record<string, unknown> = { type: "object" };
		schema.properties = { self: schema };
		const issues = checkSchema(schema);
		expect(issues.some((i) => i.message.includes("recursive"))).toBe(true);
	});

	it("caps issue output at MAX_ISSUES", () => {
		const schema: Record<string, unknown> = {};
		for (let i = 0; i < MAX_ISSUES + 20; i++) schema[`k${i}`] = i;
		expect(checkSchema(schema)).toHaveLength(MAX_ISSUES);
	});
});

describe("checkSchema — keywords", () => {
	it("rejects unknown keywords", () => {
		const issues = checkSchema({ min: 1, max: 5 });
		expect(issues.map((i) => i.keyword)).toEqual(["min", "max"]);
		expect(issues[0]?.message).toContain("not in the @ktb/json-schema subset");
		expect(issueAt({ foo: 1 }, "/foo")?.path).toBe("/foo");
	});

	it("accepts every documented keyword", () => {
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$comment: "note",
			title: "T",
			description: "D",
			default: { a: [1, "x", null] },
			type: ["object", "null"],
			properties: { a: { type: "string" } },
			required: ["a"],
			additionalProperties: false,
			items: true,
			enum: [1, "x", null, { k: [true] }],
			const: { nested: { ok: 1 } },
			pattern: "^[a-z]+$",
			minLength: 0,
			maxLength: 10,
			minimum: -1.5,
			maximum: 1e9,
			minItems: 0,
			maxItems: 3,
			minProperties: 0,
			maxProperties: 9,
			allOf: [{ type: "string" }],
			anyOf: [true, { const: 1 }],
			oneOf: [{ enum: [1] }, { enum: [2] }],
			not: { type: "null" },
		};
		expect(checkSchema(schema)).toEqual([]);
	});

	it("rejects non-string annotations", () => {
		for (const key of ["$schema", "title", "description", "$comment"] as const) {
			const issues = checkSchema({ [key]: 5 });
			expect(issues).toHaveLength(1);
			expect(issues[0]?.keyword).toBe(key);
			expect(issues[0]?.message).toBe(`${key} must be a string`);
		}
	});

	it("rejects non-JSON default/enum/const values", () => {
		expect(issueAt({ default: undefined }, "/default")?.message).toBe(
			"default must be a JSON value",
		);
		expect(issueAt({ default: NaN }, "/default")).toBeDefined();
		expect(issueAt({ default: new Date(0) }, "/default")).toBeDefined();
		expect(issueAt({ enum: "x" }, "/enum")?.message).toBe("enum must be an array");
		expect(issueAt({ enum: [1, undefined] }, "/enum")?.message).toBe(
			"enum entries must be JSON values",
		);
		expect(issueAt({ const: () => 1 }, "/const")?.message).toBe("const must be a JSON value");
		// Circular const payload.
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(issueAt({ const: circular }, "/const")).toBeDefined();
		// Object.create(null) IS a valid JSON value.
		const nullProto = Object.create(null) as Record<string, unknown>;
		nullProto.a = 1;
		expect(checkSchema({ const: nullProto })).toEqual([]);
	});
});

describe("checkSchema — type", () => {
	it("accepts scalar and array forms", () => {
		expect(checkSchema({ type: "string" })).toEqual([]);
		expect(checkSchema({ type: ["string", "null"] })).toEqual([]);
	});

	it("rejects empty, invalid and duplicate type lists", () => {
		expect(issueAt({ type: [] }, "/type")?.message).toBe("type array must not be empty");
		expect(issueAt({ type: "strnig" }, "/type")?.message).toContain("type must be one of");
		expect(issueAt({ type: ["string", 4] }, "/type")?.message).toContain("type must be one of");
		expect(issueAt({ type: ["string", "string"] }, "/type")?.message).toBe(
			'duplicate type "string"',
		);
	});

	it("exposes the seven JSON Schema types", () => {
		expect(JSON_SCHEMA_TYPES).toEqual([
			"string",
			"number",
			"integer",
			"boolean",
			"null",
			"object",
			"array",
		]);
	});
});

describe("checkSchema — object/array keywords", () => {
	it("walks properties and rejects non-object properties", () => {
		expect(checkSchema({ properties: { a: { type: "string" } } })).toEqual([]);
		expect(checkSchema({ properties: { a: true, b: false } })).toEqual([]);
		expect(issueAt({ properties: [] }, "/properties")?.message).toBe(
			"properties must be an object of schemas",
		);
		expect(
			issueAt({ properties: { "a/b": { type: "x" } } }, "/properties/a~1b/type"),
		).toBeDefined();
	});

	it("validates required", () => {
		expect(checkSchema({ required: ["a", "b"] })).toEqual([]);
		expect(issueAt({ required: "a" }, "/required")?.message).toBe("required must be an array");
		expect(issueAt({ required: ["a", ""] }, "/required")?.message).toBe(
			"required entries must be non-empty strings",
		);
		expect(issueAt({ required: [1] }, "/required")?.message).toBe(
			"required entries must be non-empty strings",
		);
		expect(issueAt({ required: ["a", "a"] }, "/required")?.message).toBe(
			"required entries must be unique",
		);
	});

	it("walks additionalProperties/items/not as subschemas", () => {
		expect(
			checkSchema({
				additionalProperties: { type: "number" },
				items: { enum: [1] },
				not: { const: null },
			}),
		).toEqual([]);
		expect(issueAt({ items: { type: "nope" } }, "/items/type")).toBeDefined();
		expect(issueAt({ not: 7 }, "/not")?.message).toContain("must be an object or boolean");
	});
});

describe("checkSchema — bounds and pattern", () => {
	it("accepts valid bounds", () => {
		expect(
			checkSchema({
				minLength: 0,
				maxLength: 5,
				minItems: 1,
				maxItems: 2,
				minProperties: 0,
				maxProperties: 4,
				minimum: -10,
				maximum: 10.5,
			}),
		).toEqual([]);
	});

	it("rejects malformed bounds", () => {
		for (const key of [
			"minLength",
			"maxLength",
			"minItems",
			"maxItems",
			"minProperties",
			"maxProperties",
		] as const) {
			expect(issueAt({ [key]: -1 }, `/${key}`)?.message).toBe(
				`${key} must be a non-negative integer`,
			);
			expect(issueAt({ [key]: 1.5 }, `/${key}`)?.message).toBe(
				`${key} must be a non-negative integer`,
			);
			expect(issueAt({ [key]: "x" }, `/${key}`)?.message).toBe(
				`${key} must be a non-negative integer`,
			);
		}
		for (const key of ["minimum", "maximum"] as const) {
			expect(issueAt({ [key]: "x" }, `/${key}`)?.message).toBe(`${key} must be a finite number`);
			expect(issueAt({ [key]: Infinity }, `/${key}`)?.message).toBe(
				`${key} must be a finite number`,
			);
		}
	});

	it("validates pattern sources", () => {
		expect(checkSchema({ pattern: "^a.*z$" })).toEqual([]);
		expect(issueAt({ pattern: 5 }, "/pattern")?.message).toBe("pattern must be a string");
		expect(issueAt({ pattern: "a".repeat(MAX_PATTERN_LENGTH + 1) }, "/pattern")?.message).toBe(
			`pattern exceeds ${MAX_PATTERN_LENGTH} characters`,
		);
		expect(issueAt({ pattern: "(a+)+$" }, "/pattern")?.message).toBe(
			"pattern has nested quantifiers (ReDoS risk)",
		);
		expect(issueAt({ pattern: "(" }, "/pattern")?.message).toBe(
			"pattern is not a valid regular expression",
		);
	});
});

describe("checkSchema — combinators", () => {
	it("walks allOf/anyOf/oneOf element schemas", () => {
		expect(
			checkSchema({
				allOf: [{ type: "string" }, true],
				anyOf: [{ const: 1 }],
				oneOf: [false, { type: "null" }],
			}),
		).toEqual([]);
	});

	it("rejects non-array and empty combinator values", () => {
		for (const key of ["allOf", "anyOf", "oneOf"] as const) {
			expect(issueAt({ [key]: {} }, `/${key}`)?.message).toBe(
				`${key} must be a non-empty array of schemas`,
			);
			expect(issueAt({ [key]: [] }, `/${key}`)?.message).toBe(
				`${key} must be a non-empty array of schemas`,
			);
			expect(issueAt({ [key]: [{ type: "bad" }] }, `/${key}/0/type`)).toBeDefined();
		}
	});
});

describe("checkSchema — $ref", () => {
	it("accepts resolvable internal pointers", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				alias: { $ref: "#/properties/name" },
			},
		};
		expect(checkSchema(schema)).toEqual([]);
	});

	it("resolves pointers through array indices", () => {
		const schema = {
			allOf: [
				{
					type: "object",
					properties: { a: { type: "string" } },
				},
			],
			items: { $ref: "#/allOf/0/properties/a" },
		};
		expect(checkSchema(schema)).toEqual([]);
	});

	it("walks $ref targets and reports issues at the ref site", () => {
		// "#/properties" resolves to the properties MAP — not a schema —
		// so walking it surfaces unknown-keyword issues under the ref.
		const schema = {
			properties: { a: { type: "string" } },
			items: { $ref: "#/properties" },
		};
		expect(issueAt(schema, "/items/$ref/a")).toBeDefined();
	});

	it("resolves pointers into arrays and escaped segments", () => {
		const schema = {
			properties: {
				"a/b": { type: "string" },
				"~key": { type: "number" },
			},
			allOf: [{ $ref: "#/properties/a~1b" }, { $ref: "#/properties/~0key" }],
		};
		expect(checkSchema(schema)).toEqual([]);
	});

	it("rejects non-string, remote and malformed refs", () => {
		expect(issueAt({ $ref: 5 }, "/$ref")?.message).toBe("$ref must be a string");
		expect(issueAt({ $ref: "https://x.com/s.json" }, "/$ref")?.message).toContain(
			"not an internal JSON pointer",
		);
		expect(issueAt({ $ref: "definitions/foo" }, "/$ref")?.message).toContain(
			"not an internal JSON pointer",
		);
		expect(issueAt({ $ref: "#/missing" }, "/$ref")?.message).toContain("does not resolve");
		expect(issueAt({ $ref: "#/properties/a%20b" }, "/$ref")?.message).toContain("percent-encoding");
	});

	it("rejects unresolvable pointer edge cases", () => {
		// Array index that is not numeric.
		expect(issueAt({ allOf: [{ $ref: "#/allOf/x" }] }, "/allOf/0/$ref")).toBeDefined();
		// Array index out of range.
		expect(issueAt({ allOf: [{ $ref: "#/allOf/9" }] }, "/allOf/0/$ref")).toBeDefined();
		// Path crosses a non-container.
		expect(
			issueAt({ type: "string", properties: { a: { $ref: "#/type/x" } } }, "/properties/a/$ref"),
		).toBeDefined();
		// Resolves to an explicit null node.
		const withNull = {
			properties: { a: null, b: { $ref: "#/properties/a" } },
		};
		expect(checkSchema(withNull).some((i) => i.message.includes("does not resolve"))).toBe(true);
		// Resolves to an explicit undefined node.
		const withUndef = {
			properties: { a: undefined, b: { $ref: "#/properties/a" } },
		};
		expect(checkSchema(withUndef).some((i) => i.message.includes("does not resolve"))).toBe(true);
	});

	it('resolves "#" to the document root (and catches the recursion)', () => {
		const schema = { properties: { a: { $ref: "#" } } };
		expect(checkSchema(schema).some((i) => i.message.includes("recursive"))).toBe(true);
	});

	it("rejects recursive $refs", () => {
		const direct = { properties: { a: { $ref: "#/properties/a" } } };
		expect(checkSchema(direct).some((i) => i.message.includes("recursive"))).toBe(true);

		const indirect = {
			properties: {
				a: { $ref: "#/properties/b" },
				b: { $ref: "#/properties/a" },
			},
		};
		expect(checkSchema(indirect).some((i) => i.message.includes("recursive"))).toBe(true);
	});
});

describe("checkSchema — size limits", () => {
	it("rejects schemas deeper than MAX_SCHEMA_DEPTH", () => {
		let node: Record<string, unknown> = { type: "string" };
		for (let i = 0; i < MAX_SCHEMA_DEPTH + 5; i++) {
			node = { properties: { a: node } };
		}
		const issues = checkSchema(node);
		expect(issues.some((i) => i.message.includes(`depth ${MAX_SCHEMA_DEPTH}`))).toBe(true);
	});

	it("rejects schemas exceeding MAX_SCHEMA_NODES", () => {
		const properties: Record<string, unknown> = {};
		for (let i = 0; i < MAX_SCHEMA_NODES + 10; i++) properties[`p${i}`] = {};
		const issues = checkSchema({ type: "object", properties });
		expect(issues.some((i) => i.message.includes(`nodes`))).toBe(true);
	});
});

describe("assertSchema", () => {
	it("returns silently for conforming schemas", () => {
		expect(() => assertSchema({ type: "string" })).not.toThrow();
		expect(() => assertSchema(true)).not.toThrow();
	});

	/** Run `fn` and return the thrown value (fails the test if nothing
	 * is thrown) — keeps `expect` calls out of conditional branches. */
	const catchError = (fn: () => void): unknown => {
		try {
			fn();
		} catch (error) {
			return error;
		}
		throw new Error("expected function to throw");
	};

	it("throws SchemaDefinitionError carrying all issues", () => {
		const error = catchError(() => assertSchema({ type: "nope", extra: 1 }));
		expect(error).toBeInstanceOf(SchemaDefinitionError);
		const err = error as SchemaDefinitionError;
		expect(err.name).toBe("SchemaDefinitionError");
		expect(err.issues.length).toBeGreaterThanOrEqual(2);
		expect(err.message).toContain("invalid @ktb/json-schema schema");
		expect(err.message).toContain("/type");
	});

	it("singularizes the issue count in the message", () => {
		const error = catchError(() => assertSchema(42)) as SchemaDefinitionError;
		expect(error.message).toContain("(1 issue)");
	});
});
