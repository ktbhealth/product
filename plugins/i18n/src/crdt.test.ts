import { describe, expect, it } from "vitest";
import {
	applyTextEdit,
	docFromUpdates,
	docValue,
	newMessageDoc,
	replaceDocValue,
	snapshotUpdate,
} from "./crdt.ts";

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

	it("applies a trailing delete edit", () => {
		const doc = newMessageDoc("");
		const r1 = applyTextEdit(doc, { insert: "Hello world" });
		const r2 = applyTextEdit(r1.doc, { delete: 6 });
		expect(docValue(r2.doc)).toBe("Hello");
		// The delete delta replays through the op log like any other op.
		expect(docValue(docFromUpdates([r1.update, r2.update]))).toBe("Hello");
	});

	it("snapshotUpdate collapses a log into one replayable update", () => {
		const doc = newMessageDoc("");
		const r1 = applyTextEdit(doc, { insert: "Hello " });
		const r2 = applyTextEdit(r1.doc, { insert: "world" });
		const updates = [r1.update, r2.update];

		const snapshot = snapshotUpdate(updates);
		// One row replays to the same value as the full log…
		expect(docValue(docFromUpdates([snapshot]))).toBe("Hello world");
		// …and a snapshot can be followed by new deltas (compaction is
		// not a one-way door).
		const continued = docFromUpdates([snapshot]);
		const r3 = applyTextEdit(continued, { insert: "!" });
		expect(docValue(r3.doc)).toBe("Hello world!");
	});

	it("snapshotUpdate on an empty log yields an empty doc", () => {
		expect(docValue(docFromUpdates([snapshotUpdate([])]))).toBe("");
	});

	it("replaceDocValue clears the text when the new value is empty", () => {
		const doc = newMessageDoc("");
		const r1 = applyTextEdit(doc, { insert: "Hello" });
		const r2 = replaceDocValue([r1.update], "");
		expect(r2.value).toBe("");
		// The clearing delta replays through the op log like any other op.
		expect(docValue(docFromUpdates([r1.update, r2.update]))).toBe("");
	});
});
