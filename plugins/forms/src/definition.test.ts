import { describe, expect, it } from "vitest";
import type { Plugin } from "@ktb/kernel";
import { definePlugin } from "@ktb/kernel";

import {
	assertFormDefinition,
	collectFormDefinitions,
	defineForm,
	FORM_DEF_KIND,
	FORM_ID_PATTERN,
	formDefContribution,
	formIdFromPath,
	toFormDefinition,
	type FormDefinition,
} from "./definition.ts";

const validSchema = {
	type: "object",
	properties: { name: { type: "string" } },
	required: ["name"],
} as const;

const def = (over: Partial<FormDefinition> = {}): FormDefinition => ({
	id: "intake",
	schema: validSchema,
	...over,
});

const pluginWith = (id: string, defs: readonly FormDefinition[]): Plugin =>
	definePlugin({
		id,
		contributions: defs.map(formDefContribution),
	});

describe("assertFormDefinition", () => {
	const ctx = "test ctx";

	it("accepts minimal and full definitions", () => {
		expect(assertFormDefinition(def(), ctx).id).toBe("intake");
		const full = assertFormDefinition(
			def({
				owner: "plug",
				title: "T",
				description: "D",
				submitLabel: "Go",
				ui: {
					name: { widget: "textarea", placeholder: "p", options: [{ value: 1, label: "L" }] },
					age: { widget: "number" },
				},
			}),
			ctx,
		);
		expect(full.ui?.name?.widget).toBe("textarea");
		// nullable object type is still object-typed
		expect(
			assertFormDefinition(def({ schema: { type: ["object", "null"], properties: {} } }), ctx).id,
		).toBe("intake");
	});

	it("rejects non-objects and bad ids", () => {
		expect(() => assertFormDefinition(null, ctx)).toThrow("must be an object");
		expect(() => assertFormDefinition("x", ctx)).toThrow("must be an object");
		expect(() => assertFormDefinition([], ctx)).toThrow("must be an object");
		expect(() => assertFormDefinition(def({ id: 42 as never }), ctx)).toThrow("form id");
		expect(() => assertFormDefinition(def({ id: "Bad Id" }), ctx)).toThrow("form id");
		expect(() => assertFormDefinition(def({ id: "-lead" }), ctx)).toThrow("form id");
	});

	it("rejects non-string metadata", () => {
		expect(() => assertFormDefinition(def({ owner: 1 as never }), ctx)).toThrow("owner");
		expect(() => assertFormDefinition(def({ title: 1 as never }), ctx)).toThrow("title");
		expect(() => assertFormDefinition(def({ description: 1 as never }), ctx)).toThrow(
			"description",
		);
		expect(() => assertFormDefinition(def({ submitLabel: 1 as never }), ctx)).toThrow(
			"submitLabel",
		);
	});

	it("rejects invalid and non-object schemas", () => {
		expect(() => assertFormDefinition(def({ schema: { type: "string" } as never }), ctx)).toThrow(
			"object-typed",
		);
		expect(() =>
			assertFormDefinition(def({ schema: { unknownKeyword: 1 } as never }), ctx),
		).toThrow(/keyword|schema/);
		expect(() => assertFormDefinition(def({ schema: true as never }), ctx)).toThrow(
			"schema object",
		);
		expect(() => assertFormDefinition(def({ schema: ["object"] as never }), ctx)).toThrow(/schema/);
	});

	it("rejects malformed ui hints", () => {
		expect(() => assertFormDefinition(def({ ui: "x" as never }), ctx)).toThrow("ui hints");
		expect(() => assertFormDefinition(def({ ui: { name: "x" as never } }), ctx)).toThrow(
			'ui hint for "name"',
		);
		expect(() =>
			assertFormDefinition(def({ ui: { name: { widget: "bogus" as never } } }), ctx),
		).toThrow("not a known widget");
		expect(() =>
			assertFormDefinition(def({ ui: { name: { placeholder: 1 as never } } }), ctx),
		).toThrow("placeholder");
		expect(() =>
			assertFormDefinition(def({ ui: { name: { options: "x" as never } } }), ctx),
		).toThrow("must be an array");
		expect(() =>
			assertFormDefinition(def({ ui: { name: { options: ["x"] as never } } }), ctx),
		).toThrow("{ value, label }");
		expect(() =>
			assertFormDefinition(
				def({ ui: { name: { options: [{ label: "no value" }] as never } } }),
				ctx,
			),
		).toThrow("{ value, label }");
		expect(() =>
			assertFormDefinition(
				def({ ui: { name: { options: [{ value: 1, label: 2 }] as never } } }),
				ctx,
			),
		).toThrow("{ value, label }");
	});
});

describe("defineForm / formDefContribution / toFormDefinition", () => {
	it("defineForm returns the asserted def", () => {
		expect(defineForm(def()).id).toBe("intake");
		expect(() => defineForm(def({ id: "BAD" }))).toThrow("form id");
	});

	it("formDefContribution emits a form.def entry", () => {
		const entry = formDefContribution(def());
		expect(entry.kind).toBe(FORM_DEF_KIND.id);
		expect(entry.id).toBe("intake");
		expect(entry.meta).toMatchObject({ id: "intake" });
	});

	it("toFormDefinition narrows and stamps owner", () => {
		const entry = formDefContribution(def());
		expect(toFormDefinition(entry, "owner.plugin").owner).toBe("owner.plugin");
		const owned = formDefContribution(def({ owner: "declared" }));
		expect(toFormDefinition(owned, "other").owner).toBe("declared");
		expect(() => toFormDefinition({ kind: "form.def", id: "x", meta: 1 as never }, "p")).toThrow(
			'plugin "p" contribution "x"',
		);
	});
});

describe("collectFormDefinitions", () => {
	it("collects across plugins in order and stamps owners", () => {
		const defs = collectFormDefinitions([
			pluginWith("plug.a", [def({ id: "one" })]),
			pluginWith("plug.b", [def({ id: "two", owner: "kept" })]),
		]);
		expect(defs.map((d) => d.id)).toEqual(["one", "two"]);
		expect(defs[0]?.owner).toBe("plug.a");
		expect(defs[1]?.owner).toBe("kept");
	});

	it("returns [] for registries without form.def entries", () => {
		expect(collectFormDefinitions([definePlugin({ id: "x" })])).toEqual([]);
		expect(collectFormDefinitions([])).toEqual([]);
	});

	it("throws on duplicate ids across contributors", () => {
		expect(() =>
			collectFormDefinitions([pluginWith("a", [def()]), pluginWith("b", [def()])]),
		).toThrow('duplicate form definition "intake"');
	});
});

describe("formIdFromPath", () => {
	it("extracts slug ids and rejects everything else", () => {
		expect(formIdFromPath("/forms/intake")).toBe("intake");
		expect(formIdFromPath("/forms/my-form-2/")).toBe("my-form-2");
		expect(formIdFromPath("/forms")).toBeNull();
		expect(formIdFromPath("/forms/Bad")).toBeNull();
		expect(formIdFromPath("/forms/a/b")).toBeNull();
		expect(formIdFromPath("/other/intake")).toBeNull();
		expect(formIdFromPath("/forms/")).toBeNull();
	});
});

describe("FORM_ID_PATTERN", () => {
	it("matches lowercase slugs only", () => {
		expect(FORM_ID_PATTERN.test("a")).toBe(true);
		expect(FORM_ID_PATTERN.test("a-b-c")).toBe(true);
		expect(FORM_ID_PATTERN.test("A")).toBe(false);
		expect(FORM_ID_PATTERN.test("a_b")).toBe(false);
	});
});
