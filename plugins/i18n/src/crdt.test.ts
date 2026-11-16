import { describe, expect, it } from "vitest";
import { applyTextEdit, docFromUpdates, docValue, newMessageDoc } from "./crdt.ts";

describe("crdt helpers", () => {
	it("creates a doc and materializes its value", () => {
		const doc = newMessageDoc("<p>Hello</p>");
		expect(docValue(doc)).toBe("<p>Hello</p>");
	});

	it("round-trips through the op log", () => {
		const doc = newMessageDoc("");
		const r1 = applyTextEdit(doc, { insert: "Hello " });
		const r2 = applyTextEdit(r1.doc, { insert: "world" });
		expect(docValue(r2.doc)).toBe("Hello world");

		// Rebuild from updates only — value must match.
		const rebuilt = docFromUpdates([r1.update, r2.update]);
		expect(docValue(rebuilt)).toBe("Hello world");
	});

	it("merges concurrent edits from two docs seeded identically", () => {
		const base = newMessageDoc("base ");
		const u0 = base.export({ mode: "update" });
		const a = docFromUpdates([u0]);
		const b = docFromUpdates([u0]);
		const ea = applyTextEdit(a, { insert: "A" });
		const eb = applyTextEdit(b, { insert: "B" });
		// Cross-apply: both converge regardless of order.
		const merged = docFromUpdates([u0, ea.update, eb.update]);
		const v = docValue(merged);
		expect(v).toContain("base ");
		expect(v).toContain("A");
		expect(v).toContain("B");
	});
});
