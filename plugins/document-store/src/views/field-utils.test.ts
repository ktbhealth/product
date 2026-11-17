import { describe, expect, it } from "vitest";

import type { FieldDescriptor } from "../fields.ts";
import {
	buildDocumentData,
	dateToInputValue,
	fieldEntries,
	formatCell,
	initialInputValue,
	inputValueToDate,
} from "./field-utils.ts";

describe("formatCell", () => {
	it("formats scalars and falls back for absent values", () => {
		expect(formatCell("string", "hi")).toBe("hi");
		expect(formatCell("number", 42)).toBe("42");
		expect(formatCell("boolean", true)).toBe("true");
		expect(formatCell("boolean", false)).toBe("false");
		expect(formatCell("enum", "a")).toBe("a");
		expect(formatCell("string", undefined)).toBe("—");
		expect(formatCell("string", null, "en", "?")).toBe("?");
	});

	it("formats dates, refs and truncates json", () => {
		expect(formatCell("date", Date.UTC(2024, 0, 2))).toContain("2024");
		expect(formatCell("date", "nope")).toBe("nope");
		expect(formatCell("ref", 7)).toBe("#7");
		expect(formatCell("ref", "abc")).toBe("abc");
		expect(formatCell("json", { a: 1 })).toBe('{"a":1}');
		// Malformed scalar payloads still render something readable.
		expect(formatCell("string", { a: 1 })).toBe('{"a":1}');
		expect(formatCell("number", 4.5)).toBe("4.5");
		const long = { blob: "x".repeat(200) };
		const cell = formatCell("json", long);
		expect(cell.endsWith("…")).toBe(true);
		expect(cell.length).toBeLessThanOrEqual(81);
	});
});

describe("date input conversion", () => {
	it("round-trips epoch ms through datetime-local", () => {
		const ms = Date.UTC(2024, 5, 15, 10, 30);
		const input = dateToInputValue(ms);
		expect(input).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		// Local-time rendering — compare via Date parse of the input.
		expect(inputValueToDate(input)).toBe(new Date(ms).setSeconds(0, 0));
	});

	it("rejects non-numbers and unparseable input", () => {
		expect(dateToInputValue("x")).toBe("");
		expect(dateToInputValue(Number.NaN)).toBe("");
		// Finite but out-of-Date-range ms still produce an invalid Date.
		expect(dateToInputValue(1e20)).toBe("");
		expect(inputValueToDate("")).toBeNull();
		expect(inputValueToDate("not-a-date")).toBeNull();
	});
});

describe("initialInputValue", () => {
	it("maps stored values to input strings per kind", () => {
		expect(initialInputValue({ kind: "string" }, "x")).toBe("x");
		expect(initialInputValue({ kind: "number" }, 3)).toBe("3");
		expect(initialInputValue({ kind: "boolean" }, true)).toBe("true");
		expect(initialInputValue({ kind: "boolean" }, false)).toBe("false");
		expect(initialInputValue({ kind: "boolean" }, undefined)).toBe("");
		// Non-boolean stored values collapse to "" (untouched optional).
		expect(initialInputValue({ kind: "boolean" }, 0)).toBe("");
		expect(initialInputValue({ kind: "json" }, { a: 1 })).toBe('{\n  "a": 1\n}');
		expect(initialInputValue({ kind: "string" }, undefined)).toBe("");
	});
});

describe("buildDocumentData", () => {
	const fields: Record<string, FieldDescriptor> = {
		name: { kind: "string", required: true },
		age: { kind: "number" },
		active: { kind: "boolean" },
		kind: { kind: "enum", values: ["a", "b"] },
		meta: { kind: "json" },
		tags: { kind: "array", of: { kind: "string" } },
		when: { kind: "date" },
		target: { kind: "ref", collection: "test.targets" },
	};

	it("builds a full document from inputs", () => {
		const result = buildDocumentData(fields, {
			name: "n",
			age: "42",
			active: "true",
			kind: "a",
			meta: '{"x":1}',
			tags: '["t"]',
			when: "2024-01-02T03:04",
			target: "5",
		});
		expect(result.ok).toBe(true);
		const data = result.ok ? result.data : {};
		expect(data).toMatchObject({
			name: "n",
			age: 42,
			active: true,
			kind: "a",
			meta: { x: 1 },
			tags: ["t"],
			target: 5,
		});
		expect(typeof data.when).toBe("number");
	});

	it("omits empty optional inputs and sends null for empty refs", () => {
		const result = buildDocumentData(fields, { name: "n", active: "", target: "" });
		expect(result).toEqual({ ok: true, data: { name: "n", target: null } });
	});

	it("reports conversion failures per field", () => {
		expect(buildDocumentData(fields, { name: "n", age: "x" })).toEqual({
			ok: false,
			field: "age",
			reason: "invalidNumber",
		});
		expect(buildDocumentData(fields, { name: "n", when: "junk" })).toEqual({
			ok: false,
			field: "when",
			reason: "invalidDate",
		});
		expect(buildDocumentData(fields, { name: "n", meta: "{bad" })).toEqual({
			ok: false,
			field: "meta",
			reason: "invalidJson",
		});
		expect(buildDocumentData(fields, { name: "n", tags: "[1," })).toEqual({
			ok: false,
			field: "tags",
			reason: "invalidJson",
		});
		expect(buildDocumentData(fields, { name: "n", target: "x" })).toEqual({
			ok: false,
			field: "target",
			reason: "invalidNumber",
		});
	});
});

describe("fieldEntries", () => {
	it("preserves declaration order", () => {
		const entries = fieldEntries({ b: { kind: "string" }, a: { kind: "number" } });
		expect(entries.map(([k]) => k)).toEqual(["b", "a"]);
	});
});
