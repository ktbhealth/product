import { describe, expect, it } from "vitest";

import { definePlugin } from "@ktb/kernel";

import {
	assertWizardDefinition,
	collectWizardDefinitions,
	defineWizard,
	makeWizardDefinitions,
	toWizardDefinition,
	WIZARD_DEF_KIND,
	WIZARD_ID_PATTERN,
	wizardDefContribution,
	wizardIdFromPath,
	type WizardDefinition,
} from "./definition.ts";

const VALID_SCHEMA = {
	type: "object",
	properties: { name: { type: "string" } },
	required: ["name"],
} as const;

const validDef: WizardDefinition = {
	id: "intake",
	title: "Intake",
	steps: [
		{ kind: "info", id: "welcome", title: "Welcome", body: "Let's go" },
		{
			kind: "form",
			id: "details",
			schema: VALID_SCHEMA,
			ui: {
				name: { widget: "input", placeholder: "Full name" },
				age: { widget: "number", options: [{ value: 1, label: "One" }] },
			},
			when: { path: "welcome", op: "exists" },
		},
	],
	completion: { kind: "document-store", collection: "intakes", data: { name: "$details.name" } },
};

describe("assertWizardDefinition", () => {
	it("accepts a valid definition", () => {
		expect(assertWizardDefinition(validDef, "ctx")).toBe(validDef);
		expect(assertWizardDefinition({ id: "x", steps: [{ kind: "info", id: "s" }] }, "ctx")).toEqual({
			id: "x",
			steps: [{ kind: "info", id: "s" }],
		});
	});

	it("rejects non-objects and bad ids", () => {
		for (const bad of [null, "x", [], 42]) {
			expect(() => assertWizardDefinition(bad, "ctx")).toThrow("must be an object");
		}
		for (const id of ["", "Bad", "-x", "a b", "a/b", "UPPER", 3, undefined]) {
			expect(() =>
				assertWizardDefinition({ id, steps: [{ kind: "info", id: "s" }] }, "ctx"),
			).toThrow(/id must match/);
		}
	});

	it("rejects bad metadata fields", () => {
		const base = { id: "ok", steps: [{ kind: "info", id: "s" }] };
		expect(() => assertWizardDefinition({ ...base, owner: 3 }, "ctx")).toThrow("owner");
		expect(() => assertWizardDefinition({ ...base, title: 3 }, "ctx")).toThrow("title");
		expect(() => assertWizardDefinition({ ...base, description: {} }, "ctx")).toThrow(
			"description",
		);
		expect(() => assertWizardDefinition({ ...base, submitLabel: 9 }, "ctx")).toThrow("submitLabel");
		expect(() => assertWizardDefinition({ ...base, permission: 3 }, "ctx")).toThrow("permission");
		expect(() => assertWizardDefinition({ ...base, permission: "no-dot" }, "ctx")).toThrow(
			"resource.action",
		);
		expect(() =>
			assertWizardDefinition({ ...base, permission: "res.action" }, "ctx"),
		).not.toThrow();
	});

	it("rejects prototype-polluting step ids", () => {
		for (const id of ["__proto__", "constructor", "prototype"]) {
			expect(() =>
				assertWizardDefinition({ id: "ok", steps: [{ kind: "info", id }] }, "ctx"),
			).toThrow("reserved");
		}
	});

	it("rejects missing/empty steps", () => {
		expect(() => assertWizardDefinition({ id: "ok" }, "ctx")).toThrow("at least one step");
		expect(() => assertWizardDefinition({ id: "ok", steps: [] }, "ctx")).toThrow(
			"at least one step",
		);
		expect(() => assertWizardDefinition({ id: "ok", steps: "x" }, "ctx")).toThrow(
			"at least one step",
		);
	});

	it("rejects malformed steps", () => {
		const ctx = "ctx";
		expect(() => assertWizardDefinition({ id: "ok", steps: ["x"] }, ctx)).toThrow(
			"step must be an object",
		);
		expect(() => assertWizardDefinition({ id: "ok", steps: [{ kind: "info" }] }, ctx)).toThrow(
			"step id",
		);
		expect(() =>
			assertWizardDefinition({ id: "ok", steps: [{ id: "", kind: "info" }] }, ctx),
		).toThrow("step id");
		expect(() =>
			assertWizardDefinition({ id: "ok", steps: [{ id: "a", kind: "bogus" }] }, ctx),
		).toThrow('kind must be "form" or "info"');
		expect(() =>
			assertWizardDefinition({ id: "ok", steps: [{ id: "a", kind: "info", title: 1 }] }, ctx),
		).toThrow("title");
		expect(() =>
			assertWizardDefinition({ id: "ok", steps: [{ id: "a", kind: "info", description: 1 }] }, ctx),
		).toThrow("description");
		expect(() =>
			assertWizardDefinition({ id: "ok", steps: [{ id: "a", kind: "info", body: 1 }] }, ctx),
		).toThrow("body");
		expect(() =>
			assertWizardDefinition({ id: "ok", steps: [{ id: "a", kind: "info", submitLabel: 1 }] }, ctx),
		).toThrow("submitLabel");
		expect(() =>
			assertWizardDefinition({ id: "ok", steps: [{ id: "a", kind: "info", when: "x" }] }, ctx),
		).toThrow("when");
	});

	it("rejects duplicate step ids", () => {
		expect(() =>
			assertWizardDefinition(
				{
					id: "ok",
					steps: [
						{ kind: "info", id: "dup" },
						{ kind: "info", id: "dup" },
					],
				},
				"ctx",
			),
		).toThrow('duplicate wizard step id "dup"');
	});

	it("rejects malformed form steps", () => {
		const ctx = "ctx";
		const step = (extra: Record<string, unknown>) => ({
			id: "ok",
			steps: [{ kind: "form", id: "f", schema: VALID_SCHEMA, ...extra }],
		});
		expect(() => assertWizardDefinition(step({ schema: "x" }), ctx)).toThrow();
		expect(() => assertWizardDefinition(step({ schema: true }), ctx)).toThrow();
		expect(() => assertWizardDefinition(step({ schema: { type: "string" } }), ctx)).toThrow(
			"object-typed",
		);
		expect(() =>
			assertWizardDefinition(step({ schema: { type: ["string", "object"] } }), ctx),
		).not.toThrow();
		expect(() => assertWizardDefinition(step({ ui: "x" }), ctx)).toThrow("ui hints");
		expect(() => assertWizardDefinition(step({ ui: { f: "x" } }), ctx)).toThrow(
			"must be an object",
		);
		expect(() => assertWizardDefinition(step({ ui: { f: { widget: "bogus" } } }), ctx)).toThrow(
			"not a known widget",
		);
		expect(() => assertWizardDefinition(step({ ui: { f: { placeholder: 1 } } }), ctx)).toThrow(
			"placeholder",
		);
		expect(() => assertWizardDefinition(step({ ui: { f: { options: "x" } } }), ctx)).toThrow(
			"must be an array",
		);
		expect(() => assertWizardDefinition(step({ ui: { f: { options: ["x"] } } }), ctx)).toThrow(
			"{ value, label }",
		);
		expect(() =>
			assertWizardDefinition(step({ ui: { f: { options: [{ label: 1 }] } } }), ctx),
		).toThrow("{ value, label }");
		expect(() =>
			assertWizardDefinition(step({ ui: { f: { options: [{ label: "x" }] } } }), ctx),
		).toThrow("{ value, label }");
		expect(() =>
			assertWizardDefinition(step({ ui: { f: { options: [{ value: 1 }] } } }), ctx),
		).toThrow("{ value, label }");
	});

	it("rejects malformed completions", () => {
		const ctx = "ctx";
		const base = { id: "ok", steps: [{ kind: "info", id: "s" }] };
		expect(() => assertWizardDefinition({ ...base, completion: "x" }, ctx)).toThrow(
			"must be an object",
		);
		expect(() => assertWizardDefinition({ ...base, completion: { kind: "bogus" } }, ctx)).toThrow(
			'must be "document-store" or "hook"',
		);
		expect(() =>
			assertWizardDefinition({ ...base, completion: { kind: "document-store" } }, ctx),
		).toThrow("collection name");
		expect(() =>
			assertWizardDefinition(
				{ ...base, completion: { kind: "document-store", collection: "" } },
				ctx,
			),
		).toThrow("collection name");
		expect(() => assertWizardDefinition({ ...base, completion: { kind: "hook" } }, ctx)).toThrow(
			"hook id",
		);
		expect(() =>
			assertWizardDefinition({ ...base, completion: { kind: "hook", hook: "" } }, ctx),
		).toThrow("hook id");
		expect(() =>
			assertWizardDefinition({ ...base, completion: { kind: "hook", hook: "h", data: "x" } }, ctx),
		).toThrow("data must be an object");
		// grammar tightening: collection/hook ids must match their
		// registries' naming rules, not just be non-empty.
		expect(() =>
			assertWizardDefinition(
				{ ...base, completion: { kind: "document-store", collection: "Bad Name" } },
				ctx,
			),
		).toThrow("collection name");
		expect(() =>
			assertWizardDefinition(
				{ ...base, completion: { kind: "document-store", collection: "a/b" } },
				ctx,
			),
		).toThrow("collection name");
		expect(() =>
			assertWizardDefinition({ ...base, completion: { kind: "hook", hook: "has space" } }, ctx),
		).toThrow("hook id");
		expect(() =>
			assertWizardDefinition({ ...base, completion: { kind: "hook", hook: "my.hook-1" } }, ctx),
		).not.toThrow();
	});
});

