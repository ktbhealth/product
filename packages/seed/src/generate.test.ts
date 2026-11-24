import { describe, expect, it } from "vitest";

import { validate, type JsonSchema } from "@ktb/json-schema";

import {
	generate,
	generateMany,
	generateRecord,
	MAX_GENERATE_MANY,
	poolsFor,
	SeedError,
} from "./index.ts";

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

describe("generate — string heuristic formats", () => {
	// One key per disjunct of the field-name heuristics in stringForKey
	// (district → id). Format assertions — not just typeof — pin each
	// branch so condition/operator mutants change observable output.
	const keys = [
		"district",
		"bairro",
		"neighborhood",
		"suburb",
		"addressNumber",
		"num",
		"numero",
		"addressLine",
		"endereco",
		"logradouro",
		"street",
		"avenue",
		"complement",
		"complemento",
		"country",
		"pais",
		"nationality",
		"gender",
		"sexo",
		"sex",
		"preferredLanguage",
		"idioma",
		"locale",
		"currency",
		"id",
		"uuid",
		"guid",
		"uid",
		"record_id",
		"requestUuid",
		"assetGuid",
		"note",
	];
	const schema: JsonSchema = {
		type: "object",
		properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
	};
	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
	const THOROUGHFARES = ["Rua", "Avenida", "Travessa", "Alameda"];

	it("each heuristic branch emits its expected format", () => {
		for (const locale of ["pt-BR", "en"] as const) {
			const pools = poolsFor(locale);
			const compRe = locale === "pt-BR" ? /^Apto \d+$/ : /^Apt \d+$/;
			const genders = locale === "pt-BR" ? ["F", "M"] : ["female", "male", "other"];
			for (let i = 0; i < 8; i++) {
				const rec = generateRecord(schema, {
					seed: `hf-${locale}-${i}`,
					locale,
				}) as Record<string, string>;
				for (const k of ["district", "bairro", "neighborhood", "suburb"]) {
					expect(pools.neighborhoods).toContain(rec[k]);
				}
				for (const k of ["addressNumber", "num", "numero"]) {
					expect(rec[k]).toMatch(/^\d{1,5}$/);
				}
				for (const k of ["addressLine", "endereco", "logradouro", "street", "avenue"]) {
					const [prefix, ...rest] = rec[k].split(" ");
					expect(THOROUGHFARES).toContain(prefix);
					expect(pools.streets).toContain(rest.join(" "));
				}
				for (const k of ["complement", "complemento"]) {
					expect(rec[k]).toMatch(compRe);
				}
				for (const k of ["country", "pais", "nationality"]) {
					expect(rec[k]).toBe(pools.countryCode);
				}
				for (const k of ["gender", "sexo", "sex"]) {
					expect(genders).toContain(rec[k]);
				}
				for (const k of ["preferredLanguage", "idioma", "locale"]) {
					expect(rec[k]).toBe(pools.localeTag);
				}
				expect(rec.currency).toBe(pools.countryCode === "BR" ? "BRL" : "USD");
				for (const k of ["id", "uuid", "guid", "uid", "record_id", "requestUuid", "assetGuid"]) {
					expect(rec[k]).toMatch(UUID_RE);
				}
				// Fallback: pool words only — no heuristic format leaks in.
				for (const w of rec.note.split(" ")) {
					expect(pools.words).toContain(w);
				}
			}
		}
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

	it("does not report inverted bounds when only one side of a pair is set", () => {
		const onlyLower = valid({
			allOf: [{ type: "integer", minimum: 0 }, { type: "integer" }],
		});
		expect(onlyLower).toEqual(expect.any(Number));
		const onlyUpper = valid({
			allOf: [{ type: "integer" }, { type: "integer", maximum: 5 }],
		});
		expect(onlyUpper).toEqual(expect.any(Number));
		const onlyMinLength = valid({
			allOf: [{ type: "string", minLength: 2 }, { type: "string" }],
		}) as string;
		expect(onlyMinLength.length).toBeGreaterThanOrEqual(2);
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
		for (let i = 0; i < 20; i++) {
			const v = valid(
				{
					allOf: [
						{ type: "object", additionalProperties: { type: "integer", minimum: 0 } },
						{
							type: "object",
							additionalProperties: { type: "integer", maximum: 9 },
							minProperties: 1,
						},
					],
				},
				`apm${i}`,
			) as Record<string, unknown>;
			for (const val of Object.values(v)) {
				expect(Number.isInteger(val)).toBe(true);
				expect(val as number).toBeGreaterThanOrEqual(0);
				expect(val as number).toBeLessThanOrEqual(9);
			}
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

describe("generate — const/enum cloning", () => {
	it("returns copies so callers cannot mutate schema state", () => {
		const c = { a: [1] };
		const v1 = generate({ const: c }, { seed: 1 });
		expect(v1).toEqual(c);
		expect(v1).not.toBe(c);

		const e = { enum: [{ x: 1 }] };
		const v2 = generate(e, { seed: 1 });
		expect(v2).toEqual({ x: 1 });
		expect(v2).not.toBe((e.enum as unknown[])[0]);
	});
});

describe("generate — invalid root schemas", () => {
	it("rejects non-schema roots from the schema walk, not the $ref probe", () => {
		// null/undefined aren't JsonSchema — the TypeError must come from
		// generateValue's Object.hasOwn, not from deref probing .$ref.
		for (const bad of [null, undefined]) {
			let err: unknown;
			try {
				generate(bad as unknown as JsonSchema);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(TypeError);
			expect((err as Error).message).not.toContain("$ref");
		}
	});
});

describe("generate — $ref pointer edge cases", () => {
	it("resolves refs with RFC 6901 escapes in both directions", () => {
		const schema = {
			type: "object",
			properties: {
				"a/b": { type: "string", minLength: 3 },
				"t~u": { type: "string", pattern: "^z+$" },
				p: { $ref: "#/properties/a~1b" },
				q: { $ref: "#/properties/t~0u" },
			},
			required: ["p", "q"],
		} as JsonSchema;
		for (let i = 0; i < 10; i++) {
			const v = generate(schema, {
				seed: `esc${i}`,
				assertValid: true,
			}) as Record<string, string>;
			expect(v.p.length).toBeGreaterThanOrEqual(3);
			expect(v.q).toMatch(/^z+$/);
		}
	});

	it("escapes ~ and / inside error paths", () => {
		const cases: ReadonlyArray<readonly [Record<string, JsonSchema>, string]> = [
			[{ "a/b": { type: "string", minLength: 100000 } }, "$/a~1b"],
			[{ "c~d": { type: "string", minLength: 100000 } }, "$/c~0d"],
		];
		for (const [props, expectedPath] of cases) {
			let err: unknown;
			try {
				generate({ type: "object", properties: props } as JsonSchema, { seed: 1 });
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(SeedError);
			expect((err as SeedError).path).toBe(expectedPath);
		}
	});

	it("treats '#' as the document root and reports recursion depth", () => {
		// "#" resolves to the root schema — which contains the ref itself —
		// so generation recurses until the depth guard fires. The failure
		// must be the depth/budget error, NOT "unresolvable $ref".
		expect(() =>
			generate(
				{
					type: "object",
					properties: { p: { $ref: "#" } },
					required: ["p"],
				} as JsonSchema,
				{ seed: 1 },
			),
		).toThrow(/depth|budget/);
	});

	it("resolves array indices, including leading zeros and multi-digit", () => {
		const refSchema = (ref: string) =>
			({
				type: "object",
				properties: {
					holder: { allOf: [{ const: "zero" }, { const: "one" }] },
					q: { $ref: ref },
				},
				required: ["q"],
			}) as unknown as JsonSchema;
		const opts = { seed: 1, requiredOnly: true } as const;
		expect(
			(generate(refSchema("#/properties/holder/allOf/01"), opts) as Record<string, unknown>).q,
		).toBe("one");
		expect(
			(generate(refSchema("#/properties/holder/allOf/1"), opts) as Record<string, unknown>).q,
		).toBe("one");

		const branches = Array.from({ length: 11 }, (_, i) => ({ const: i }));
		const wide = {
			type: "object",
			properties: {
				holder: { allOf: branches },
				q: { $ref: "#/properties/holder/allOf/10" },
			},
			required: ["q"],
		} as unknown as JsonSchema;
		expect((generate(wide, opts) as Record<string, unknown>).q).toBe(10);
	});

	it("rejects non-canonical array indices", () => {
		const refSchema = (ref: string) =>
			({
				type: "object",
				properties: {
					holder: { allOf: [{ const: "zero" }, { const: "one" }] },
					q: { $ref: ref },
				},
				required: ["q"],
			}) as unknown as JsonSchema;
		for (const ref of [
			"#/properties/holder/allOf/ 1",
			"#/properties/holder/allOf/1 ",
			"#/properties/holder/allOf/x",
			"#/properties/holder/allOf/-1",
		]) {
			expect(() => generate(refSchema(ref), { seed: 1, requiredOnly: true })).toThrow(SeedError);
		}
	});

	it("rejects refs that traverse through non-object values", () => {
		// null mid-path → unresolvable (SeedError, not a TypeError).
		// requiredOnly keeps the null/boolean decoy properties ungenerate.
		expect(() =>
			generate(
				{
					type: "object",
					properties: { n: null, p: { $ref: "#/properties/n/x" } },
					required: ["p"],
				} as unknown as JsonSchema,
				{ seed: 1, requiredOnly: true },
			),
		).toThrow(SeedError);
		// boolean leaf + extra segment → must not resolve to `true`.
		expect(() =>
			generate(
				{
					type: "object",
					properties: { b: true, p: { $ref: "#/properties/b/x" } },
					required: ["p"],
				} as JsonSchema,
				{ seed: 1, requiredOnly: true },
			),
		).toThrow(SeedError);
		// "__proto__" must not resolve through the prototype chain.
		expect(() =>
			generate(
				{
					type: "object",
					properties: { p: { $ref: "#/__proto__" } },
					required: ["p"],
				} as JsonSchema,
				{ seed: 1 },
			),
		).toThrow(SeedError);
	});
});

describe("generate — merge edge cases", () => {
	it("rejects genuinely different const values", () => {
		const cases: ReadonlyArray<readonly [string, JsonSchema]> = [
			["number vs string", { allOf: [{ const: 1 }, { const: "a" }] }],
			["object vs number", { allOf: [{ const: {} }, { const: 5 }] }],
			["number vs object", { allOf: [{ const: 5 }, { const: {} }] }],
			["null vs object", { allOf: [{ const: null }, { const: {} }] }],
			["object vs null", { allOf: [{ const: {} }, { const: null }] }],
			["array vs object", { allOf: [{ const: [1] }, { const: { 0: 1 } }] }],
			["object value diff", { allOf: [{ const: { a: 1 } }, { const: { a: 2 } }] }],
			["object missing key", { allOf: [{ const: { a: 1, b: 2 } }, { const: { a: 1, c: 3 } }] }],
			["object extra key", { allOf: [{ const: { a: 1 } }, { const: { a: 1, b: 2 } }] }],
			["array order diff", { allOf: [{ const: [1, 2] }, { const: [2, 1] }] }],
			["array prefix", { allOf: [{ const: [1, 2] }, { const: [1, 2, 3] }] }],
			["array partial overlap", { allOf: [{ const: [1, 2] }, { const: [1, 3] }] }],
		];
		for (const [, schema] of cases) {
			expect(() => generate(schema, { seed: 1 })).toThrow(SeedError);
		}
	});

	it("surfaces merge error messages", () => {
		expect(() =>
			generate({ allOf: [{ type: "string" }, { type: "integer" }] } as JsonSchema, { seed: 1 }),
		).toThrow("disjoint types");
		expect(() =>
			generate({ allOf: [{ const: "a" }, { const: "b" }] } as JsonSchema, { seed: 1 }),
		).toThrow("conflicting const values");
		expect(() =>
			generate({ allOf: [{ enum: ["a"] }, { enum: ["b"] }] } as JsonSchema, { seed: 1 }),
		).toThrow("empty enum intersection");
		expect(() =>
			generate(
				{
					allOf: [
						{ type: "string", pattern: "^a$" },
						{ type: "string", pattern: "^b$" },
					],
				} as JsonSchema,
				{ seed: 1 },
			),
		).toThrow("conflicting patterns");
		expect(() =>
			generate(
				{
					allOf: [
						{ type: "string", minLength: 10 },
						{ type: "string", maxLength: 5 },
					],
				} as JsonSchema,
				{ seed: 1 },
			),
		).toThrow("inverted bounds");
	});

	it("keeps the stricter bound when merging allOf", () => {
		// rng pinned low/high so violations are deterministic, not seed-luck.
		const lo = generate(
			{ allOf: [{ type: "number" }, { type: "number", minimum: 10 }] } as JsonSchema,
			{ rng: () => 0.05 },
		) as number;
		expect(lo).toBeGreaterThanOrEqual(10);
		const hi = generate(
			{
				allOf: [
					{ type: "number", maximum: 50 },
					{ type: "number", maximum: 5 },
				],
			} as JsonSchema,
			{ rng: () => 0.95 },
		) as number;
		expect(hi).toBeLessThanOrEqual(5);
		const both = generate(
			{
				allOf: [
					{ type: "number", minimum: 0, maximum: 100 },
					{ type: "number", minimum: 10, maximum: 50 },
				],
			} as JsonSchema,
			{ seed: 1, assertValid: true },
		) as number;
		expect(both).toBeGreaterThanOrEqual(10);
		expect(both).toBeLessThanOrEqual(50);
	});

	it("rejects inverted merged bounds even on types that ignore them", () => {
		for (const [lo, hi] of [
			["minimum", "maximum"],
			["minLength", "maxLength"],
			["minItems", "maxItems"],
			["minProperties", "maxProperties"],
		] as const) {
			expect(() =>
				generate(
					{
						allOf: [
							{ type: "boolean", [lo]: 10 },
							{ type: "boolean", [hi]: 5 },
						],
					} as JsonSchema,
					{ seed: 1 },
				),
			).toThrow(SeedError);
		}
	});

	it("allows equal merged bounds", () => {
		expect(
			generate(
				{
					allOf: [
						{ type: "integer", minimum: 5 },
						{ type: "integer", maximum: 5 },
					],
				} as JsonSchema,
				{
					seed: 1,
				},
			),
		).toBe(5);
	});

	it("preserves multi-type intersections", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 40; i++) {
			const v = generate(
				{ allOf: [{ type: ["string", "null"] }, { type: ["null", "string"] }] } as JsonSchema,
				{ seed: `mt${i}` },
			);
			seen.add(v === null ? "null" : typeof v);
		}
		expect(seen).toContain("null");
		expect(seen).toContain("string");
	});

	it("keeps a-side type when the other branch has none", () => {
		for (let i = 0; i < 10; i++) {
			expect(
				generate({ allOf: [{ type: "null" }, { description: "d" }] } as JsonSchema, {
					seed: `ty${i}`,
				}),
			).toBeNull();
		}
	});

	it("keeps enum when only one branch declares it", () => {
		for (const allOf of [
			[{ type: "string", minLength: 1 }, { enum: ["a", "bb"] }],
			[{ enum: ["a", "bb"] }, { type: "string", minLength: 1 }],
		] as const) {
			for (let i = 0; i < 10; i++) {
				const v = generate({ allOf } as JsonSchema, {
					seed: `en${i}`,
					assertValid: true,
				});
				expect(["a", "bb"]).toContain(v);
			}
		}
	});

	it("merges overlapping property schemas instead of overwriting", () => {
		const schema = {
			allOf: [
				{
					type: "object",
					properties: { x: { type: "integer", minimum: 5 } },
					required: ["x"],
				},
				{ type: "object", properties: { x: { type: "integer", maximum: 9 } } },
			],
		} as JsonSchema;
		for (let i = 0; i < 10; i++) {
			const v = generate(schema, {
				seed: `pm${i}`,
				requiredOnly: true,
				assertValid: true,
			}) as Record<string, number>;
			expect(v.x).toBeGreaterThanOrEqual(5);
			expect(v.x).toBeLessThanOrEqual(9);
		}
	});

	it("unions required arrays when merging", () => {
		const schema = {
			allOf: [
				{ type: "object", properties: { x: { type: "string" } }, required: ["x"] },
				{ type: "object", properties: { y: { type: "string" } }, required: ["y"] },
			],
		} as JsonSchema;
		for (let i = 0; i < 10; i++) {
			const v = generateRecord(schema, {
				seed: `rq${i}`,
				requiredOnly: true,
				assertValid: true,
			});
			expect(Object.keys(v).sort()).toEqual(["x", "y"]);
		}
	});
});

describe("generate — merge internals", () => {
	const SEEDS = Array.from({ length: 30 }, (_, i) => `edge${i}`);

	it("merges additionalProperties schemas from both sides", () => {
		const schema = {
			allOf: [
				{
					type: "object",
					additionalProperties: { type: "integer", minimum: 5, maximum: 10 },
					minProperties: 2,
				},
				{
					type: "object",
					additionalProperties: { type: "integer", minimum: 0, maximum: 8 },
				},
			],
		} as JsonSchema;
		for (const seed of SEEDS) {
			const rec = generateRecord(schema, { seed, assertValid: true });
			expect(Object.keys(rec).length).toBeGreaterThanOrEqual(2);
			for (const v of Object.values(rec)) {
				expect(Number.isInteger(v)).toBe(true);
				expect(v as number).toBeGreaterThanOrEqual(5);
				expect(v as number).toBeLessThanOrEqual(8);
			}
		}
	});

	it("defers a $ref additionalProperties to generation when b-side is true", () => {
		// a.additionalProperties is {$ref → false}; b.additionalProperties
		// is `true`, so the merge must keep the $ref verbatim (deref would
		// collapse it to `false` early and change the error).
		const schema = {
			type: "object",
			minProperties: 2,
			allOf: [
				{
					type: "object",
					properties: { z: { type: "array", items: false, maxItems: 0 } },
					additionalProperties: { $ref: "#/allOf/0/properties/z/items" },
				},
				{ type: "object", additionalProperties: true },
			],
		} as JsonSchema;
		expect(() => generate(schema, { seed: 1 })).toThrow(/accepts nothing/);
	});

	it("merges items bounds from both allOf branches", () => {
		const schema = {
			allOf: [
				{
					type: "array",
					items: { type: "integer", minimum: 5, maximum: 20 },
					minItems: 3,
					maxItems: 3,
				},
				{ type: "array", items: { type: "integer", minimum: 0, maximum: 10 } },
			],
		} as JsonSchema;
		for (const seed of SEEDS) {
			const arr = generate(schema, { seed, assertValid: true }) as number[];
			expect(arr).toHaveLength(3);
			for (const n of arr) {
				expect(Number.isInteger(n)).toBe(true);
				expect(n).toBeGreaterThanOrEqual(5);
				expect(n).toBeLessThanOrEqual(10);
			}
		}
	});

	it("keeps items when only one allOf branch declares it", () => {
		const schema = {
			allOf: [
				{
					type: "array",
					items: { type: "integer", minimum: 5, maximum: 10 },
					minItems: 2,
					maxItems: 2,
				},
				{ type: "array" },
			],
		} as JsonSchema;
		for (const seed of SEEDS) {
			const arr = generate(schema, { seed, assertValid: true }) as number[];
			expect(arr).toHaveLength(2);
			for (const n of arr) {
				expect(Number.isInteger(n)).toBe(true);
				expect(n).toBeGreaterThanOrEqual(5);
				expect(n).toBeLessThanOrEqual(10);
			}
		}
	});

	it("allows a combinator cross product of exactly 64 pairs", () => {
		const opts = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ type: "integer", minimum: i, maximum: i }));
		// 8 × 8 = 64 — at the cap, not over it. Only i == j pairs merge
		// without inverting bounds, leaving 8 satisfiable combos.
		const v = generate({ allOf: [{ anyOf: opts(8) }, { anyOf: opts(8) }] } as JsonSchema, {
			seed: 1,
			assertValid: true,
		});
		expect(Number.isInteger(v)).toBe(true);
		expect(v as number).toBeGreaterThanOrEqual(0);
		expect(v as number).toBeLessThanOrEqual(7);
	});

	it("reports details in combinator merge errors", () => {
		const big = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ type: "integer", minimum: i, maximum: i }));
		expect(() =>
			generate({ allOf: [{ anyOf: big(9) }, { anyOf: big(8) }] } as JsonSchema, { seed: 1 }),
		).toThrow(/combinator product too large/);
		expect(() =>
			generate(
				{
					allOf: [{ anyOf: [{ type: "string" }] }, { anyOf: [{ type: "integer" }] }],
				} as JsonSchema,
				{ seed: 1 },
			),
		).toThrow(/no satisfiable anyOf combination/);
	});

	it("merges a combinator declared on only one allOf branch", () => {
		const combos = [
			{ anyOf: [{ const: "x" }, { const: "y" }] },
			{ oneOf: [{ const: "x" }, { const: "y" }] },
		];
		for (const combo of combos) {
			for (const schema of [
				{ allOf: [combo, { type: "string" }] },
				{ allOf: [{ type: "string" }, combo] },
			] as JsonSchema[]) {
				for (const seed of SEEDS) {
					const v = generate(schema, { seed, assertValid: true });
					expect(["x", "y"]).toContain(v);
				}
			}
		}
	});

	it("throws when not survives on only the second allOf branch", () => {
		expect(() =>
			generate({ allOf: [{ type: "string" }, { not: { const: 1 } }] }, { seed: 1 }),
		).toThrow(SeedError);
		expect(() =>
			generate(
				{ allOf: [{ not: { const: 1 } }, { type: "string" }, { type: "string" }] },
				{ seed: 1 },
			),
		).toThrow(SeedError);
	});

	it("stays unsatisfiable when a false branch precedes later branches", () => {
		expect(() =>
			generate({ allOf: [{ type: "string" }, false, { type: "integer" }] } as JsonSchema, {
				seed: 1,
			}),
		).toThrow(SeedError);
		expect(() =>
			generate({ allOf: [false, { type: "string" }] } as JsonSchema, { seed: 1 }),
		).toThrow(SeedError);
	});

	it("throws SeedError for $ref targets that are not schemas", () => {
		const refTo = (marker: string, target: unknown): JsonSchema =>
			({
				[marker]: target,
				type: "object",
				properties: { p: { $ref: `#/${marker}` } },
				required: ["p"],
			}) as JsonSchema;
		for (const target of [null, 42, "text"]) {
			expect(() => generate(refTo("marker", target), { seed: 1 })).toThrow(SeedError);
		}
		expect(() => generate(refTo("marker", undefined), { seed: 1 })).toThrow(/unresolvable \$ref/);
	});

	it("reports recursive $ref errors by name", () => {
		expect(() =>
			generate(
				{
					type: "object",
					properties: {
						a: { $ref: "#/properties/b" },
						b: { $ref: "#/properties/a" },
					},
				} as JsonSchema,
				{ seed: 1 },
			),
		).toThrow(/recursive \$ref/);
	});
});

describe("generate — heuristic output shapes", () => {
	const SEEDS = Array.from({ length: 30 }, (_, i) => `shape${i}`);
	const YEAR_MIN = 1950;
	const YEAR_MAX = new Date().getUTCFullYear();
	// Oracle for the generator's slug() — pool names mapped through the
	// same normalization, so heuristic outputs can be checked for
	// membership instead of just shape.
	const slugOracle = (s: string): string =>
		s
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "");
	const ptPools = poolsFor("pt-BR");
	const sluggedFirsts = new Set(ptPools.firstNames.map(slugOracle));
	const sluggedLasts = new Set(ptPools.lastNames.map(slugOracle));

	it("generates dates within [1950, now] with variety", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				birthDate: { type: "string" },
				createdAt: { type: "string" },
			},
		};
		const dates = new Set<string>();
		const dateTimes = new Set<string>();
		const maxYear = { birthDate: 0, createdAt: 0 };
		for (const seed of SEEDS) {
			const rec = generateRecord(schema, { seed, locale: "pt-BR", assertValid: true }) as Record<
				string,
				string
			>;
			expect(rec.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(rec.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			for (const [set, key] of [
				[dates, "birthDate"],
				[dateTimes, "createdAt"],
			] as const) {
				const v = rec[key];
				const year = Number(v.slice(0, 4));
				expect(year).toBeGreaterThanOrEqual(YEAR_MIN);
				expect(year).toBeLessThanOrEqual(YEAR_MAX);
				maxYear[key] = Math.max(maxYear[key], year);
				set.add(v);
			}
		}
		// Each generator's span reaches ~2046; a mutant compressing the
		// range (e.g. `Date.now() + EPOCH_1950` → ~1950–1986) can't pass.
		// Asserted per field: mutating only one of isoDate/isoDateTime
		// must still fail.
		expect(maxYear.birthDate).toBeGreaterThan(2000);
		expect(maxYear.createdAt).toBeGreaterThan(2000);
		expect(dates.size).toBeGreaterThan(10);
		expect(dateTimes.size).toBeGreaterThan(10);
	});

	it("generates varied valid cpf, cnpj and uuid values", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: { cpf: {}, cnpj: {}, uuid: {} },
		};
		const cpfs = new Set<string>();
		const cnpjs = new Set<string>();
		const uuids = new Set<string>();
		for (const seed of SEEDS) {
			const rec = generateRecord(schema, { seed, locale: "pt-BR", assertValid: true }) as Record<
				string,
				string
			>;
			expect(rec.cpf).toMatch(/^\d{11}$/);
			expect(rec.cnpj).toMatch(/^\d{14}$/);
			expect(rec.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
			cpfs.add(rec.cpf);
			cnpjs.add(rec.cnpj);
			uuids.add(rec.uuid);
		}
		expect(cpfs.size).toBeGreaterThan(10);
		expect(cnpjs.size).toBeGreaterThan(5);
		expect(uuids.size).toBeGreaterThan(10);
	});

	it("generates lowercase email local parts with varied name components", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: { email: {}, mail: {}, emailAddress: {} },
		};
		const firsts = new Set<string>();
		const lasts = new Set<string>();
		for (const seed of SEEDS) {
			const rec = generateRecord(schema, { seed, locale: "pt-BR", assertValid: true }) as Record<
				string,
				string
			>;
			for (const key of ["email", "mail", "emailAddress"]) {
				expect(rec[key]).toMatch(/^[a-z]+\.[a-z]+\d+@[a-z0-9.]+$/);
				const [first, last] = rec[key]!.split("@")[0]!.replace(/\d+$/, "").split(".");
				expect(sluggedFirsts.has(first!)).toBe(true);
				expect(sluggedLasts.has(last!)).toBe(true);
				firsts.add(first!);
				lasts.add(last!);
			}
		}
		expect(firsts.size).toBeGreaterThan(3);
		expect(lasts.size).toBeGreaterThan(3);
	});

	it("generates BR-format phone numbers for phone-ish keys", () => {
		const keys = ["phone", "tel", "telefone", "celular", "whatsapp", "mobile", "fax"];
		const schema: JsonSchema = {
			type: "object",
			properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
		};
		for (const seed of SEEDS) {
			const rec = generateRecord(schema, { seed, locale: "pt-BR", assertValid: true }) as Record<
				string,
				string
			>;
			for (const k of keys) expect(rec[k]).toMatch(/^\(\d{2}\) 9\d{4}-\d{4}$/);
		}
	});

	it("generates locale-correct postal codes for postal-ish keys", () => {
		const keys = ["cep", "postalCode", "postcode", "zipcode", "zip"];
		const schema: JsonSchema = {
			type: "object",
			properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
		};
		for (const seed of SEEDS.slice(0, 10)) {
			const br = generateRecord(schema, { seed, locale: "pt-BR", assertValid: true }) as Record<
				string,
				string
			>;
			const us = generateRecord(schema, { seed, locale: "en", assertValid: true }) as Record<
				string,
				string
			>;
			for (const k of keys) {
				expect(br[k]).toMatch(/^\d{5}-\d{3}$/);
				expect(us[k]).toMatch(/^\d{5}$/);
			}
		}
	});

	it("generates username format for username-ish keys", () => {
		const keys = ["username", "user", "login", "handle", "userHandle"];
		const schema: JsonSchema = {
			type: "object",
			properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
		};
		for (const seed of SEEDS) {
			const rec = generateRecord(schema, { seed, locale: "pt-BR", assertValid: true }) as Record<
				string,
				string
			>;
			for (const k of keys) {
				expect(rec[k]).toMatch(/^[a-z]+\.[a-z]+\d+$/);
				const [first, last] = rec[k]!.replace(/\d+$/, "").split(".");
				expect(sluggedFirsts.has(first!)).toBe(true);
				expect(sluggedLasts.has(last!)).toBe(true);
			}
		}
	});

	it("does not leak field heuristics into unrelated keys", () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				note: { type: "string" },
				city: { type: "string" },
				format: { type: "string" },
			},
		};
		const words = new Set(poolsFor("pt-BR").words);
		const cities = new Set(poolsFor("pt-BR").cities);
		for (const seed of SEEDS) {
			const rec = generateRecord(schema, { seed, locale: "pt-BR", assertValid: true }) as Record<
				string,
				string
			>;
			expect(cities.has(rec.city)).toBe(true);
			expect(rec.note.split(" ").every((w) => words.has(w))).toBe(true);
			expect(rec.format).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});
});
