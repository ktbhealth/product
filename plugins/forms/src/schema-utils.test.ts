import { describe, expect, it } from "vitest";

import {
	decodeOption,
	defaultFor,
	displayString,
	encodeOption,
	getIn,
	inferWidget,
	initialValueFromSchema,
	isArrayLike,
	isComplexSchema,
	isObjectLike,
	isSchemaObject,
	isSimpleItemSchema,
	issuesForPath,
	optionLabel,
	optionValues,
	pruneEmpty,
	sanitizeId,
	schemaTypes,
	setIn,
	unmatchedIssues,
} from "./schema-utils.ts";

describe("schemaTypes", () => {
	it("normalizes absent, scalar and array types", () => {
		expect(schemaTypes(true)).toEqual([]);
		expect(schemaTypes({})).toEqual([]);
		expect(schemaTypes({ type: "string" })).toEqual(["string"]);
		expect(schemaTypes({ type: ["string", "null"] })).toEqual(["string", "null"]);
	});
});

describe("isSchemaObject / isObjectLike / isArrayLike", () => {
	it("classifies schemas", () => {
		expect(isSchemaObject(true)).toBe(false);
		expect(isSchemaObject({})).toBe(true);
		expect(isObjectLike({ type: "object" })).toBe(true);
		expect(isObjectLike({ properties: { a: { type: "string" } } })).toBe(true);
		expect(isObjectLike({ type: "string" })).toBe(false);
		expect(isObjectLike(true)).toBe(false);
		expect(isArrayLike({ type: "array" })).toBe(true);
		expect(isArrayLike({ type: "string" })).toBe(false);
		expect(isArrayLike(true)).toBe(false);
	});
});

describe("isComplexSchema", () => {
	it("flags refs, combinators and nested containers", () => {
		expect(isComplexSchema(true)).toBe(true);
		expect(isComplexSchema({ $ref: "#/definitions/x" })).toBe(true);
		for (const key of ["allOf", "anyOf", "oneOf", "not"] as const) {
			expect(isComplexSchema({ [key]: [{}] })).toBe(true);
		}
		expect(isComplexSchema({ type: "object" })).toBe(true);
		expect(isComplexSchema({ type: "array" })).toBe(true);
		expect(isComplexSchema({ properties: {} })).toBe(true);
		expect(isComplexSchema({ type: "string" })).toBe(false);
		expect(isComplexSchema({})).toBe(false);
	});
});

describe("isSimpleItemSchema", () => {
	it("accepts scalar-ish items only", () => {
		expect(isSimpleItemSchema(undefined)).toBe(false);
		expect(isSimpleItemSchema(true)).toBe(false);
		expect(isSimpleItemSchema({ type: "object" })).toBe(false);
		expect(isSimpleItemSchema({ anyOf: [{ type: "string" }] })).toBe(false);
		expect(isSimpleItemSchema({ type: "string" })).toBe(true);
		expect(isSimpleItemSchema({ enum: [1, 2] })).toBe(true);
		expect(isSimpleItemSchema({})).toBe(true);
	});
});

describe("inferWidget", () => {
	it("honors forced ui.widget first", () => {
		expect(inferWidget({ type: "string" }, { widget: "textarea" })).toBe("textarea");
	});
	it("infers select from enum and const", () => {
		expect(inferWidget({ enum: ["a"] })).toBe("select");
		expect(inferWidget({ const: 3 })).toBe("select");
	});
	it("infers scalar widgets", () => {
		expect(inferWidget({ type: "boolean" })).toBe("checkbox");
		expect(inferWidget({ type: "number" })).toBe("number");
		expect(inferWidget({ type: "integer" })).toBe("number");
		expect(inferWidget({ type: "string" })).toBe("input");
	});
	it("infers list vs json for arrays", () => {
		expect(inferWidget({ type: "array", items: { type: "string" } })).toBe("list");
		expect(inferWidget({ type: "array", items: { type: "object" } })).toBe("json");
		expect(inferWidget({ type: "array" })).toBe("json");
	});
	it("infers object and fallbacks", () => {
		expect(inferWidget({ type: "object", properties: {} })).toBe("object");
		expect(inferWidget({ properties: { a: true } })).toBe("object");
		expect(inferWidget({ anyOf: [{ type: "string" }] })).toBe("json");
		expect(inferWidget({})).toBe("json");
		expect(inferWidget(true)).toBe("json");
	});
});

describe("option codec + labels", () => {
	it("round-trips option values", () => {
		expect(encodeOption("a")).toBe('"a"');
		expect(encodeOption(4)).toBe("4");
		expect(encodeOption(undefined)).toBe("null");
		expect(decodeOption('"a"')).toBe("a");
		expect(decodeOption("[1]")).toEqual([1]);
	});
	it("prefers ui labels then scalar stringification", () => {
		const ui = { options: [{ value: 1, label: "One" }] };
		expect(optionLabel(1, ui)).toBe("One");
		expect(optionLabel("x")).toBe("x");
		expect(optionLabel(null)).toBe("null");
		expect(optionLabel(2.5)).toBe("2.5");
		expect(optionLabel(true)).toBe("true");
		expect(optionLabel({ a: 1 })).toBe('{"a":1}');
		expect(optionLabel(undefined)).toBe("");
	});
	it("lists option values ui > enum > const", () => {
		expect(optionValues({ type: "string" }, { options: [{ value: "z", label: "Z" }] })).toEqual([
			"z",
		]);
		expect(optionValues({ enum: ["a", "b"] })).toEqual(["a", "b"]);
		expect(optionValues({ const: "only" })).toEqual(["only"]);
		expect(optionValues({ type: "string" })).toBeNull();
		expect(optionValues(true)).toBeNull();
	});
});

