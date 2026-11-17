import { describe, expect, it } from "vitest";

import { f, type Fields } from "./fields.ts";
import { isJson, validateDocumentData } from "./validate.ts";

const fields: Fields = {
	name: f.string({ required: true, minLength: 2, maxLength: 5, pattern: "^[a-z]+$" }),
	age: f.number({ min: 0, max: 120 }),
	active: f.boolean(),
	at: f.date({ min: 0 }),
	level: f.enum(["low", "high"]),
	payload: f.json(),
	tags: f.array(f.string({ maxLength: 3 }), { minLength: 1, maxLength: 2 }),
	link: f.ref({ collection: "targets" }),
	withDefault: f.string({ default: "d" }),
};

describe("validateDocumentData", () => {
	it("rejects non-object input", () => {
		for (const bad of [null, [], "x", 5]) {
			const r = validateDocumentData(fields, bad);
			expect(r.ok).toBe(false);
		}
	});

	it("accepts a valid document and applies defaults", () => {
		const r = validateDocumentData(fields, { name: "abc" });
		expect(r).toEqual({ ok: true, data: { name: "abc", withDefault: "d" } });
	});

	it("rejects unknown keys", () => {
		const r = validateDocumentData(fields, { name: "abc", nope: 1 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues[0]).toContain("nope");
	});

	it("enforces required fields", () => {
		const r = validateDocumentData(fields, {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.join(" ")).toContain("name");
	});

	it("partial mode skips absent keys", () => {
		const r = validateDocumentData(fields, {}, { partial: true });
		expect(r).toEqual({ ok: true, data: {} });
	});

	it("partial mode rejects explicit undefined (no silent deletes)", () => {
		// Required field: previously skipped → required bypass.
		const req = validateDocumentData(fields, { name: undefined }, { partial: true });
		expect(req.ok).toBe(false);
		if (!req.ok) expect(req.issues[0]).toContain("name");
		// Optional field: previously skipped → stored value deleted.
		const opt = validateDocumentData(fields, { age: undefined }, { partial: true });
		expect(opt.ok).toBe(false);
		// Mixed valid + undefined still fails on the undefined key.
		const mixed = validateDocumentData(
			fields,
			{ name: "abc", age: undefined },
			{
				partial: true,
			},
		);
		expect(mixed.ok).toBe(false);
		// Truly absent keys remain fine.
		expect(validateDocumentData(fields, { name: "abc" }, { partial: true }).ok).toBe(true);
		// Full mode keeps "undefined ≡ absent" semantics.
		expect(validateDocumentData(fields, { name: "abc", age: undefined }).ok).toBe(true);
	});

	it("rejects invalid field defaults", () => {
		const badDefault: Fields = {
			n: { kind: "number", default: "abc" },
			s: { kind: "string", default: 5 },
			ok: f.number({ default: 3 }),
		};
		const r = validateDocumentData(badDefault, {});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.issues.join(" ")).toContain("n");
			expect(r.issues.join(" ")).toContain("s");
		}
		// A valid default still applies.
		const good = validateDocumentData({ ok: f.number({ default: 3 }) }, {});
		expect(good).toEqual({ ok: true, data: { ok: 3 } });
	});

	it("does not confuse prototype-chain keys for known fields", () => {
		// `"constructor" in fields` is true via Object.prototype — the
		// unknown-key check must use own-property semantics.
		const r = validateDocumentData(fields, { name: "abc", constructor: 1 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues[0]).toContain("constructor");
	});

	it("stores __proto__ field names as own data keys, not prototype writes", () => {
		// Fields maps can arrive via JSON.parse (own "__proto__" key).
		const protoFields = JSON.parse(
			'{"__proto__":{"kind":"string"},"a":{"kind":"string"}}',
		) as Fields;
		const r = validateDocumentData(protoFields, JSON.parse('{"__proto__":"x","a":"y"}'));
		expect(r.ok).toBe(true);
		if (r.ok) {
			const data = r.data as Record<string, unknown>;
			expect(Object.getPrototypeOf(data)).toBeNull();
			expect(Object.hasOwn(data, "__proto__")).toBe(true);
			expect(data["__proto__"]).toBe("x");
		}
	});

	it("validates string constraints", () => {
		for (const bad of ["a", "abcdef", "Abc", "a b", 5, null]) {
			const r = validateDocumentData(fields, { name: bad });
			expect(r.ok).toBe(false);
		}
		const ok = validateDocumentData(fields, { name: "abcde" });
		expect(ok.ok).toBe(true);
	});

	it("validates number/date bounds and types", () => {
		for (const bad of [-1, 121, "x", NaN, Infinity]) {
			expect(validateDocumentData(fields, { name: "abc", age: bad }).ok).toBe(false);
		}
		expect(validateDocumentData(fields, { name: "abc", age: 42 }).ok).toBe(true);
		expect(validateDocumentData(fields, { name: "abc", at: -5 }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", at: 1.5 }).ok).toBe(true);
		expect(validateDocumentData(fields, { name: "abc", at: "2024" }).ok).toBe(false);
	});

	it("validates booleans", () => {
		expect(validateDocumentData(fields, { name: "abc", active: "yes" }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", active: true }).ok).toBe(true);
	});

	it("validates enums", () => {
		expect(validateDocumentData(fields, { name: "abc", level: "mid" }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", level: 1 }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", level: "low" }).ok).toBe(true);
	});

	it("validates json values", () => {
		expect(validateDocumentData(fields, { name: "abc", payload: { a: [1, null] } }).ok).toBe(true);
		// undefined ≡ absent (optional → omitted, valid)
		expect(validateDocumentData(fields, { name: "abc", payload: undefined }).ok).toBe(true);
		expect(validateDocumentData(fields, { name: "abc", payload: Symbol("s") }).ok).toBe(false);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(validateDocumentData(fields, { name: "abc", payload: circular }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", payload: () => 1 }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", payload: NaN }).ok).toBe(false);
	});

	it("validates arrays element-wise with count bounds", () => {
		expect(validateDocumentData(fields, { name: "abc", tags: [] }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", tags: ["a", "b", "c"] }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", tags: "x" }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", tags: ["ab", "cd"] }).ok).toBe(true);
		expect(validateDocumentData(fields, { name: "abc", tags: ["abcd"] }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", tags: [1] }).ok).toBe(false);
	});

	it("validates refs (number or null)", () => {
		expect(validateDocumentData(fields, { name: "abc", link: 3 }).ok).toBe(true);
		expect(validateDocumentData(fields, { name: "abc", link: null }).ok).toBe(true);
		expect(validateDocumentData(fields, { name: "abc", link: "3" }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", link: NaN }).ok).toBe(false);
	});

	it("rejects null for non-nullable kinds", () => {
		expect(validateDocumentData(fields, { name: "abc", age: null }).ok).toBe(false);
		expect(validateDocumentData(fields, { name: "abc", tags: null }).ok).toBe(false);
	});

	it("handles defensive descriptor shapes", () => {
		const weird: Fields = {
			noValues: { kind: "enum" } as never,
			noOf: { kind: "array" } as never,
			bogus: { kind: "mystery" } as never,
		};
		// enum without `values` rejects every value
		expect(validateDocumentData(weird, { noValues: "x" }).ok).toBe(false);
		// array without `of` accepts any items
		expect(validateDocumentData(weird, { noOf: [1, "a"] }).ok).toBe(true);
		// unknown kind always fails
		const r = validateDocumentData(weird, { bogus: 1 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues[0]).toContain("unknown field kind mystery");
		// typeName reports arrays inside failure messages
		const r2 = validateDocumentData(fields, { name: "abc", active: [true] });
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.issues[0]).toContain("array");
	});

	it("reports multiple issues at once", () => {
		const r = validateDocumentData(fields, { age: -1, level: "bad", extra: 1 });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.issues.length).toBeGreaterThanOrEqual(3);
		}
	});
});

describe("isJson", () => {
	it("accepts JSON values and rejects the rest", () => {
		expect(isJson(null)).toBe(true);
		expect(isJson({ a: [1, "x", false, null] })).toBe(true);
		expect(isJson(undefined)).toBe(false);
		expect(isJson(new Date())).toBe(false); // Date has no enumerable own props? it does serialize — check
	});
});
