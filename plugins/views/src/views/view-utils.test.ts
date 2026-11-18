// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { ViewDef, ViewField } from "../definition.ts";
import {
	currentSearch,
	fieldLabel,
	filterLabel,
	filterSearchFromValues,
	filterValuesFromSearch,
	formatViewValue,
	getPath,
	replaceFilterSearch,
	resolveViewText,
	viewScalarText,
	withFilterSearch,
} from "./view-utils.ts";

const field = (over: Partial<ViewField> = {}): ViewField => ({ field: "a.b", ...over });

describe("getPath", () => {
	it("walks dotted paths and array indices", () => {
		const data = { a: { b: { c: 1 } }, list: [{ x: 2 }, { x: 3 }] };
		expect(getPath(data, "a.b.c")).toBe(1);
		expect(getPath(data, "list.1.x")).toBe(3);
		expect(getPath(data, "a.b.missing")).toBeUndefined();
		expect(getPath(data, "a.b.c.d")).toBeUndefined();
		expect(getPath(null, "a")).toBeUndefined();
		expect(getPath(undefined, "a")).toBeUndefined();
		expect(getPath({ a: 5 }, "a.b")).toBeUndefined();
		expect(getPath({ a: [1] }, "a.x")).toBeUndefined();
		expect(getPath({ a: [1] }, "a.-1")).toBeUndefined();
	});
});

describe("viewScalarText", () => {
	it("renders scalars, objects and the empty fallback", () => {
		expect(viewScalarText(undefined)).toBe("—");
		expect(viewScalarText(null)).toBe("—");
		expect(viewScalarText("s")).toBe("s");
		expect(viewScalarText(4)).toBe("4");
		expect(viewScalarText(true)).toBe("true");
		expect(viewScalarText({ a: 1 })).toBe('{"a":1}');
		const long = { v: "x".repeat(200) };
		expect(viewScalarText(long).endsWith("…")).toBe(true);
	});
});

describe("formatViewValue", () => {
	it("formats dates, booleans, refs, json and text", () => {
		const ms = new Date("2024-05-06T00:00:00Z").getTime();
		expect(formatViewValue(field({ format: "date" }), ms, { locale: "en-US" })).toContain("2024");
		expect(formatViewValue(field({ format: "date" }), "raw")).toBe("raw");
		expect(formatViewValue(field({ format: "boolean" }), true)).toBe("true");
		expect(formatViewValue(field({ format: "boolean" }), false)).toBe("false");
		expect(
			formatViewValue(field({ format: "ref", refCollection: "c.d" }), 4, {
				refs: { "c.d:4": "Label" },
			}),
		).toBe("Label");
		expect(formatViewValue(field({ format: "ref", refCollection: "c.d" }), 4)).toBe("#4");
		expect(formatViewValue(field({ format: "ref" }), "notnum")).toBe("notnum");
		expect(formatViewValue(field({ format: "ref" }), 7)).toBe("#7");
		expect(formatViewValue(field({ format: "ref", refCollection: "c.d" }), null)).toBe("—");
		expect(formatViewValue(field({ format: "json" }), { a: 1 })).toBe('{"a":1}');
		expect(formatViewValue(field({ format: "enum" }), "x")).toBe("x");
		expect(formatViewValue(field(), undefined)).toBe("—");
		expect(formatViewValue(field(), null)).toBe("—");
	});
});

describe("fieldLabel / filterLabel", () => {
	it("prefers explicit labels and falls back to the last path segment", () => {
		expect(fieldLabel(field({ label: "L" }))).toBe("L");
		expect(fieldLabel(field({ field: "a.b.c" }))).toBe("c");
		expect(fieldLabel(field({ field: "solo" }))).toBe("solo");
		expect(filterLabel({ field: "x.y", op: "$eq", label: "F" })).toBe("F");
		expect(filterLabel({ field: "x.y", op: "$eq" })).toBe("y");
	});
});

const DEF: ViewDef = {
	id: "v",
	title: "V",
	collection: "c.d",
	kind: "table",
	fields: [{ field: "a" }],
	filters: [
		{ field: "fixed", op: "$eq", value: 1 },
		{ field: "q.field", op: "$regex" },
		{ field: "p", op: "$gt", param: "min" },
	],
};

describe("filter search params", () => {
	it("reads only declared interactive params from a search string", () => {
		expect(filterValuesFromSearch(DEF, "?q.field=an&min=3&other=z")).toEqual({
			"q.field": "an",
			min: "3",
		});
		expect(filterValuesFromSearch(DEF, "noequals")).toEqual({});
		expect(filterValuesFromSearch(DEF, "?")).toEqual({});
		expect(filterValuesFromSearch({}, "?a=1")).toEqual({});
	});

	it("serializes non-empty values in declaration order", () => {
		expect(filterSearchFromValues(DEF, { "q.field": "an", min: "", other: "x" })).toBe(
			"q.field=an",
		);
		expect(filterSearchFromValues(DEF, {})).toBe("");
		expect(filterSearchFromValues({}, { a: "1" })).toBe("");
	});

	it("withFilterSearch strips or appends the query", () => {
		expect(withFilterSearch("/v/x", "a=1")).toBe("/v/x?a=1");
		expect(withFilterSearch("/v/x?old=1", "a=1")).toBe("/v/x?a=1");
		expect(withFilterSearch("/v/x?old=1", "")).toBe("/v/x");
		expect(withFilterSearch("/v/x", "")).toBe("/v/x");
	});
});

describe("SSR-safe window helpers", () => {
	it("currentSearch reads window when present", () => {
		// jsdom provides window; location.search is "" by default
		expect(typeof currentSearch()).toBe("string");
	});

	it("replaceFilterSearch updates the URL without navigating", () => {
		replaceFilterSearch("a=1");
		expect(window.location.search).toBe("?a=1");
		replaceFilterSearch("");
		expect(window.location.search).toBe("");
	});
});

describe("resolveViewText", () => {
	it("prefers catalog keys and falls back to literals", () => {
		const i18n = { locale: "en", catalog: { "ns.title": "Catalog Title" } };
		expect(resolveViewText(i18n, "ns.title")).toBe("Catalog Title");
		expect(resolveViewText(i18n, "Literal")).toBe("Literal");
		expect(resolveViewText(undefined, "Literal")).toBe("Literal");
	});
});
