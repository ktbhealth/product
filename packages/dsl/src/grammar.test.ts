import { describe, expect, it } from "vitest";

import {
	API_KEY_PATTERN,
	COLLECTION_NAME_RE,
	FIELD_PATH_RE,
	FORBIDDEN_PATH_SEGMENTS,
	HOOK_ID_RE,
	hasForbiddenPathSegment,
	isFieldPath,
	isRecord,
	PERMISSION_RE,
	SLUG_PATTERN,
} from "./grammar.ts";

describe("isRecord", () => {
	it("accepts plain objects only", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord(undefined)).toBe(false);
		expect(isRecord([])).toBe(false);
		expect(isRecord("x")).toBe(false);
		expect(isRecord(1)).toBe(false);
		expect(isRecord(() => {})).toBe(false);
	});
});

describe("forbidden path segments", () => {
	it("flags prototype-polluting segments", () => {
		expect(FORBIDDEN_PATH_SEGMENTS.has("__proto__")).toBe(true);
		expect(FORBIDDEN_PATH_SEGMENTS.has("constructor")).toBe(true);
		expect(FORBIDDEN_PATH_SEGMENTS.has("prototype")).toBe(true);
		expect(FORBIDDEN_PATH_SEGMENTS.has("safe")).toBe(false);
	});

	it("hasForbiddenPathSegment checks every dot segment", () => {
		expect(hasForbiddenPathSegment("a.b.c")).toBe(false);
		expect(hasForbiddenPathSegment("__proto__.x")).toBe(true);
		expect(hasForbiddenPathSegment("a.constructor")).toBe(true);
		expect(hasForbiddenPathSegment("prototype")).toBe(true);
	});
});

describe("grammar patterns", () => {
	it("COLLECTION_NAME_RE", () => {
		expect(COLLECTION_NAME_RE.test("patients")).toBe(true);
		expect(COLLECTION_NAME_RE.test("a.b-c_d")).toBe(true);
		expect(COLLECTION_NAME_RE.test("1abc")).toBe(false);
		expect(COLLECTION_NAME_RE.test("Abc")).toBe(false);
		expect(COLLECTION_NAME_RE.test("")).toBe(false);
		expect(COLLECTION_NAME_RE.test("abc!")).toBe(false);
		expect(COLLECTION_NAME_RE.test("a".repeat(101))).toBe(false);
	});

	it("PERMISSION_RE", () => {
		expect(PERMISSION_RE.test("patient.read")).toBe(true);
		expect(PERMISSION_RE.test("a.b.c")).toBe(true);
		expect(PERMISSION_RE.test("nodot")).toBe(false);
		expect(PERMISSION_RE.test("a..")).toBe(false);
		expect(PERMISSION_RE.test("")).toBe(false);
		expect(PERMISSION_RE.test("a.b!")).toBe(false);
		expect(PERMISSION_RE.test("!a.b")).toBe(false);
		expect(PERMISSION_RE.test("a.b c.d")).toBe(false);
	});

	it("HOOK_ID_RE", () => {
		expect(HOOK_ID_RE.test("hook.one")).toBe(true);
		expect(HOOK_ID_RE.test("a")).toBe(true);
		expect(HOOK_ID_RE.test(".lead")).toBe(false);
		expect(HOOK_ID_RE.test("has space")).toBe(false);
		expect(HOOK_ID_RE.test(`${"x".repeat(129)}`)).toBe(false);
	});

	it("SLUG_PATTERN", () => {
		expect(SLUG_PATTERN.test("my-wizard-2")).toBe(true);
		expect(SLUG_PATTERN.test("abc")).toBe(true);
		expect(SLUG_PATTERN.test("-lead")).toBe(false);
		expect(SLUG_PATTERN.test("trail-")).toBe(false);
		expect(SLUG_PATTERN.test("Upper")).toBe(false);
		expect(SLUG_PATTERN.test("a_b")).toBe(false);
	});

	it("API_KEY_PATTERN", () => {
		expect(API_KEY_PATTERN.test("reports")).toBe(true);
		expect(API_KEY_PATTERN.test("0abc")).toBe(true);
		expect(API_KEY_PATTERN.test("Aabc")).toBe(false);
		expect(API_KEY_PATTERN.test("has/slash")).toBe(false);
	});
});

describe("field paths", () => {
	it("FIELD_PATH_RE matches dotted identifier paths", () => {
		expect(FIELD_PATH_RE.test("a.b.c")).toBe(true);
		expect(FIELD_PATH_RE.test("items.0.name")).toBe(true);
		expect(FIELD_PATH_RE.test("a..b")).toBe(false);
		expect(FIELD_PATH_RE.test(".a")).toBe(false);
		expect(FIELD_PATH_RE.test("a-b")).toBe(false);
	});

	it("isFieldPath rejects non-strings and forbidden segments", () => {
		expect(isFieldPath("patient.name")).toBe(true);
		expect(isFieldPath("a.0.b")).toBe(true);
		expect(isFieldPath("")).toBe(false);
		expect(isFieldPath(42)).toBe(false);
		expect(isFieldPath("__proto__.x")).toBe(false);
		expect(isFieldPath("a.constructor")).toBe(false);
	});
});
