// @ts-nocheck
import { describe, expect, it } from "vitest";

import { SeedError } from "./errors.ts";
import { generateFromPattern, patternHasUnsafeRepetition } from "./pattern.ts";
import { makeRng } from "./rng.ts";

/** Generate and assert the REAL RegExp accepts the candidate. */
const gen = (pattern: string, limit?: number): string => {
	const out = generateFromPattern(pattern, makeRng(`pat:${pattern}`), limit);
	expect(new RegExp(pattern).test(out)).toBe(true);
	return out;
};

describe("generateFromPattern", () => {
	it("handles literals and anchors", () => {
		expect(gen("^hello$")).toBe("hello");
		expect(gen("abc")).toBe("abc");
	});

	it("handles escapes and classes", () => {
		expect(gen("^\\d{3}$")).toMatch(/^\d{3}$/);
		expect(gen("^[a-z]{4}$")).toMatch(/^[a-z]{4}$/);
		expect(gen("^\\w+$")).toMatch(/^\w+$/);
		expect(gen("^\\S+$")).toMatch(/^\S+$/);
		expect(gen("^\\.$")).toBe(".");
		expect(gen("^\\x41+$")).toMatch(/^A+$/);
		expect(gen("^\\u0042$")).toBe("B");
	});

	it("handles CPF-style patterns", () => {
		const out = gen("^\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}$");
		expect(out).toMatch(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
	});

	it("handles groups, alternation and quantifiers", () => {
		expect(gen("^(cat|dog)s?$")).toMatch(/^(cat|dog)s?$/);
		expect(gen("^(ab){2,3}$")).toMatch(/^(ab){2,3}$/);
		expect(gen("^colou?r$")).toMatch(/^colou?r$/);
		expect(gen("^a{2,4}b$")).toMatch(/^a{2,4}b$/);
		expect(gen("^(?:xy)+$")).toMatch(/^(?:xy)+$/);
	});

	it("handles negated classes and dot", () => {
		expect(gen("^[^0-9]{3}$")).toMatch(/^[^0-9]{3}$/);
		expect(gen("^...$")).toMatch(/^...$/);
	});

	it("handles unanchored patterns", () => {
		expect(gen("\\d{3}")).toMatch(/\d{3}/);
	});

	it("enforces the output limit", () => {
		expect(() => generateFromPattern("^a{100}$", makeRng("x"), 10)).toThrow(SeedError);
	});

	it("throws SeedError on unsupported syntax", () => {
		const bad = [
			"(?=a)b", // lookahead
			"(?!a)b", // negative lookahead
			"(?<=a)b", // lookbehind
			"(a)\\1", // backreference
			"(?<name>a)", // named group
			"[z-a]", // reversed range
			"[abc", // unterminated class
			"(abc", // unterminated group
			"a\\", // trailing backslash
		];
		for (const p of bad) {
			expect(() => generateFromPattern(p, makeRng("bad"))).toThrow(SeedError);
		}
	});

	it("handles class escapes inside character classes", () => {
		expect(gen("^[\\d]{3}$")).toMatch(/^\d{3}$/);
		expect(gen("^[\\w-]{3}$")).toMatch(/^[\w-]{3}$/);
		expect(gen("^[^\\d]{2}$")).toMatch(/^[^\d]{2}$/);
		expect(gen("^[\\D]$")).toMatch(/^\D$/);
		expect(gen("^[^]$")).toMatch(/^[^]$/); // [^] matches ANY char in JS
		expect(gen("^[a-]b$")).toMatch(/^[a-]b$/);
	});

	it("handles backspace escape inside classes", () => {
		expect(gen("^[\\b]$")).toBe("\b");
	});

	it("handles control-char escapes", () => {
		expect(gen("^\\n\\t\\r\\f\\v\\0$")).toBe("\n\t\r\f\v\0");
	});

	it("handles open-ended and lazy quantifiers", () => {
		const open = Array.from(
			{ length: 30 },
			(_, i) => generateFromPattern("^a{2,}$", makeRng(`open${i}`)).length,
		);
		expect(Math.min(...open)).toBeGreaterThanOrEqual(2);
		expect(Math.max(...open)).toBeGreaterThan(10); // {n,} really is open-ended
		expect(gen("^a{3}$")).toBe("aaa");
		expect(gen("^a+?b")).toMatch(/^a+?b/);
		expect(gen("^a*?$")).toMatch(/^a*$/);
		expect(gen("^[\\W]$")).toMatch(/^[\W]$/);
	});

	it("throws on more unsupported/invalid syntax", () => {
		// NOTE: "a}" and "a|" are VALID JS regexes (literal } / empty alt).
		const bad = ["a{", "[z-a]", "\\x4", "\\u12", "a)b", "(a", "[", "^[]a]$", "[\\"];
		for (const p of bad) {
			expect(() => generateFromPattern(p, makeRng("bad2"))).toThrow(SeedError);
		}
		expect(gen("^[\\q]oo$")).toBe("qoo");
		expect(gen("a}")).toBe("a}");
		expect(["", "a"]).toContain(gen("a|"));
	});

	it("throws when a negated class has nothing generatable", () => {
		// [^\x20-\x7e] excludes every printable char → empty pool.
		expect(() => generateFromPattern("^[^\\x20-\\x7e]$", makeRng("neg"))).toThrow(SeedError);
	});

	it("rejects patterns over MAX_PATTERN_LENGTH", () => {
		expect(() => generateFromPattern("a".repeat(201), makeRng("long"))).toThrow(SeedError);
	});

	it("is deterministic", () => {
		const a = generateFromPattern("^[A-Z]{2}\\d{4}$", makeRng("same"));
		const b = generateFromPattern("^[A-Z]{2}\\d{4}$", makeRng("same"));
		expect(a).toBe(b);
	});
});

describe("patternHasUnsafeRepetition", () => {
	it("flags repeated units whose subtree is ambiguous", () => {
		for (const p of [
			"(a|aa)+b", // the classic alternation ReDoS
			"(a|b)*c",
			"(a|b)+c",
			"(a+)+b", // nested quantifier
			"(a?)+b",
			"(x|yy){2,}z",
			"((a|b)c)+d", // ambiguity nested inside groups
		]) {
			expect(patternHasUnsafeRepetition(p), p).toBe(true);
		}
	});

	it("allows deterministic repetitions and unquantified alternation", () => {
		for (const p of [
			"^a+$",
			"^[a-c]{2,5}$",
			"^(cat|dog|bird)$", // alternation without repetition — linear
			"(a|aa)b",
			"^(ab){2,3}$",
			"(?:xy)+z",
			"^\\d{3}-\\d{2}$",
			"^\\w+$",
		]) {
			expect(patternHasUnsafeRepetition(p), p).toBe(false);
		}
	});

	it("throws SeedError on patterns the subset parser rejects", () => {
		expect(() => patternHasUnsafeRepetition("(?=a)b")).toThrow(SeedError);
	});
});