describe("defineWizard / wizardDefContribution / toWizardDefinition", () => {
	it("defineWizard asserts eagerly", () => {
		expect(defineWizard(validDef)).toBe(validDef);
		expect(() => defineWizard({ id: "Bad Id", steps: [] })).toThrow();
	});

	it("builds a contribution entry carrying the def as meta", () => {
		const entry = wizardDefContribution(validDef);
		expect(entry.kind).toBe(WIZARD_DEF_KIND.id);
		expect(entry.id).toBe("intake");
		expect(entry.meta).toEqual(validDef);
	});

	it("narrows contributions back to definitions, stamping owner", () => {
		const entry = wizardDefContribution(validDef);
		const def = toWizardDefinition(entry, "clinic.plugin");
		expect(def.owner).toBe("clinic.plugin");
		const owned = toWizardDefinition(
			wizardDefContribution({ ...validDef, owner: "explicit" }),
			"clinic.plugin",
		);
		expect(owned.owner).toBe("explicit");
		expect(() => toWizardDefinition({ kind: "wizard.def", id: "x", meta: {} }, "p")).toThrow();
	});

	it("collects defs across the plugin registry in order", () => {
		const a = definePlugin({
			id: "plug.a",
			contributions: [wizardDefContribution({ id: "w-a", steps: [{ kind: "info", id: "s" }] })],
		});
		const b = definePlugin({
			id: "plug.b",
			contributions: [
				{ kind: "unrelated", id: "x" },
				wizardDefContribution({ id: "w-b", steps: [{ kind: "info", id: "s" }] }),
			],
		});
		const defs = collectWizardDefinitions([a, b]);
		expect(defs.map((d) => d.id)).toEqual(["w-a", "w-b"]);
		expect(defs[0]?.owner).toBe("plug.a");
		expect(collectWizardDefinitions([])).toEqual([]);
	});

	it("makeWizardDefinitions builds the service registry value", () => {
		const a = definePlugin({
			id: "plug.a",
			contributions: [wizardDefContribution({ id: "w-a", steps: [{ kind: "info", id: "s" }] })],
		});
		expect(makeWizardDefinitions([a]).wizards.map((d) => d.id)).toEqual(["w-a"]);
		expect(makeWizardDefinitions([]).wizards).toEqual([]);
	});
});

describe("wizardIdFromPath", () => {
	it("extracts the id segment", () => {
		expect(wizardIdFromPath("/wizards/intake")).toBe("intake");
		expect(wizardIdFromPath("/wizards/intake/")).toBe("intake");
		expect(wizardIdFromPath("  /wizards/a-b  ")).toBe("a-b");
	});

	it("returns null for non-matching paths", () => {
		for (const path of [
			"/wizards",
			"/wizards/",
			"/other/x",
			"/wizards/a/b",
			"",
			"/wizards/x?y=1",
		]) {
			expect(wizardIdFromPath(path)).toBeNull();
		}
	});
});

describe("WIZARD_ID_PATTERN", () => {
	it("matches slug ids", () => {
		expect(WIZARD_ID_PATTERN.test("a")).toBe(true);
		expect(WIZARD_ID_PATTERN.test("a-b-c")).toBe(true);
		expect(WIZARD_ID_PATTERN.test("A")).toBe(false);
	});
});
