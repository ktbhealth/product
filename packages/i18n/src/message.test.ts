import { describe, expect, it, vi } from "vitest";
import {
	isParametrizedMessage,
	paramMessage,
	parseMessage,
	PSEUDO_LOCALE,
	pseudoLocalize,
	paramSignature,
	renderMessage,
	validateAgainstSignature,
	zipArgs,
} from "./message.ts";

/** Wrap `{leaf}` in `depth` nested select case bodies. */
const nestSelect = (depth: number): string => {
	let tpl = "{leaf}";
	for (let i = 0; i < depth; i++) tpl = `{p${i},select,a{${tpl}} other{x}}`;
	return tpl;
};

describe("parseMessage", () => {
	it("parses plain text with no params", () => {
		const r = parseMessage("text", "Hello world");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.message.params).toEqual([]);
	});

	it("parses simple params", () => {
		const r = parseMessage("text", "Hello {name}, you have {count} msgs");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.message.params.map((p) => p.name)).toEqual(["name", "count"]);
		}
	});

	it("parses formatter hints", () => {
		const r = parseMessage("text", "Total {amount, number} on {when, date}");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.message.params).toEqual([
				{ name: "amount", hint: "number", cases: undefined },
				{ name: "when", hint: "date", cases: undefined },
			]);
		}
	});

	it("parses plural with cases", () => {
		const r = parseMessage("text", "{count, plural, one {# appointment} other {# appointments}}");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.message.params[0]).toMatchObject({
				name: "count",
				cases: ["one", "other"],
			});
		}
	});

	it("parses select", () => {
		const r = parseMessage("text", "{role, select, admin {Admin} user {User} other {Guest}}");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.message.params[0]?.cases).toContain("admin");
	});

	it("rejects markup in text kind", () => {
		for (const tpl of [
			"Click <a href='#'>here</a>",
			"line<br>break",
			"<img src=x>",
			"<p>never closed",
		]) {
			expect(parseMessage("text", tpl).ok, tpl).toBe(false);
		}
	});

	it("reports the markup violation for text kind", () => {
		const r = parseMessage("text", "<b>x</b>");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("markup");
	});

	it("allows javascript: text in text kind — only tags are banned", () => {
		expect(parseMessage("text", "Avoid javascript: URLs").ok).toBe(true);
	});

	it("allows markup-free rich kind through parse", () => {
		const r = parseMessage("rich", "<p>Hello {name}</p>");
		expect(r.ok).toBe(true);
	});

	it("rejects unclosed brace", () => {
		expect(parseMessage("text", "Hello {name").ok).toBe(false);
	});

	it("rejects empty param", () => {
		expect(parseMessage("text", "Hello {}").ok).toBe(false);
	});

	it("rejects unknown param type", () => {
		expect(parseMessage("text", "{x, frobnicate}").ok).toBe(false);
	});

	it("rejects bad param name", () => {
		expect(parseMessage("text", "{1bad}").ok).toBe(false);
	});

	it("rejects case bodies that fail to tokenize", () => {
		const r = parseMessage("text", "{a,select,x{{1bad}} other{y}}");
		expect(r.ok).toBe(false);
	});

	it("rejects malformed plural/select case lists", () => {
		// Empty case list.
		expect(parseMessage("text", "{n, plural,}").ok).toBe(false);
		// Case key not followed by a body brace.
		expect(parseMessage("text", "{n, plural,one x other {y}}").ok).toBe(false);
		// Case body brace never closed inside the arg list.
		expect(parseMessage("text", "{n, plural,one {a} other {}").ok).toBe(false);
		// Case key that matches neither `=N` nor a keyword.
		expect(parseMessage("text", "{n, plural,!!!{x} other {y}}").ok).toBe(false);
		// Formatter hint with extra args.
		expect(parseMessage("text", "{n, number, extra}").ok).toBe(false);
	});

	it("accepts trailing whitespace after the last case", () => {
		expect(parseMessage("text", "{n, plural, one {a} other {b} }").ok).toBe(true);
	});

	it("sees params nested inside plural/select case bodies", () => {
		const r = parseMessage("text", "{a,select,x{{secret}} other{y}}");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.message.params.map((p) => p.name)).toEqual(["a", "secret"]);
	});

	it("dedupes nested params by name", () => {
		const r = parseMessage("text", "{a,select,x{{a} and {b}} other{y}}");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.message.params.map((p) => p.name)).toEqual(["a", "b"]);
	});

	it("collects deeply nested params in declaration order", () => {
		const r = parseMessage("text", nestSelect(2));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.message.params.map((p) => p.name)).toEqual(["p1", "p0", "leaf"]);
	});

	it("rejects nesting deeper than the cap", () => {
		expect(parseMessage("text", nestSelect(8)).ok).toBe(true);
		const deep = parseMessage("text", nestSelect(9));
		expect(deep.ok).toBe(false);
		if (!deep.ok) expect(deep.error).toContain("nesting");
	});

	it("rejects oversized templates, accepts the boundary", () => {
		expect(parseMessage("text", "x".repeat(10_001)).ok).toBe(false);
		expect(parseMessage("text", `${"x".repeat(9_995)}{abc}`).ok).toBe(true);
	});

	it("rejects forbidden markup in rich kind", () => {
		for (const tpl of [
			"<img src=x onerror=alert(1)>",
			"<p>Hi</p><SCRIPT SRC=//evil.example/x.js></SCRIPT>",
			'<iframe src="https://evil.example"></iframe>',
			'<a href="javascript:alert(1)">x</a>',
			'<div onclick="steal()">x</div>',
			"<embed src=x><object data=x></object><style>body{}</style>",
			"< script src=x>",
			"<div onclick = 'steal()'>x</div>",
			'<a href="javascript :alert(1)">x</a>',
		]) {
			expect(parseMessage("rich", tpl).ok, tpl).toBe(false);
		}
	});

	it("reports the forbidden-markup violation for rich kind", () => {
		const r = parseMessage("rich", "<script>x</script>");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("forbidden");
	});

	it("still accepts legitimate rich HTML", () => {
		for (const tpl of [
			"<p>Hello {name}</p>",
			"<strong>Bold</strong> and <em>em</em> with {n, number}",
			'<a href="https://example.com" target="_blank">link</a>',
		]) {
			expect(parseMessage("rich", tpl).ok, tpl).toBe(true);
		}
	});

	it("reports specific syntax error details", () => {
		const error = (tpl: string): string => {
			const r = parseMessage("text", tpl);
			expect(r.ok).toBe(false);
			return r.ok ? "" : r.error;
		};
		expect(error("{}")).toContain("empty");
		expect(error("{1bad}")).toContain("bad param name");
		expect(error("{n, number, extra}")).toContain("extra args");
		expect(error("{x, frobnicate}")).toContain("unknown param type");
		expect(error("{n, plural, !!!{x} other {y}}")).toContain("bad plural cases");
		expect(error("x".repeat(10_001))).toContain("10000");
	});

	it("reports the full invalid param name, braces and commas included", () => {
		const r = parseMessage("text", "{na{x,y}me, number}");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("bad param name 'na{x,y}me'");
	});

	it("rejects case keys that are not followed by a body brace", () => {
		const r = parseMessage("text", "{n,select,a{x}b,c{d}e,f{g}}");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("bad select cases");
	});

	it("rejects garbage before a case key instead of skipping ahead", () => {
		// The case-key regex is anchored: "####{" is not a valid key, so
		// the whole case list must be rejected — not scanned forward.
		expect(parseMessage("text", "{n, plural, ####{one {a} other {b}}}").ok).toBe(false);
	});

	it("rejects param names that only prefix-match the name regex", () => {
		expect(parseMessage("text", "{abc!}").ok).toBe(false);
		expect(parseMessage("text", "{na-me}").ok).toBe(false);
	});

	it("parses multi-digit exact plural keys", () => {
		const r = parseMessage("text", "{n, plural, =10 {ten} other {x}}");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.message.params[0]?.cases).toContain("=10");
	});

	it("parses params whose names contain the plural/select keywords", () => {
		for (const tpl of [
			"{selection, select, a{x} other{y}}",
			"{plural_count, plural, one {a} other {b}}",
			"{select, select, a{x} other{y}}",
			// The keyword must be found after the first comma — a name
			// carrying it at index >= 1 must not be mistaken for it.
			"{xselect, select, a{x} other{y}}",
			"{splural, plural, one {a} other {b}}",
			"{my_select, select, a{x} other{y}}",
		]) {
			expect(parseMessage("text", tpl).ok, tpl).toBe(true);
		}
	});

	it("marks plural params with plural:true and leaves select unmarked", () => {
		const p = parseMessage("text", "{n, plural, one {a} other {b}}");
		const s = parseMessage("text", "{r, select, a {x} other {y}}");
		expect(p.ok && s.ok).toBe(true);
		if (p.ok) expect(p.message.params[0]?.plural).toBe(true);
		if (s.ok) expect(s.message.params[0]?.plural).toBeUndefined();
	});
});

