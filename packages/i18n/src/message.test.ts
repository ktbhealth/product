import { describe, expect, it } from "vitest";
import {
	parseMessage,
	pseudoLocalize,
	paramSignature,
	renderMessage,
	validateAgainstSignature,
} from "./message.ts";

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
		const r = parseMessage("text", "Click <a href='#'>here</a>");
		expect(r.ok).toBe(false);
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
});

describe("paramSignature", () => {
	it("returns params without kind check", () => {
		const sig = paramSignature("Hi {name}");
		expect(Array.isArray(sig)).toBe(true);
		if (Array.isArray(sig)) expect(sig[0]?.name).toBe("name");
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

	it("renders list hint", () => {
		const out = renderMessage("{items, list}", { items: ["a", "b"] }, "en");
		expect(out).toContain("a");
		expect(out).toContain("b");
	});

	it("returns template on syntax error", () => {
		expect(renderMessage("{oops", {}, "en")).toBe("{oops");
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
		expect(issues.some((i) => i.detail.includes("amount"))).toBe(true);
	});

	it("flags hint mismatch", () => {
		const issues = validateAgainstSignature("{amount}", expected);
		expect(issues.some((i) => i.detail.includes("hint"))).toBe(true);
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
});
