import { describe, expect, it } from "vitest";

import { definePlugin, type Plugin } from "@ktb/kernel";

import {
	assertTriggerDef,
	collectTriggerDefinitions,
	defineTrigger,
	makeTriggerDefinitions,
	TRIGGER_DEF_KIND,
	toTriggerDefinition,
	triggerDefContribution,
	type TriggerDef,
} from "./definition.ts";

const base: TriggerDef = {
	id: "audit-log",
	collection: "patients",
	action: { kind: "hook", hook: "audit.log" },
};

describe("assertTriggerDef", () => {
	it("accepts a minimal def and fills nothing", () => {
		const def = assertTriggerDef(base, "ctx");
		expect(def.id).toBe("audit-log");
		expect(def.ops).toBeUndefined();
		expect(def.when).toBeUndefined();
		expect(def.owner).toBeUndefined();
	});

	it("accepts a full def", () => {
		const def = assertTriggerDef(
			{
				...base,
				title: "Audit",
				ops: ["insert"],
				when: { path: "status", op: "eq", value: "active" },
				action: {
					kind: "collection-write",
					collection: "audit.log",
					mapping: { message: "$record.data.name", op: "$record.op" },
					mode: "insert",
				},
				owner: "plugin.x",
			},
			"ctx",
		);
		expect(def.title).toBe("Audit");
		expect(def.ops).toEqual(["insert"]);
		expect(def.owner).toBe("plugin.x");
	});

	it("rejects non-objects and bad ids/collections", () => {
		expect(() => assertTriggerDef(null, "ctx")).toThrow(/must be an object/);
		expect(() => assertTriggerDef([], "ctx")).toThrow(/must be an object/);
		expect(() => assertTriggerDef({ ...base, id: "Bad Id" }, "ctx")).toThrow(/trigger id/);
		expect(() => assertTriggerDef({ ...base, id: 42 }, "ctx")).toThrow(/trigger id/);
		expect(() => assertTriggerDef({ ...base, collection: "9lives" }, "ctx")).toThrow(
			/collection name/,
		);
		expect(() => assertTriggerDef({ ...base, title: 7 }, "ctx")).toThrow(/title/);
		expect(() => assertTriggerDef({ ...base, owner: 7 }, "ctx")).toThrow(/owner/);
	});

	it("validates ops", () => {
		expect(() => assertTriggerDef({ ...base, ops: [] }, "ctx")).toThrow(/non-empty/);
		expect(() => assertTriggerDef({ ...base, ops: "insert" }, "ctx")).toThrow(/non-empty/);
		expect(() => assertTriggerDef({ ...base, ops: ["insert", "explode"] }, "ctx")).toThrow(
			/not one of/,
		);
		// duplicates collapse to a set
		expect(assertTriggerDef({ ...base, ops: ["insert", "insert"] }, "ctx").ops).toEqual(["insert"]);
	});

	it("validates when through the wizards condition contract", () => {
		expect(() => assertTriggerDef({ ...base, when: { path: "" } }, "ctx")).toThrow(/condition/);
		expect(() => assertTriggerDef({ ...base, when: { all: "nope" } }, "ctx")).toThrow(/condition/);
	});

	it("validates collection-write actions", () => {
		const cw = (action: unknown) => assertTriggerDef({ ...base, action }, "ctx");
		expect(() => cw(null)).toThrow(/action must be an object/);
		expect(() => cw({ kind: "nope" })).toThrow(/action kind/);
		expect(() =>
			cw({ kind: "collection-write", collection: "9bad", mapping: {}, mode: "insert" }),
		).toThrow(/valid name/);
		expect(() =>
			cw({ kind: "collection-write", collection: "ok.name", mapping: "x", mode: "insert" }),
		).toThrow(/mapping must be an object/);
		expect(() =>
			cw({
				kind: "collection-write",
				collection: "ok.name",
				mapping: { a: 5 },
				mode: "insert",
			}),
		).toThrow(/template string/);
		expect(() =>
			cw({ kind: "collection-write", collection: "ok.name", mapping: {}, mode: "upsert" }),
		).toThrow(/mode/);
		expect(() =>
			cw({ kind: "collection-write", collection: "ok.name", mapping: {}, mode: "update" }),
		).toThrow(/id template/);
		expect(() =>
			cw({
				kind: "collection-write",
				collection: "ok.name",
				mapping: {},
				mode: "update",
				id: 7,
			}),
		).toThrow(/id must be a template/);
		// update with id template is fine; id on insert is tolerated
		expect(
			cw({
				kind: "collection-write",
				collection: "ok.name",
				mapping: { v: "$record.data.v" },
				mode: "update",
				id: "$record.id",
			}).action,
		).toMatchObject({ mode: "update", id: "$record.id" });
	});

	it("validates hook actions", () => {
		expect(() => assertTriggerDef({ ...base, action: { kind: "hook" } }, "ctx")).toThrow(/hook id/);
		expect(() =>
			assertTriggerDef({ ...base, action: { kind: "hook", hook: "has space" } }, "ctx"),
		).toThrow(/hook id/);
		expect(
			assertTriggerDef({ ...base, action: { kind: "hook", hook: "my.hook-1" } }, "ctx").action,
		).toEqual({ kind: "hook", hook: "my.hook-1" });
	});
});