describe("paramSignature", () => {
	it("returns params without kind check", () => {
		const sig = paramSignature("Hi {name}");
		expect(Array.isArray(sig)).toBe(true);
		if (Array.isArray(sig)) expect(sig[0]?.name).toBe("name");
	});

	it("includes params nested in case bodies", () => {
		const sig = paramSignature("{count, plural, one {{name} has # msg} other {# msgs}}");
		expect(Array.isArray(sig)).toBe(true);
		if (Array.isArray(sig)) expect(sig.map((p) => p.name)).toEqual(["count", "name"]);
	});

	it("returns an error for too-deep nesting", () => {
		const sig = paramSignature(nestSelect(9));
		expect(Array.isArray(sig)).toBe(false);
	});

	it("collects nested params from every case, not just the first", () => {
		const sig = paramSignature("{a,select,x{{y}} other{{secret}}}");
		expect(Array.isArray(sig)).toBe(true);
		if (Array.isArray(sig)) expect(sig.map((p) => p.name)).toEqual(["a", "y", "secret"]);
	});
});

describe("renderMessage", () => {
	it("renders simple params", () => {
		expect(renderMessage("Hello {name}", { name: "Ana" }, "en")).toBe("Hello Ana");
	});

	it("renders missing params as empty", () => {
		expect(renderMessage("Hello {name}", {}, "en")).toBe("Hello ");
	});

	it("renders number hint via Intl", () => {
		expect(renderMessage("{n, number}", { n: 1234.5 }, "en")).toBe("1,234.5");
		expect(renderMessage("{n, number}", { n: 1234.5 }, "pt-BR")).toBe("1.234,5");
	});

	it("renders plural via Intl.PluralRules", () => {
		const tpl = "{count, plural, one {# item} other {# items}}";
		expect(renderMessage(tpl, { count: 1 }, "en")).toBe("1 item");
		expect(renderMessage(tpl, { count: 2 }, "en")).toBe("2 items");
		// pt-BR treats 0 as 'many'? CLDR pt: 0 → 'many' category; 'other' still matches fallback? select returns 'many' which has no case → renders "". Use 'other' coverage in real messages.
	});

	it("formats params with the base locale when rendering under qps", () => {
		// qps is a QA pseudo-locale, not a formattable locale — Intl
		// calls must use the base locale ("en") instead of throwing or
		// degrading hinted params to safe strings.
		const tpl = "{count, plural, one {{n, number} item} other {{n, number} items}}";
		const params = { count: 2, n: 1234.5 };
		expect(renderMessage(tpl, params, "qps")).toBe(renderMessage(tpl, params, "en"));
		expect(renderMessage(tpl, params, "qps")).toBe("1,234.5 items");
	});

	it("renders select", () => {
		const tpl = "{role, select, admin {A} other {O}}";
		expect(renderMessage(tpl, { role: "admin" }, "en")).toBe("A");
		expect(renderMessage(tpl, { role: "x" }, "en")).toBe("O");
	});

	it("supports exact =N plural keys", () => {
		const tpl = "{n, plural, =0 {none} other {# items}}";
		expect(renderMessage(tpl, { n: 0 }, "en")).toBe("none");
		expect(renderMessage(tpl, { n: 3 }, "en")).toBe("3 items");
	});

	it("renders nested params inside cases", () => {
		const tpl = "{count, plural, one {{name} has # msg} other {{name} has # msgs}}";
		expect(renderMessage(tpl, { count: 1, name: "Ana" }, "en")).toBe("Ana has 1 msg");
	});

	it("renders datetime and relative hints via Intl", () => {
		const d = new Date("2024-01-15T10:30:00Z");
		expect(renderMessage("{d, datetime}", { d }, "en")).toContain("2024");
		expect(renderMessage("{d, relative}", { d }, "en")).toEqual(expect.any(String));
		// Non-Date values degrade to the safe string form.
		expect(renderMessage("{d, datetime}", { d: "soon" }, "en")).toBe("soon");
		expect(renderMessage("{d, relative}", { d: "soon" }, "en")).toBe("soon");
		// Same for the plain date hint.
		expect(renderMessage("{d, date}", { d: "soon" }, "en")).toBe("soon");
	});

	it("degrades non-array list values and unstringifiable objects", () => {
		expect(renderMessage("{items, list}", { items: "one,two" }, "en")).toBe("one,two");
		// toJSON → undefined makes JSON.stringify return undefined despite
		// its string return type — the safeString fallback must catch it.
		const odd = { toJSON: () => undefined };
		expect(renderMessage("{v}", { v: odd }, "en")).toBe("[object Object]");
		// Plain objects render their JSON form.
		expect(renderMessage("{v}", { v: { a: 1 } }, "en")).toBe('{"a":1}');
	});

	it("renders select with a missing value via the other case", () => {
		const tpl = "{role, select, admin {A} other {O}}";
		expect(renderMessage(tpl, {}, "en")).toBe("O");
	});

	it("skips case bodies that fail to tokenize at render time", () => {
		// `{!!!}` is not a valid param name — the case body cannot
		// tokenize, so the case contributes nothing.
		const tpl = "{n, plural, one {{!!!}} other {why}}";
		expect(renderMessage(tpl, { n: 1 }, "en")).toBe("");
		expect(renderMessage(tpl, { n: 2 }, "en")).toBe("why");
	});

	it("renders list hint", () => {
		const out = renderMessage("{items, list}", { items: ["a", "b"] }, "en");
		expect(out).toContain("a");
		expect(out).toContain("b");
	});

	it("keeps #-prefixed ids literal inside plural cases", () => {
		const tpl = "{n, plural, one {Issue #1 open} other {# issues open}}";
		// "#1" reads as an id, not the count — only bare `#` becomes the number.
		expect(renderMessage(tpl, { n: 3 }, "en")).toBe("3 issues open");
		expect(renderMessage(tpl, { n: 1 }, "en")).toBe("Issue #1 open");
	});

	it("returns template on syntax error", () => {
		expect(renderMessage("{oops", {}, "en")).toBe("{oops");
	});

	it("never throws on circular param values", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(renderMessage("Value: {v}", { v: circular }, "en")).toBe("Value: [object Object]");
	});

	it("never throws on BigInt params", () => {
		expect(renderMessage("{v}", { v: 10n }, "en")).toBe("10");
		expect(renderMessage("{v}", { v: { n: 10n } }, "en")).toBe("[object Object]");
	});

	it("falls back when JSON.stringify yields undefined (toJSON)", () => {
		const v = { toJSON: () => undefined };
		expect(renderMessage("{v}", { v }, "en")).toBe("[object Object]");
	});

	it("never throws on values whose toString throws", () => {
		const hostile = {
			[Symbol.toPrimitive]() {
				throw new Error("boom");
			},
		};
		expect(renderMessage("{v, number}", { v: hostile }, "en")).toBe("[unprintable]");
	});

	it("never throws on invalid dates or exotic locales", () => {
		expect(renderMessage("{d, date}", { d: new Date(NaN) }, "en")).toBe("Invalid Date");
		expect(renderMessage("{n, number}", { n: 42 }, "not a locale!!!")).toBe("42");
	});

	it("never throws on exotic locales inside plural rules", () => {
		const out = renderMessage(
			"{c, plural, one {# item} other {# items}}",
			{ c: 1 },
			"not a locale!!!",
		);
		// PluralRules failed → select/other fallback path still renders.
		expect(out).toBe("# items");
	});

	it("returns the template unchanged when it exceeds the length cap", () => {
		const big = "x".repeat(20_000);
		expect(renderMessage(big, {}, "en")).toBe(big);
	});

	it("truncates case bodies past the nesting cap instead of overflowing", () => {
		const params: Record<string, unknown> = { leaf: "L" };
		for (let i = 0; i < 9; i++) params[`p${i}`] = "a";
		expect(() => renderMessage(nestSelect(9), params, "en")).not.toThrow();
		expect(renderMessage(nestSelect(2), params, "en")).toBe("L");
	});

	it("renders null params as empty", () => {
		expect(renderMessage("{v}", { v: null }, "en")).toBe("");
		expect(renderMessage("[{v}]", { v: null }, "en")).toBe("[]");
	});

	it("falls back to safeString for non-number values with number hint", () => {
		expect(renderMessage("{n, number}", { n: "abc" }, "en")).toBe("abc");
		expect(renderMessage("{n, number}", { n: true }, "en")).toBe("true");
	});

	it("formats date/datetime/list hints via Intl with exact output", () => {
		const d = new Date(2024, 0, 15, 10, 30);
		expect(renderMessage("{d, date}", { d }, "en")).toBe("Jan 15, 2024");
		expect(renderMessage("{d, datetime}", { d }, "en")).toBe("Jan 15, 2024, 10:30 AM");
		expect(renderMessage("{items, list}", { items: ["a", "b", "c"] }, "en")).toBe("a, b, and c");
	});

	it("formats the relative hint against the current time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2024, 0, 15, 10, 30));
		try {
			const d = new Date(2024, 0, 15, 12, 30);
			expect(renderMessage("{d, relative}", { d }, "en")).toBe("in 7,200 seconds");
			// numeric:"auto" renders a zero offset as "now" — the
			// default numeric mode would say "in 0 seconds".
			const now = new Date(2024, 0, 15, 10, 30);
			expect(renderMessage("{d, relative}", { d: now }, "en")).toBe("now");
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders # inside a select nested under a plural", () => {
		// ICU: `#` binds to the nearest enclosing plural's number — a
		// select case inherits it rather than dropping the substitution.
		const tpl = "{n, plural, other{{g, select, a{# item} other{# items}}}}";
		expect(renderMessage(tpl, { n: 3, g: "x" }, "en")).toBe("3 items");
		expect(renderMessage(tpl, { n: 1, g: "a" }, "en")).toBe("1 item");
	});

	it("keeps select on the exact-key path even for number values", () => {
		// safeString(1) is "1" — no case key can be "1", so the other
		// case wins and `#` stays literal (select has no pound).
		const tpl = "{n, select, one{# ONE} other{# OTH}}";
		expect(renderMessage(tpl, { n: 1 }, "en")).toBe("# OTH");
		expect(renderMessage(tpl, { n: 2 }, "en")).toBe("# OTH");
	});

	it("does not treat string values as plural numbers for =N keys", () => {
		const tpl = "{n, plural, =2 {two} other {# items}}";
		expect(renderMessage(tpl, { n: "2" }, "en")).toBe("# items");
		expect(renderMessage(tpl, { n: 2 }, "en")).toBe("two");
	});

	it("renders empty when no case matches and there is no other", () => {
		expect(renderMessage("{r, select, a {A}}", { r: "x" }, "en")).toBe("");
	});

	it("truncates rendering past the nesting cap", () => {
		const params: Record<string, unknown> = { leaf: "L" };
		for (let i = 0; i < 9; i++) params[`p${i}`] = "a";
		expect(renderMessage(nestSelect(9), params, "en")).toBe("");
	});

	it("formats hinted params under qps even when Intl rejects the tag", () => {
		const Original = Intl.NumberFormat;
		const Stub = function (this: unknown, ...args: unknown[]) {
			if (args[0] === "qps") throw new RangeError("invalid locale");
			return new (Original as new (...a: unknown[]) => object)(...args);
		};
		(Intl as { NumberFormat: unknown }).NumberFormat = Stub;
		try {
			expect(renderMessage("{n, number}", { n: 1234.5 }, "qps")).toBe("1,234.5");
		} finally {
			(Intl as { NumberFormat: unknown }).NumberFormat = Original;
		}
	});
});

