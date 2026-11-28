import { describe, expect, it } from "vitest";

import { getPath, resolvePath, setPath } from "./path.ts";

describe("getPath", () => {
	const data = { step: { items: ["a", "b"], flag: true }, n: 3 };

	it("resolves dot paths and array indices", () => {
		expect(getPath(data, "step.items.1")).toBe("b");
		expect(getPath(data, "step.flag")).toBe(true);
		expect(getPath(data, "n")).toBe(3);
	});

	it("returns undefined for missing or mistyped segments", () => {
		expect(getPath(data, "missing.deep.path")).toBeUndefined();
		expect(getPath(data, "step.items.x")).toBeUndefined();
		expect(getPath(data, "n.child")).toBeUndefined();
		expect(getPath(data, "step.items.9")).toBeUndefined();
		expect(getPath(null, "a")).toBeUndefined();
		expect(getPath(undefined, "a.b")).toBeUndefined();
	});

	it("indexes arrays only by canonical integer segments", () => {
		// "01" is canonical decimal (index 1); "", "1e2", "0x10", " 1"
		// parse via Number() but are NOT canonical indices. Own array
		// props like "length" or "NaN" must not resolve either.
		expect(getPath(data, "step.items.01")).toBe("b");
		expect(getPath(data, "step.items.")).toBeUndefined();
		expect(getPath(data, "step.items.1e2")).toBeUndefined();
		expect(getPath(data, "step.items.0x1")).toBeUndefined();
		expect(getPath(data, "step.items. 1")).toBeUndefined();
		expect(getPath(data, "step.items.length")).toBeUndefined();
		const quirky = ["a"] as unknown as Record<string, unknown>;
		quirky.NaN = "nan";
		expect(getPath({ items: quirky }, "items.NaN")).toBeUndefined();
	});

	it("does not read properties off primitives", () => {
		expect(getPath({ s: "abc" }, "s.length")).toBeUndefined();
		expect(getPath({ n: 3 }, "n.toString")).toBeUndefined();
	});

	it("never walks the prototype chain", () => {
		// Inherited members must not resolve — own-property walk only.
		expect(getPath(data, "constructor.name")).toBeUndefined();
		expect(getPath(data, "__proto__.polluted")).toBeUndefined();
		expect(getPath(data, "step.constructor")).toBeUndefined();
		// own properties still resolve, including shadowing names
		const own = { constructor: "mine", hasOwnProperty: 1 };
		expect(getPath(own, "constructor")).toBe("mine");
		expect(getPath(own, "hasOwnProperty")).toBe(1);
	});
});

describe("setPath", () => {
	it("sets leaf values and creates intermediate objects", () => {
		const root: Record<string, unknown> = {};
		setPath(root, "a.b.c", 1);
		expect(root).toEqual({ a: { b: { c: 1 } } });
	});

	it("creates arrays when the next segment is numeric", () => {
		const root: Record<string, unknown> = {};
		setPath(root, "items.0.name", "x");
		expect(root).toEqual({ items: [{ name: "x" }] });
	});

	it("creates arrays only when the next segment is all digits", () => {
		const root: Record<string, unknown> = {};
		setPath(root, "a.10.b", 1);
		expect(Array.isArray(root.a)).toBe(true);
		expect((root.a as unknown[])[10]).toEqual({ b: 1 });
		const root2: Record<string, unknown> = {};
		setPath(root2, "c.1x.d", 2);
		setPath(root2, "e.x1.f", 3);
		expect(root2.c).toEqual({ "1x": { d: 2 } });
		expect(root2.e).toEqual({ x1: { f: 3 } });
	});

	it("creates empty arrays without placeholder elements", () => {
		const root: Record<string, unknown> = {};
		setPath(root, "a.5.b", 1);
		expect(Array.isArray(root.a)).toBe(true);
		expect((root.a as unknown[])[0]).toBeUndefined();
		expect((root.a as unknown[])[5]).toEqual({ b: 1 });
	});

	it("keeps existing object/array subtrees", () => {
		const root: Record<string, unknown> = { a: { b: { keep: true } }, list: [1, 2] };
		setPath(root, "a.b.c", 2);
		setPath(root, "list.1", 9);
		expect(root).toEqual({ a: { b: { keep: true, c: 2 } }, list: [1, 9] });
	});

	it("replaces non-object intermediates", () => {
		const root: Record<string, unknown> = { a: 5, b: null };
		setPath(root, "a.x", 1);
		setPath(root, "b.y", 2);
		expect(root).toEqual({ a: { x: 1 }, b: { y: 2 } });
	});

	it("refuses paths with forbidden segments", () => {
		const root: Record<string, unknown> = {};
		setPath(root, "__proto__.polluted", true);
		setPath(root, "a.constructor.b", 1);
		setPath(root, "prototype.x", 1);
		expect(root).toEqual({});
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("resolvePath", () => {
	const scope = { record: { id: 7, nested: { v: "x" } }, event: { by: "u1" } };

	it("resolves $<root>.<path> templates against own scope roots", () => {
		expect(resolvePath("$record.id", scope)).toBe(7);
		expect(resolvePath("$record.nested.v", scope)).toBe("x");
		expect(resolvePath("$event.by", scope)).toBe("u1");
	});

	it("returns undefined for non-templates and unknown roots", () => {
		expect(resolvePath("plain", scope)).toBeUndefined();
		expect(resolvePath("$event", scope)).toBeUndefined(); // no dot path
		expect(resolvePath("$bogus.path", scope)).toBeUndefined();
		expect(resolvePath(42, scope)).toBeUndefined();
		expect(resolvePath(null, scope)).toBeUndefined();
		expect(resolvePath({ toString: () => "$record.id" }, scope)).toBeUndefined();
	});

	it("requires the template to span the whole string", () => {
		expect(resolvePath("costs $record.id", scope)).toBeUndefined();
		expect(resolvePath("$record.id\nextra", scope)).toBeUndefined();
	});

	it("never resolves through the prototype chain", () => {
		expect(resolvePath("$constructor.name", scope)).toBeUndefined();
		expect(resolvePath("$record.__proto__.x", scope)).toBeUndefined();
		const inherited = Object.create({ record: { id: 9 } }) as object;
		expect(resolvePath("$record.id", inherited)).toBeUndefined();
	});

	it("returns undefined for unresolvable paths", () => {
		expect(resolvePath("$record.missing.deep", scope)).toBeUndefined();
	});
});