describe("defineTrigger / triggerDefContribution", () => {
	it("returns the asserted def", () => {
		expect(defineTrigger(base)).toEqual(base);
	});

	it("builds a JSON meta contribution", () => {
		const entry = triggerDefContribution(base);
		expect(entry.kind).toBe(TRIGGER_DEF_KIND.id);
		expect(entry.id).toBe("audit-log");
		expect(entry.meta).toEqual(base);
		// serializable by construction
		expect(JSON.parse(JSON.stringify(entry.meta))).toEqual(base);
	});
});

describe("toTriggerDefinition / collectTriggerDefinitions", () => {
	const plugin = (id: string, defs: readonly TriggerDef[]): Plugin =>
		definePlugin({
			id,
			meta: { keywords: ["triggers"] },
			contributions: defs.map(triggerDefContribution),
		});

	it("stamps owner from the contributing plugin", () => {
		const entry = triggerDefContribution(base);
		const def = toTriggerDefinition(entry, "plugin.owner");
		expect(def.owner).toBe("plugin.owner");
	});

	it("keeps an explicit owner", () => {
		const def = toTriggerDefinition(
			triggerDefContribution({ ...base, owner: "explicit" }),
			"plugin.owner",
		);
		expect(def.owner).toBe("explicit");
	});

	it("throws on malformed contributions", () => {
		expect(() =>
			toTriggerDefinition({ kind: "trigger.def", id: "x", meta: { bad: true } }, "p"),
		).toThrow(/trigger definition must be an object|trigger id/);
	});

	it("collects across plugins in order", () => {
		const other: TriggerDef = {
			id: "other-trigger",
			collection: "orders",
			action: { kind: "hook", hook: "h" },
		};
		const defs = collectTriggerDefinitions([
			plugin("plugin.a", [base]),
			plugin("plugin.b", [other]),
		]);
		expect(defs.map((d) => d.id)).toEqual(["audit-log", "other-trigger"]);
		expect(defs[0]?.owner).toBe("plugin.a");
	});

	it("throws on duplicate trigger ids", () => {
		expect(() =>
			collectTriggerDefinitions([plugin("plugin.a", [base]), plugin("plugin.b", [base])]),
		).toThrow(/duplicate trigger id/);
	});

	it("makeTriggerDefinitions builds the service value", () => {
		expect(makeTriggerDefinitions([plugin("plugin.a", [base])]).triggers).toHaveLength(1);
		expect(makeTriggerDefinitions([]).triggers).toEqual([]);
	});
});