describe("zipArgs", () => {
	it("maps positional args to names and ignores extras", () => {
		expect(zipArgs(["a", "b"], [1])).toEqual({ a: 1, b: undefined });
		expect(zipArgs(["a"], [1, 2])).toEqual({ a: 1 });
	});
});

describe("paramMessage", () => {
	it("renders positional args as named params", () => {
		const msg = paramMessage("en", "Hello {name}, total {n, number}", ["name", "n"]);
		expect(msg("Ana", 1234.5)).toBe("Hello Ana, total 1,234.5");
	});

	it("carries i18nTemplate + i18nParams metadata", () => {
		const msg = paramMessage("en", "{n} items", ["n"]);
		expect(msg.i18nTemplate).toBe("{n} items");
		expect(msg.i18nParams).toEqual(["n"]);
		expect(isParametrizedMessage(msg)).toBe(true);
	});

	it("is assignable to a typed catalog field signature", () => {
		const count: (n: number) => string = paramMessage(
			"en",
			"{n, plural, one {# item} other {# items}}",
			["n"],
		);
		expect(count(2)).toBe("2 items");
	});

	it("missing args render as empty, extra args are ignored", () => {
		const msg = paramMessage("en", "{a} and {b}", ["a", "b"]);
		expect(msg("x")).toBe("x and ");
		expect(msg("x", "y", "z")).toBe("x and y");
	});

	it("renders formatter hints in the bound locale", () => {
		const msg = paramMessage("pt-BR", "Total: {n, number}", ["n"]);
		expect(msg(1234.5)).toBe("Total: 1.234,5");
	});
});

