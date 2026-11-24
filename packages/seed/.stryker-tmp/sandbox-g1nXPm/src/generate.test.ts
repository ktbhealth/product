// @ts-nocheck
import { describe, expect, it } from "vitest";

import { validate, type JsonSchema } from "@ktb/json-schema";

import { generate, generateMany, generateRecord, MAX_GENERATE_MANY, SeedError } from "./index.ts";

/**
 * Fixture corpus — one schema per subset feature area. Every schema
 * here is asserted subset-valid implicitly: `assertValid: true` runs
 * the generated value through @ktb/json-schema's validate(), which
 * itself rejects out-of-subset schemas.
 */
const CORPUS: ReadonlyArray<readonly [string, JsonSchema]> = [
	["anything", {}],
	["true", true],
	["const-string", { const: "fixed" }],
	["const-null", { const: null }],
	["const-object", { const: { a: [1, 2], b: "x" } }],
	["enum-strings", { enum: ["alpha", "beta", "gamma"] }],
	["enum-numbers", { enum: [1, 2.5, -3] }],
	["enum-mixed", { enum: ["s", 1, true, null, { k: "v" }] }],
	["type-union", { type: ["string", "null"] }],
	["string-bounded", { type: "string", minLength: 3, maxLength: 12 }],
	["string-pattern-cpf", { type: "string", pattern: "^\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}$" }],
	["string-pattern-code", { type: "string", pattern: "^[A-Z]{2}\\d{4}$" }],
	[
		"string-pattern-uuid",
		{ type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
	],
	["string-pattern-alt", { type: "string", pattern: "^(cat|dog|bird)$" }],
	["string-pattern-class", { type: "string", pattern: "^[a-c]{2,5}\\d?$" }],
	["string-pattern-unanchored", { type: "string", pattern: "\\d{2}-\\d{2}" }],
	["number-bounded", { type: "number", minimum: 1.5, maximum: 9.5 }],
	["number-negative", { type: "number", minimum: -10, maximum: -1 }],
	["integer", { type: "integer", minimum: 0, maximum: 10 }],
	["integer-unbounded", { type: "integer" }],
	["integer-single", { type: "integer", minimum: 7, maximum: 7 }],
	["boolean", { type: "boolean" }],
	["null", { type: "null" }],
	["array-strings", { type: "array", items: { type: "string" } }],
	["array-bounded", { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 4 }],
	[
		"array-objects",
		{
			type: "array",
			items: {
				type: "object",
				properties: { id: { type: "integer" }, label: { type: "string" } },
				required: ["id"],
			},
			minItems: 1,
		},
	],
	["array-empty-items", { type: "array", minItems: 0, maxItems: 2 }],
	["array-items-false", { type: "array", items: false, maxItems: 0 }],
	[
		"object-basic",
		{
			type: "object",
			properties: {
				name: { type: "string", minLength: 1 },
				age: { type: "integer", minimum: 0, maximum: 120 },
				role: { enum: ["a", "b"] },
			},
			required: ["name", "age"],
			additionalProperties: false,
		},
	],
	[
		"object-additional-schema",
		{
			type: "object",
			properties: { fixed: { type: "string" } },
			additionalProperties: { type: "integer" },
			minProperties: 2,
		},
	],
	[
		"object-additional-true",
		{ type: "object", properties: { a: { type: "boolean" } }, additionalProperties: true },
	],
	[
		"object-minmax-props",
		{
			type: "object",
			minProperties: 1,
			maxProperties: 2,
			additionalProperties: { type: "string" },
		},
	],
	[
		"object-nested",
		{
			type: "object",
			properties: {
				outer: {
					type: "object",
					properties: {
						inner: {
							type: "object",
							properties: { leaf: { type: "string", maxLength: 5 } },
							required: ["leaf"],
						},
					},
					required: ["inner"],
				},
			},
			required: ["outer"],
		},
	],
	[
		"ref-basic",
		{
			type: "object",
			properties: {
				name: { type: "string", minLength: 2 },
				alias: { $ref: "#/properties/name" },
			},
			required: ["name", "alias"],
		},
	],
	[
		"ref-chain",
		{
			type: "object",
			properties: {
				a: { type: "string", minLength: 3 },
				b: { $ref: "#/properties/a" },
				c: { $ref: "#/properties/b" },
			},
			required: ["a", "b", "c"],
		},
	],
	[
		"allOf-merge",
		{
			allOf: [
				{ type: "object", properties: { x: { type: "integer", minimum: 0 } }, required: ["x"] },
				{ type: "object", properties: { y: { type: "string" } }, required: ["y"] },
			],
		},
	],
	[
		"allOf-bounds",
		{
			allOf: [
				{ type: "integer", minimum: 5 },
				{ type: "integer", maximum: 10 },
			],
		},
	],
	["allOf-enum-intersect", { allOf: [{ enum: ["a", "b", "c"] }, { enum: ["b", "c", "d"] }] }],
	[
		"anyOf",
		{
			anyOf: [
				{ type: "string", minLength: 2 },
				{ type: "integer", minimum: 0, maximum: 5 },
			],
		},
	],
	["oneOf", { oneOf: [{ const: "x" }, { const: "y" }] }],
	[
		"combinator-with-siblings",
		{
			type: "object",
			properties: { tag: { type: "string" } },
			required: ["tag"],
			anyOf: [{ required: ["tag"] }],
		},
	],
	["number-exact", { type: "number", minimum: 3, maximum: 3 }],
	["infer-object", { properties: { a: { type: "integer" } }, required: ["a"] }],
	["infer-array", { items: { type: "boolean" }, minItems: 1, maxItems: 2 }],
	["infer-string", { minLength: 3, maxLength: 8 }],
	["infer-number", { minimum: 1, maximum: 2 }],
	["string-padded", { type: "string", minLength: 30, maxLength: 60 }],
	[
		"object-required-extra-prop",
		{
			type: "object",
			required: ["ghost"],
			additionalProperties: { type: "integer", minimum: 0, maximum: 9 },
		},
	],
	[
		"object-required-any-prop",
		{
			type: "object",
			required: ["ghost"],
			additionalProperties: true,
		},
	],
	[
		"object-required-undeclared",
		{
			type: "object",
			required: ["mystery"],
		},
	],
	[
		"object-extra-key-collision",
		{
			type: "object",
			properties: { extra0: { type: "string" } },
			minProperties: 2,
			additionalProperties: { type: "integer" },
		},
	],
	[
		"object-trim-maxprops",
		{
			type: "object",
			properties: {
				a: { type: "string" },
				b: { type: "string" },
				c: { type: "string" },
			},
			required: ["a"],
			maxProperties: 2,
			additionalProperties: false,
		},
	],
	[
		"deep-record",
		{
			type: "object",
			properties: {
				patient: {
					type: "object",
					properties: {
						name: { type: "string" },
						cpf: { type: "string", pattern: "^\\d{11}$" },
						birthDate: { type: "string" },
					},
					required: ["name", "cpf", "birthDate"],
				},
				consultations: {
					type: "array",
					items: {
						type: "object",
						properties: {
							date: { type: "string" },
							notes: { type: "array", items: { type: "string" }, maxItems: 2 },
						},
						required: ["date"],
					},
					maxItems: 2,
				},
			},
			required: ["patient"],
		},
	],
];

const SEEDS = ["alpha", "beta", "gamma", "demo-2026", 42, 1337];

describe("generate — corpus property tests", () => {
	for (const [name, schema] of CORPUS) {
		it(`generates valid values for ${name}`, () => {
			for (const seed of SEEDS) {
				const values = generateMany(schema, 15, {
					seed,
					locale: "pt-BR",
					assertValid: true,
				});
				for (const v of values) {
					expect(validate(schema, v), `seed=${seed}`).toEqual([]);
				}
			}
		});
	}
});

describe("generate — determinism", () => {
	it("same seed produces identical output", () => {
		const schema = CORPUS.find(([n]) => n === "deep-record")?.[1] as JsonSchema;
		const a = generateMany(schema, 5, { seed: "det", locale: "pt-BR" });
		const b = generateMany(schema, 5, { seed: "det", locale: "pt-BR" });
		expect(a).toEqual(b);
	});

	it("different seeds produce different output", () => {
		const schema = CORPUS.find(([n]) => n === "deep-record")?.[1] as JsonSchema;
		const a = JSON.stringify(generateMany(schema, 10, { seed: "one", locale: "pt-BR" }));
		const b = JSON.stringify(generateMany(schema, 10, { seed: "two", locale: "pt-BR" }));
		expect(a).not.toBe(b);
	});

	it("an injected rng is used and advances across generateMany", () => {
		let calls = 0;
		const rng = () => {
			calls++;
			return 0.5;
		};
		generateMany({ type: "integer", minimum: 0, maximum: 10 }, 3, { rng });
		expect(calls).toBeGreaterThan(0);
	});
});

describe("generate — options", () => {
	it("requiredOnly limits object keys to required ones", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
			required: ["a"],
		};
		for (let i = 0; i < 10; i++) {
			const rec = generateRecord(schema, { seed: `ro${i}`, requiredOnly: true, assertValid: true });
			expect(Object.keys(rec)).toEqual(["a"]);
		}
	});

	it("depth limit throws SeedError", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: { a: { $ref: "#/properties/a" } },
		};
		// self-$ref is a definition error upstream; use a finite deep nest instead
		const deep: JsonSchema = {
			type: "object",
			properties: {
				l1: {
					type: "object",
					properties: { l2: { type: "object", properties: { l3: { type: "string" } } } },
				},
			},
		};
		expect(() => generate(deep, { seed: 1, depth: 1 })).toThrow(SeedError);
		void schema;
	});

	it("maxNodes limit throws SeedError", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				a: {
					type: "array",
					items: { type: "object", properties: { x: { type: "string" } } },
					minItems: 3,
				},
				b: { type: "array", items: { type: "string" }, minItems: 3 },
			},
		};
		expect(() => generate(schema, { seed: 1, maxNodes: 3 })).toThrow(SeedError);
	});
});

