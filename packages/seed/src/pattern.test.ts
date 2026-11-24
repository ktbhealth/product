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
		expect(gen("\\u0042")).toBe("B");
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

	it("pins generated code points with a constant rng", () => {
		// rng = 0 selects the lowest code point of each generated pool.
		expect(generateFromPattern(".", () => 0)).toBe(" ");
		expect(generateFromPattern("\\D", () => 0)).toBe(" ");
		expect(generateFromPattern("\\W", () => 0)).toBe(" ");
		expect(generateFromPattern("\\S", () => 0)).toBe("!");
		expect(generateFromPattern("[\\D]", () => 0)).toBe(" ");
		expect(generateFromPattern("[\\W]", () => 0)).toBe(" ");
		expect(generateFromPattern("[\\S]", () => 0)).toBe("!");
		expect(generateFromPattern("\\b", () => 0)).toBe("");
		expect(generateFromPattern("\\B", () => 0)).toBe("");
	});

	it("computes complements over sorted, clamped ranges", () => {
		expect(generateFromPattern("[^a]", () => 0.66)).toBe("^");
		expect(generateFromPattern("[^a-c]", () => 0)).toBe(" ");
		expect(generateFromPattern("[^a-c]", () => 0.7)).toBe("`");
		expect(generateFromPattern("[^\\x20-\\x28\\x29-\\x32]", () => 0)).toBe("3");
		expect(generateFromPattern("[^\\x20-\\x28\\x28-\\x29]", () => 0)).toBe("*");
		expect(generateFromPattern("[^a-\\x7d]", () => 65 / 66)).toBe("~");
		expect(generateFromPattern("[^f-ha-c]", () => 0.72)).toBe("`");
		expect(generateFromPattern("[^\\x20-\\x3a\\x28-\\x3c]", () => 0)).toBe("=");
		expect(generateFromPattern("[ab]", () => 0.5)).toBe("b");
		expect(generateFromPattern("[xd]", () => 0)).toBe("x");
		expect(generateFromPattern("[a-a]", () => 0)).toBe("a");
	});

	it("handles lazy-optional and repeated-? quantifiers", () => {
		expect(generateFromPattern("^a??$", () => 0)).toBe("");
		expect(generateFromPattern("^a??$", () => 0.999)).toBe("a");
	});

	it("clamps bounded quantifiers at MAX_REPEAT", () => {
		for (const seed of ["c1", "c2", "c3", "c4", "c5"]) {
			expect(generateFromPattern("a{65}", makeRng(seed))).toHaveLength(64);
			expect(generateFromPattern("a{64,100}", makeRng(seed))).toHaveLength(64);
			expect(generateFromPattern("a{100}", makeRng(seed))).toHaveLength(64);
		}
	});

	it("allows output exactly at the limit", () => {
		expect(generateFromPattern("abc", () => 0, 3)).toBe("abc");
		// The internal cap is MAX_PATTERN_OUTPUT * 4 = 4096, not 256.
		expect(generateFromPattern("(a{64}){5}", () => 0, 400)).toHaveLength(320);
	});

	it("reports precise syntax errors", () => {
		expect(() => generateFromPattern("a)b", makeRng("e1"))).toThrow(
			"unsupported pattern syntax at offset 1: )b",
		);
		expect(() => generateFromPattern("(a", makeRng("e2"))).toThrow("unterminated group");
		expect(() => generateFromPattern("(?x", makeRng("e3"))).toThrow(
			'unsupported group syntax "(?x"',
		);
		expect(() => generateFromPattern("[abc", makeRng("e4"))).toThrow(
			"unterminated character class",
		);
		expect(() => generateFromPattern("a{", makeRng("e5"))).toThrow("unsupported quantifier");
		expect(() => generateFromPattern("[z-a]", makeRng("e6"))).toThrow("reversed character range");
		expect(() => generateFromPattern("(a)\\1", makeRng("e7"))).toThrow("backreference");
		expect(() => generateFromPattern("\\", makeRng("e8"))).toThrow("trailing backslash");
		expect(() => generateFromPattern("[a\\", makeRng("e9"))).toThrow("trailing backslash");
		expect(() => generateFromPattern("a".repeat(201), makeRng("e10"))).toThrow(
			"pattern exceeds MAX_PATTERN_LENGTH",
		);
		expect(() => generateFromPattern("[^\\x20-\\x7e]", makeRng("e11"))).toThrow(
			"character class matches nothing generatable",
		);
		expect(() => generateFromPattern("^a{100}$", makeRng("e12"), 10)).toThrow(
			"generates more than 10 chars",
		);
		expect(() => generateFromPattern("\\x4", makeRng("e13"))).toThrow("bad \\x escape");
		expect(() => generateFromPattern("\\u12", makeRng("e14"))).toThrow("bad \\u escape");
	});

	it("enforces the output limit", () => {
		expect(() => generateFromPattern("^a{100}$", makeRng("x"), 10)).toThrow(SeedError);
	});

	it("generates whitespace for \\s escapes", () => {
		expect(gen("^[\\s]+$")).toMatch(/^\s+$/);
		expect(gen("^[\\S]$")).toMatch(/^\S$/);
	});

	it("accepts patterns up to the 200-char length cap", () => {
		expect(generateFromPattern("a".repeat(200), makeRng("len"))).toBe("a".repeat(200));
	});

	it("allows output well beyond a quarter of the pattern cap", () => {
		// 4 iterations × (64 a's + 2 b's) = 264 chars — over MAX_PATTERN_OUTPUT / 4.
		const out = gen("^(?:a{64}bb){4}$");
		expect(out).toHaveLength(264);
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
		const bad = [
			"a{",
			"[z-a]",
			"\\x4",
			"\\u12",
			"a)b",
			"(a",
			"[",
			"^[]a]$",
			"[\\",
			"a{b}{2}", // unanchored quantifier match must not slide
			"[z-a\\x20-\\x7e]", // reversed range is rejected even with a valid tail
			"\\x4g", // bad \xHH must not parseInt a prefix
			"\\u12gh", // bad \uHHHH must not parseInt a prefix
		];
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
		// Two ranges whose union covers the whole printable window.
		expect(() => generateFromPattern("[^\\x20-\\x7d\\x78-\\x7e]", makeRng("neg2"))).toThrow(
			SeedError,
		);
	});

	it("rejects patterns over MAX_PATTERN_LENGTH", () => {
		expect(() => generateFromPattern("a".repeat(201), makeRng("long"))).toThrow(SeedError);
		expect(generateFromPattern("a".repeat(200), makeRng("len200"))).toBe("a".repeat(200));
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
			"(x|(a|b)+)y", // one unsafe alternation branch is enough
			"((a|b)+c)d", // unsafe unit inside an unquantified group
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