describe("isParametrizedMessage", () => {
	it("rejects plain functions, strings and non-functions", () => {
		expect(isParametrizedMessage((n: number) => `${n}`)).toBe(false);
		expect(isParametrizedMessage("text")).toBe(false);
		expect(isParametrizedMessage(null)).toBe(false);
		expect(isParametrizedMessage({ i18nTemplate: "x" })).toBe(false);
	});
});

describe("validateAgainstSignature", () => {
	const expected = [{ name: "name" }, { name: "amount", hint: "number" as const }];

	it("passes on exact parity", () => {
		expect(validateAgainstSignature("Hi {name}, total {amount, number}", expected)).toEqual([]);
	});

	it("flags undeclared param", () => {
		const issues = validateAgainstSignature("Hi {name} {extra}", expected);
		expect(issues.some((i) => i.code === "param_mismatch" && i.detail.includes("extra"))).toBe(
			true,
		);
	});

	it("flags missing param", () => {
		const issues = validateAgainstSignature("Hi {name}", expected);
		const issue = issues.find((i) => i.detail.includes("amount"));
		expect(issue?.code).toBe("param_mismatch");
	});

	it("flags hint mismatch", () => {
		const issues = validateAgainstSignature("{amount}", [
			{ name: "amount", hint: "number" as const },
		]);
		expect(issues).toEqual([
			{
				code: "param_mismatch",
				detail: "param '{amount}' hint 'none' != 'number'",
			},
		]);
	});

	it("flags hint mismatch when only the template declares a hint", () => {
		const issues = validateAgainstSignature("{n, number}", [{ name: "n" }]);
		expect(issues).toEqual([
			{
				code: "param_mismatch",
				detail: "param '{n}' hint 'number' != 'none'",
			},
		]);
	});

	it("flags params that only appear inside case bodies", () => {
		const issues = validateAgainstSignature("{a,select,x{{secret}} other{y}}", [{ name: "a" }]);
		expect(issues.some((i) => i.code === "param_mismatch" && i.detail.includes("secret"))).toBe(
			true,
		);
	});

	it("reports bad_syntax for templates that fail to parse", () => {
		const issues = validateAgainstSignature("Hi {name", []);
		expect(issues).toEqual([{ code: "bad_syntax", detail: expect.stringContaining("unclosed") }]);
	});

	it("flags plural/select kind and case-key drift", () => {
		const kindIssues = validateAgainstSignature("{n, select, a{x} other{y}}", [
			{ name: "n", plural: true, cases: ["one", "other"] },
		]);
		expect(
			kindIssues.some((i) => i.code === "param_mismatch" && i.detail.includes("select")),
		).toBe(true);
		const caseIssues = validateAgainstSignature("{n, plural, one{x} other{y}}", [
			{ name: "n", plural: true, cases: ["one", "few", "other"] },
		]);
		expect(caseIssues.some((i) => i.detail.includes("few"))).toBe(true);
	});
});