describe("generate — error cases", () => {
	const cases: ReadonlyArray<readonly [string, JsonSchema, string?]> = [
		["false schema", false],
		["empty enum", { enum: [] }],
		["inverted number bounds", { type: "number", minimum: 10, maximum: 5 }],
		["inverted length bounds", { type: "string", minLength: 10, maxLength: 5 }],
		["inverted items bounds", { type: "array", minItems: 5, maxItems: 2 }],
		["inverted props bounds", { type: "object", minProperties: 3, maxProperties: 1 }],
		["integer gap", { type: "integer", minimum: 0.5, maximum: 0.9 }],
		["items-false-with-min", { type: "array", items: false, minItems: 1 }],
		["not-schema", { not: { const: 1 } }],
		["unsatisfiable allOf", { allOf: [{ type: "string" }, { type: "integer" }] }],
		["conflicting consts", { allOf: [{ const: "a" }, { const: "b" }] }],
		["empty enum intersection", { allOf: [{ enum: ["a"] }, { enum: ["b"] }] }],
		[
			"conflicting patterns",
			{
				allOf: [
					{ type: "string", pattern: "^a$" },
					{ type: "string", pattern: "^b$" },
				],
			},
		],
		["unresolvable ref", { type: "object", properties: { x: { $ref: "#/properties/missing" } } }],
		[
			"recursive ref",
			{
				type: "object",
				properties: { a: { $ref: "#/properties/b" }, b: { $ref: "#/properties/a" } },
			},
		],
		[
			"required prop without schema, additionalProperties:false",
			{ type: "object", required: ["ghost"], additionalProperties: false },
		],
		[
			"required props exceed maxProperties",
			{
				type: "object",
				properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
				required: ["a", "b", "c"],
				maxProperties: 2,
				additionalProperties: false,
			},
		],
		["minLength unreachable", { type: "string", minLength: 100000 }],
		// \b is modeled as zero-width, but "a\bb" needs a real boundary
		// between a and b — no candidate can ever verify.
		["pattern with unsatisfiable boundary", { type: "string", pattern: "a\\bb" }],
		["unsupported pattern lookahead", { type: "string", pattern: "^(?=a)a$" }],
		["unsupported pattern backref", { type: "string", pattern: "^(a)\\1$" }],
		["pattern exceeding maxLength", { type: "string", pattern: "^a{40}$", maxLength: 10 }],
		// Catastrophic-backtracking shapes — rejected BEFORE the
		// uninterruptible RegExp verify could hang the event loop.
		["alternation ReDoS", { type: "string", pattern: "(a|aa)+b" }],
		["nested-quantifier ReDoS", { type: "string", pattern: "(a+)+b" }],
		["quantified alternation", { type: "string", pattern: "(a|b)*c" }],
		[
			"minProperties impossible",
			{
				type: "object",
				properties: { a: { type: "string" } },
				minProperties: 3,
				additionalProperties: false,
			},
		],
	];
	for (const [name, schema] of cases) {
		it(`throws SeedError for ${name}`, () => {
			expect(() => generate(schema, { seed: 1 })).toThrow(SeedError);
		});
	}
});