describe("displayString", () => {
	it("stringifies control values", () => {
		expect(displayString(null)).toBe("");
		expect(displayString(undefined)).toBe("");
		expect(displayString("s")).toBe("s");
		expect(displayString(3)).toBe("3");
		expect(displayString(false)).toBe("false");
		expect(displayString({ a: 1 })).toBe('{"a":1}');
	});
});

describe("sanitizeId", () => {
	it("flattens paths into id-safe fragments", () => {
		expect(sanitizeId("address.street[0]")).toBe("address-street-0");
		expect(sanitizeId("--x--")).toBe("x");
	});
});

describe("defaultFor / initialValueFromSchema", () => {
	it("honors default at every level and assembles objects", () => {
		expect(defaultFor(true)).toBeUndefined();
		expect(defaultFor({ type: "string", default: "hi" })).toBe("hi");
		expect(defaultFor({ type: "string" })).toBeUndefined();
		expect(
			defaultFor({
				type: "object",
				properties: {
					a: { type: "string", default: "A" },
					b: { type: "number" },
					c: { type: "object", properties: { d: { type: "number", default: 1 } } },
				},
			}),
		).toEqual({ a: "A", c: { d: 1 } });
		expect(defaultFor({ type: "object" })).toBeUndefined();
		expect(defaultFor({ type: "array", items: { type: "string" } })).toBeUndefined();
	});
	it("returns {} when no defaults exist", () => {
		expect(
			initialValueFromSchema({ type: "object", properties: { a: { type: "string" } } }),
		).toEqual({});
		expect(
			initialValueFromSchema({
				type: "object",
				properties: { a: { type: "string", default: "x" } },
			}),
		).toEqual({ a: "x" });
	});
});

describe("pruneEmpty", () => {
	const schema = {
		type: "object",
		required: ["req"],
		properties: {
			req: { type: "string" },
			opt: { type: "string" },
			addr: {
				type: "object",
				properties: { zip: { type: "string" } },
			},
		},
	} as const;

	it("passes through non-schema values", () => {
		expect(pruneEmpty(true, { a: "" })).toEqual({ a: "" });
	});
	it("drops undefined and optional empty strings, keeps required", () => {
		expect(pruneEmpty(schema, { req: "", opt: "", addr: { zip: "" }, extra: 1 })).toEqual({
			req: "",
			addr: {},
			extra: 1,
		});
		expect(pruneEmpty(schema, { opt: "x", addr: undefined })).toEqual({ opt: "x" });
	});
	it("keeps unknown keys and recurses into declared ones", () => {
		expect(pruneEmpty(schema, { addr: { zip: "", stray: "" } })).toEqual({
			addr: { stray: "" },
		});
	});
	it("prunes inside arrays but keeps elements", () => {
		const arr = {
			type: "array",
			items: {
				type: "object",
				properties: { a: { type: "string" }, b: { type: "string" } },
			},
		} as const;
		expect(pruneEmpty(arr, [{ a: "", b: "x" }])).toEqual([{ b: "x" }]);
		// no items schema → passthrough
		expect(pruneEmpty({ type: "array" }, [""])).toEqual([""]);
		// non-array value → passthrough
		expect(pruneEmpty(arr, "nope")).toBe("nope");
	});
});

describe("issue path helpers", () => {
	const issues = [
		{ path: "name", keyword: "required", message: "required" },
		{ path: "addr.zip", keyword: "pattern", message: "bad" },
		{ path: "tags[0]", keyword: "type", message: "wrong" },
		{ path: "$", keyword: "type", message: "root" },
	] as const;

	it("issuesForPath matches exact, dotted and bracketed descendants", () => {
		expect(issuesForPath(issues, "name")).toHaveLength(1);
		expect(issuesForPath(issues, "addr")).toHaveLength(1);
		expect(issuesForPath(issues, "addr.zip")).toHaveLength(1);
		expect(issuesForPath(issues, "tags")).toHaveLength(1);
		expect(issuesForPath(issues, "tags[0]")).toHaveLength(1);
		expect(issuesForPath(issues, "other")).toHaveLength(0);
	});
	it("unmatchedIssues returns what no field claims", () => {
		expect(unmatchedIssues(issues, ["name", "addr", "tags"])).toEqual([
			{ path: "$", keyword: "type", message: "root" },
		]);
		expect(unmatchedIssues(issues, [])).toHaveLength(4);
	});
});

describe("setIn / getIn", () => {
	it("sets nested values immutably", () => {
		const base = { a: { b: 1 }, list: [1, 2] };
		expect(setIn(base, ["a", "b"], 9)).toEqual({ a: { b: 9 }, list: [1, 2] });
		expect(setIn(base, ["list", 0], 7)).toEqual({ a: { b: 1 }, list: [7, 2] });
		const sparse = setIn(base, ["list", 5], 7) as { list: unknown[] };
		expect(sparse.list[5]).toBe(7);
		expect(sparse.list).toHaveLength(6);
		expect(setIn("x", [], "y")).toBe("y");
		expect(setIn(undefined, ["k"], 1)).toEqual({ k: 1 });
		expect(setIn(undefined, [0], 1)).toEqual([1]);
		// original untouched
		expect(base).toEqual({ a: { b: 1 }, list: [1, 2] });
	});
	it("reads nested values", () => {
		const base = { a: { b: 1 }, list: [10, 20] };
		expect(getIn(base, ["a", "b"])).toBe(1);
		expect(getIn(base, ["list", 1])).toBe(20);
		expect(getIn(base, ["a", "missing"])).toBeUndefined();
		expect(getIn(base, ["a", 0])).toBeUndefined();
		expect(getIn(base, [0, "a"])).toBeUndefined();
		expect(getIn(base, ["list", "x"])).toBeUndefined();
		expect(getIn(base, [])).toBe(base);
	});
});