describe("pseudoLocalize", () => {
	it("accents vowels, wraps in brackets and pads", () => {
		const out = pseudoLocalize("Save patient");
		expect(out.startsWith("⟦")).toBe(true);
		expect(out.endsWith("⟧")).toBe(true);
		expect(out).toContain("á");
	});

	it("leaves param tokens intact", () => {
		const out = pseudoLocalize(
			"Hello {name}, you have {count, plural, one {# item} other {# items}}",
		);
		expect(out).toContain("{name}");
		expect(out).toContain("{count, plural,");
	});

	it("accents copy inside plural/select case bodies", () => {
		const out = pseudoLocalize("{n, plural, one {# item} other {# items}}");
		// Case bodies are copy — they must be accented like any text.
		expect(out).toContain("ítém");
		// Case keys and the param header stay verbatim or the template
		// would stop parsing.
		expect(out).toContain("one{");
		expect(out).toContain("other{");
	});

	it("keeps the template parseable after pseudo-localization", () => {
		const tpl = "{count, plural, one {# item for {name}} other {# items}}";
		const out = pseudoLocalize(tpl);
		// Strip the ⟦⟧ wrap + pad, then the result must re-parse.
		const inner = out.slice(1, out.indexOf("⟧"));
		expect(parseMessage("text", inner).ok).toBe(true);
	});

	it("keeps formatter hints and unparseable case bodies intact", () => {
		// Hint tokens round-trip with their formatter.
		const hinted = pseudoLocalize("Total {n, number}");
		expect(parseMessage("text", hinted.slice(1, hinted.indexOf("⟧"))).ok).toBe(true);
		// A case body that cannot tokenize is accented verbatim — the
		// braces still survive for downstream parsers to reject.
		const bad = pseudoLocalize("{n, plural, one {{!!!}} other {y}}");
		expect(bad).toContain("{!!!}");
	});

	it("keeps param names verbatim inside unparseable case bodies", () => {
		// The body can't tokenize, so it is emitted raw — accenting it
		// would corrupt `{count}` into `{cóúnt}` and break the template.
		const out = pseudoLocalize("{n, plural, other{{bad syntax!! {count}}}}");
		expect(out).toContain("{count}");
	});

	it("keeps brace spans verbatim when the whole template fails to parse", () => {
		const out = pseudoLocalize("{!!!}");
		expect(out).toContain("{!!!}");
		expect(out.startsWith("⟦")).toBe(true);
	});

	it("joins token and fallback fragments with no separator", () => {
		// Exact output: any separator spliced between tokens or between
		// fallback brace-span parts would show up here.
		expect(pseudoLocalize("a {n} b")).toBe("⟦á {n} b···⟧");
		expect(pseudoLocalize("{a!}")).toBe("⟦{a!}··⟧");
	});

	it("does not stack-overflow on deeply nested or oversized input", () => {
		expect(() => pseudoLocalize(nestSelect(50))).not.toThrow();
		expect(pseudoLocalize(nestSelect(50)).startsWith("⟦")).toBe(true);
		expect(() => pseudoLocalize("x".repeat(50_000))).not.toThrow();
	});

	it("exposes the qps pseudo-locale tag", () => {
		expect(PSEUDO_LOCALE).toBe("qps");
	});

	it("accents every vowel, upper and lower case", () => {
		const out = pseudoLocalize("aeiou AEIOU");
		for (const ch of "áéíóúÁÉÍÓÚ") expect(out).toContain(ch);
	});

	it("produces deterministic padded output for plain text", () => {
		expect(pseudoLocalize("ab")).toBe("⟦áb·⟧");
	});

	it("preserves formatter hints and the select keyword", () => {
		expect(pseudoLocalize("Total {n, number}")).toContain("{n, number}");
		expect(pseudoLocalize("{r, select, a {A} other {O}}")).toContain(", select,");
	});

	it("separates plural cases with a space", () => {
		expect(pseudoLocalize("{n, plural, one {X} other {Y}}")).toContain("one{X} other{Y}");
	});

	it("emits case bodies verbatim past the nesting cap", () => {
		let tpl = "apple";
		for (let i = 0; i < 9; i++) tpl = `{p${i},select,a{${tpl}} other{x}}`;
		const out = pseudoLocalize(tpl);
		expect(out).toContain("apple");
		expect(out).not.toContain("ápple");
	});

	it("keeps brace spans verbatim in unparseable templates", () => {
		expect(pseudoLocalize("{a!}")).toContain("{a!}");
		expect(pseudoLocalize("Hello {!!!}")).toContain("Hélló");
	});
});