describe("generate — locale pools", () => {
	const patientSchema: JsonSchema = {
		type: "object",
		properties: {
			name: { type: "string" },
			firstName: { type: "string" },
			lastName: { type: "string" },
			email: { type: "string" },
			phone: { type: "string" },
			cpf: { type: "string" },
			city: { type: "string" },
			state: { type: "string" },
			birthDate: { type: "string" },
			createdAt: { type: "string" },
			website: { type: "string" },
		},
	};

	it("pt-BR produces pt-BR-looking data", () => {
		const names = new Set<string>();
		for (let i = 0; i < 60; i++) {
			const rec = generateRecord(patientSchema, { seed: `p${i}`, locale: "pt-BR" }) as Record<
				string,
				string
			>;
			expect(rec.name).toMatch(/^[A-ZÀ-Ý]/);
			expect(rec.name).toContain(" ");
			expect(rec.email).toMatch(/@/);
			expect(rec.phone).toMatch(/^\(\d{2}\) 9\d{4}-\d{4}$/);
			expect(rec.cpf).toMatch(/^\d{11}$/);
			expect(rec.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(rec.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(rec.state).toMatch(/^[A-Z]{2}$/);
			names.add(rec.name);
		}
		expect(names.size).toBeGreaterThan(10);
		// Accent coverage across the pool sample.
		const all = [...names].join(" ");
		expect(/[ãõçáéíóúâêôà]/i.test(all)).toBe(true);
	});

	it("cpf check digits are valid", () => {
		const check = (cpf: string): boolean => {
			const d = cpf.split("").map(Number);
			const dv = (nums: number[], w: number[]) => {
				const r = (nums.reduce((a, n, i) => a + n * w[i]!, 0) * 10) % 11;
				return r === 10 ? 0 : r;
			};
			return (
				dv(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) === d[9] &&
				dv(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === d[10]
			);
		};
		for (let i = 0; i < 20; i++) {
			const rec = generateRecord(patientSchema, { seed: `cpf${i}`, locale: "pt-BR" });
			expect(check(rec.cpf as string)).toBe(true);
		}
	});

	it("en locale uses English pools", () => {
		const rec = generateRecord(patientSchema, { seed: "en1", locale: "en" }) as Record<
			string,
			string
		>;
		expect(rec.phone).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
		expect(rec.cpf).toMatch(/^\d{11}$/); // key heuristic still emits CPF digits
	});

	it("unknown locale falls back to en", () => {
		const rec = generateRecord(patientSchema, { seed: "xx", locale: "xx-YY" }) as Record<
			string,
			string
		>;
		expect(rec.phone).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
	});

	it("regional variants resolve via base language (pt-PT → pt-BR)", () => {
		const rec = generateRecord(patientSchema, { seed: "pt", locale: "pt-PT" }) as Record<
			string,
			string
		>;
		expect(rec.phone).toMatch(/^\(\d{2}\) 9\d{4}-\d{4}$/);
		expect(rec.cpf).toMatch(/^\d{11}$/);
	});
});

describe("generate — string heuristics coverage", () => {
	const keys = [
		"username",
		"cep",
		"postalCode",
		"website2",
		"birth_date",
		"format",
		"filename",
		"first_name",
		"surname",
		"socialName",
		"city",
		"uf",
		"district",
		"addressLine",
		"addressNumber",
		"complement",
		"country",
		"gender",
		"preferredLanguage",
		"currency",
		"cnpj",
		"note",
		"uuid",
		"record_id",
		"guid",
		"street",
		"endereco",
		"numero",
		"unlink",
		"avatar",
		"homepage",
		"uri",
	];
	it("every heuristic key produces a schema-valid string", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
		};
		for (const locale of ["pt-BR", "en"] as const) {
			for (let i = 0; i < 10; i++) {
				const rec = generateRecord(schema, { seed: `h${i}`, locale, assertValid: true });
				for (const k of keys) expect(typeof rec[k]).toBe("string");
			}
		}
	});

	it("padding never exceeds maxLength", () => {
		for (let i = 0; i < 30; i++) {
			const v = generate(
				{ type: "string", minLength: 28, maxLength: 30 },
				{
					seed: `pad${i}`,
					assertValid: true,
				},
			) as string;
			expect(v.length).toBeGreaterThanOrEqual(28);
			expect(v.length).toBeLessThanOrEqual(30);
		}
	});

	it("format is NOT treated as a timestamp", () => {
		const rec = generateRecord(
			{ type: "object", properties: { format: { type: "string" } } },
			{ seed: "fmt", locale: "en" },
		);
		expect(rec.format).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("generate — schema-merge branches (allOf / $ref / combinators)", () => {
	const valid = (schema: JsonSchema, seed = "m") => {
		const v = generate(schema, { seed, assertValid: true });
		expect(validate(schema, v)).toEqual([]);
		return v;
	};

	it("merges overlapping properties, required and annotations", () => {
		const v = valid({
			allOf: [
				{
					type: "object",
					properties: { x: { type: "integer", minimum: 0 } },
					required: ["x"],
					title: "A",
				},
				{
					type: "object",
					properties: { x: { type: "integer", maximum: 9 }, y: { type: "string" } },
					required: ["y"],
					description: "B",
				},
			],
		}) as Record<string, unknown>;
		expect(typeof v.x).toBe("number");
		expect(typeof v.y).toBe("string");
	});

	it("intersects enums containing objects and arrays", () => {
		const v = valid({
			allOf: [{ enum: [{ a: 1 }, [1, 2], "x"] }, { enum: [{ a: 1 }, "x", "y"] }],
		});
		expect(['{"a":1}', '"x"']).toContain(JSON.stringify(v));
	});

	it("compares const objects deeply", () => {
		expect(valid({ allOf: [{ const: { a: [1] } }, { const: { a: [1] } }] })).toEqual({ a: [1] });
	});

	it("throws on inverted bounds produced by merging", () => {
		expect(() =>
			generate(
				{
					allOf: [
						{ type: "string", minLength: 10 },
						{ type: "string", maxLength: 5 },
					],
				},
				{ seed: 1 },
			),
		).toThrow(SeedError);
	});

	it("merges patterns when identical or absent on one side", () => {
		const a = valid({
			allOf: [
				{ type: "string", pattern: "^a+$" },
				{ type: "string", minLength: 1 },
			],
		}) as string;
		expect(a).toMatch(/^a+$/);
		const b = valid({ allOf: [{ pattern: "^x$" }, { pattern: "^x$" }] }) as string;
		expect(b).toBe("x");
	});

	it("merges items schemas", () => {
		const v = valid({
			allOf: [
				{ type: "array", items: { type: "integer", minimum: 0 }, minItems: 1 },
				{ type: "array", items: { type: "integer", maximum: 9 } },
			],
		}) as unknown[];
		for (const n of v) {
			expect(Number.isInteger(n)).toBe(true);
			expect(n as number).toBeGreaterThanOrEqual(0);
			expect(n as number).toBeLessThanOrEqual(9);
		}
	});

	it("merges additionalProperties in all four combinations", () => {
		// NOTE: additionalProperties inside an allOf branch applies to
		// every property not declared in THAT branch — mixing it with
		// sibling-branch properties is a schema-design footgun, so these
		// cases use property-free branches.
		// false dominates
		valid({
			allOf: [
				{ type: "object", additionalProperties: false },
				{ type: "object", additionalProperties: { type: "integer" } },
			],
		});
		// a-side undefined → take b
		valid({
			allOf: [
				{ type: "object" },
				{ type: "object", additionalProperties: { type: "integer" }, minProperties: 1 },
			],
		});
		// a-side true → take b
		valid({
			allOf: [
				{ type: "object", additionalProperties: true },
				{ type: "object", additionalProperties: { type: "integer" }, minProperties: 1 },
			],
		});
		// b-side true → keep a
		valid({
			allOf: [
				{ type: "object", additionalProperties: { type: "integer" }, minProperties: 1 },
				{ type: "object", additionalProperties: true },
			],
		});
		// both schemas → merged (must satisfy BOTH → integer 0..9)
		const v = valid({
			allOf: [
				{ type: "object", additionalProperties: { type: "integer", minimum: 0 } },
				{ type: "object", additionalProperties: { type: "integer", maximum: 9 }, minProperties: 1 },
			],
		}) as Record<string, unknown>;
		for (const val of Object.values(v)) {
			expect(Number.isInteger(val)).toBe(true);
			expect(val as number).toBeGreaterThanOrEqual(0);
			expect(val as number).toBeLessThanOrEqual(9);
		}
	});

	it("distributes anyOf pairs inside allOf into satisfiable combos", () => {
		const v = valid({
			allOf: [
				{ anyOf: [{ type: "string", minLength: 2 }] },
				{ anyOf: [{ type: "string", maxLength: 9 }] },
			],
		}) as string;
		expect(v.length).toBeGreaterThanOrEqual(2);
		expect(v.length).toBeLessThanOrEqual(9);
	});

	it("merges not-schemas into not(anyOf) and still throws", () => {
		expect(() =>
			generate({ allOf: [{ not: { const: 1 } }, { not: { const: 2 } }] }, { seed: 1 }),
		).toThrow(SeedError);
		expect(() =>
			generate({ allOf: [{ not: { const: 1 } }, { type: "string" }] }, { seed: 1 }),
		).toThrow(SeedError);
	});

	it("handles boolean branches inside allOf", () => {
		valid({ allOf: [true, { type: "string", minLength: 2 }] });
		expect(() => generate({ allOf: [{ type: "string" }, false] }, { seed: 1 })).toThrow(SeedError);
	});

	it("resolves $ref inside allOf branches", () => {
		const v = valid({
			type: "object",
			properties: {
				x: { type: "string", minLength: 3 },
				y: { allOf: [{ $ref: "#/properties/x" }, { type: "string", maxLength: 9 }] },
			},
			required: ["x", "y"],
		}) as Record<string, string>;
		expect(v.y.length).toBeGreaterThanOrEqual(3);
		expect(v.y.length).toBeLessThanOrEqual(9);
	});

	it("keeps multi-type intersections as arrays", () => {
		const v = valid({
			allOf: [{ type: ["string", "null"] }, { type: ["null", "string"] }],
		});
		expect(["string", "null"]).toContain(typeof v === "object" ? "null" : typeof v);
	});

	it("merges a combinator present on only one side", () => {
		const v = valid({
			allOf: [{ anyOf: [{ type: "string", minLength: 1 }] }, { type: "string" }],
		}) as string;
		expect(v.length).toBeGreaterThanOrEqual(1);
	});

	it("resolves $ref to a boolean schema target", () => {
		const v = valid({
			type: "object",
			properties: { q: true, p: { $ref: "#/properties/q" } },
			required: ["p"],
		}) as Record<string, unknown>;
		expect(Object.hasOwn(v, "p")).toBe(true);
	});

	it("merges $ref siblings (2020-12 semantics)", () => {
		const v = valid({
			type: "object",
			properties: {
				name: { type: "string", minLength: 2 },
				alias: { $ref: "#/properties/name", maxLength: 4 },
			},
			required: ["name", "alias"],
		}) as Record<string, string>;
		expect(v.alias.length).toBeGreaterThanOrEqual(2);
		expect(v.alias.length).toBeLessThanOrEqual(4);
	});

	it("resolves $ref through array segments", () => {
		const v = valid({
			type: "object",
			properties: {
				arr: { type: "array", items: { type: "string", minLength: 2 } },
				p: { $ref: "#/properties/arr/items" },
			},
			required: ["p"],
		}) as Record<string, unknown>;
		expect(typeof v.p).toBe("string");
		expect((v.p as string).length).toBeGreaterThanOrEqual(2);
	});

	it("resolves $ref into an allOf array element", () => {
		const v = valid({
			type: "object",
			allOf: [{ type: "object" }],
			properties: { p: { $ref: "#/allOf/0" } },
		}) as Record<string, unknown>;
		expect(v.p).toEqual({});
	});

	it("flattens nested allOf inside branches", () => {
		const v = valid({
			allOf: [{ allOf: [{ type: "string", pattern: "^a" }] }, { type: "string", maxLength: 5 }],
		}) as string;
		expect(v).toMatch(/^a/);
		expect(v.length).toBeLessThanOrEqual(5);
	});

	it("throws when combinator cross-product is too large or empty", () => {
		const big = (n: number, type: string) =>
			Array.from({ length: n }, (_, i) => ({ type, minimum: i, maximum: i }));
		// 9 × 8 = 72 > 64 → too large (integer branches keep merges valid)
		expect(() =>
			generate(
				{ allOf: [{ anyOf: big(9, "integer") }, { anyOf: big(8, "integer") }] } as JsonSchema,
				{ seed: 1 },
			),
		).toThrow(SeedError);
		// every pair conflicts → no satisfiable combination
		expect(() =>
			generate(
				{
					allOf: [{ anyOf: [{ type: "string" }] }, { anyOf: [{ type: "integer" }] }],
				} as JsonSchema,
				{ seed: 1 },
			),
		).toThrow(SeedError);
	});

	it("rejects non-numeric array segments, scalar traversal and '#' recursion", () => {
		expect(() =>
			generate(
				{
					type: "object",
					allOf: [{ type: "object" }],
					properties: { p: { $ref: "#/allOf/x" } },
				} as JsonSchema,
				{ seed: 1 },
			),
		).toThrow(SeedError);
		expect(() =>
			generate({ type: "object", properties: { p: { $ref: "#/type/x" } } } as JsonSchema, {
				seed: 1,
			}),
		).toThrow(SeedError);
		// "$ref":"#" points at the root → recursive descent → depth/budget error
		expect(() =>
			generate({ type: "object", properties: { p: { $ref: "#" } } } as JsonSchema, { seed: 1 }),
		).toThrow(SeedError);
	});
});

describe("generate — depth and assertValid", () => {
	it("array nesting respects the depth guard", () => {
		const schema: JsonSchema = {
			type: "array",
			items: { type: "array", items: { type: "string" } },
			minItems: 1,
		};
		expect(() => generate(schema, { seed: 1, depth: 1 })).toThrow(SeedError);
	});

	it("assertValid surfaces validation failures (oneOf overlap)", () => {
		// Any generated integer satisfies BOTH branches → invalid oneOf.
		expect(() =>
			generate(
				{ oneOf: [{ type: "integer", minimum: 0 }, { type: "integer" }] },
				{ seed: 1, assertValid: true },
			),
		).toThrow(SeedError);
	});

	it("invalid regex source throws SeedError", () => {
		expect(() => generate({ type: "string", pattern: "([" } as JsonSchema, { seed: 1 })).toThrow(
			SeedError,
		);
		// "*" passes the unsafe-repetition screen but is not a valid
		// RegExp source — covers the new RegExp() catch in genString.
		expect(() => generate({ type: "string", pattern: "*" } as JsonSchema, { seed: 1 })).toThrow(
			SeedError,
		);
	});
});

describe("generate — unseeded calls", () => {
	it("works without rng or seed (nondeterministic)", () => {
		expect(typeof generate({ type: "string" })).toBe("string");
		expect(generateMany({ type: "integer" }, 2).length).toBe(2);
		expect(typeof generateRecord({ type: "object", properties: { a: {} } }).a).not.toBe(
			"undefined",
		);
	});
});

describe("generateMany / generateRecord", () => {
	it("generateMany returns count values", () => {
		const out = generateMany({ type: "integer" }, 7, { seed: 9 });
		expect(out).toHaveLength(7);
	});

	it("generateMany rejects bad counts", () => {
		expect(() => generateMany({}, -1)).toThrow(SeedError);
		expect(() => generateMany({}, 1.5)).toThrow(SeedError);
	});

	it("generateMany caps count at MAX_GENERATE_MANY", () => {
		expect(generateMany({ type: "integer" }, MAX_GENERATE_MANY).length).toBe(MAX_GENERATE_MANY);
		expect(() => generateMany({ type: "integer" }, MAX_GENERATE_MANY + 1)).toThrow(SeedError);
	});

	it("generateRecord throws for non-object schemas", () => {
		expect(() => generateRecord({ type: "string" }, { seed: 1 })).toThrow(SeedError);
		expect(() => generateRecord({ type: "array", items: {} }, { seed: 1 })).toThrow(SeedError);
	});
});
