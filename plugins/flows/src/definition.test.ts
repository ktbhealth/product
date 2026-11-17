import { describe, expect, it } from "vitest";

import { definePlugin, type Plugin } from "@ktb/kernel";

import {
	assertFlowDef,
	buildDefOwnerIndex,
	collectFlowDefinitions,
	defOwnerEnabled,
	defineFlow,
	FLOW_DEF_KIND,
	flowDefContribution,
	makeFlowDefinitions,
	toFlowDefinition,
	type FlowDef,
} from "./definition.ts";

const base: FlowDef = {
	id: "doc-review",
	collection: "documents",
	stateField: "status",
	initial: "draft",
	states: {
		draft: { on: { submit: { target: "review" } } },
		review: { on: { approve: { target: "published" } } },
		published: { final: true },
	},
};

describe("assertFlowDef", () => {
	it("accepts a minimal def and fills nothing", () => {
		const def = assertFlowDef(base, "ctx");
		expect(def.id).toBe("doc-review");
		expect(def.title).toBeUndefined();
		expect(def.permission).toBeUndefined();
		expect(def.owner).toBeUndefined();
	});

	it("accepts a full def with guards, actions and permission", () => {
		const def = assertFlowDef(
			{
				...base,
				title: "Document review",
				stateField: "review.state",
				permission: "document.publish",
				owner: "plugin.x",
				states: {
					draft: {
						on: {
							submit: {
								target: "review",
								guard: { path: "event.payload.ready", op: "eq", value: true },
								actions: [
									{ kind: "set-field", field: "review.submittedBy", value: "$event.by" },
									{ kind: "hook", hook: "docs.submitted" },
								],
							},
						},
					},
					review: { on: { approve: { target: "published" } } },
					published: { final: true },
				},
			},
			"ctx",
		);
		expect(def.title).toBe("Document review");
		expect(def.permission).toBe("document.publish");
		expect(def.owner).toBe("plugin.x");
		const submit = def.states.draft?.on?.submit;
		expect(submit?.actions).toHaveLength(2);
	});

	it("rejects non-objects and bad ids/collections/fields", () => {
		expect(() => assertFlowDef(null, "ctx")).toThrow(/must be an object/);
		expect(() => assertFlowDef([], "ctx")).toThrow(/must be an object/);
		expect(() => assertFlowDef({ ...base, id: "Bad Id" }, "ctx")).toThrow(/flow id/);
		expect(() => assertFlowDef({ ...base, id: 42 }, "ctx")).toThrow(/flow id/);
		expect(() => assertFlowDef({ ...base, collection: "9lives" }, "ctx")).toThrow(
			/collection name/,
		);
		expect(() => assertFlowDef({ ...base, stateField: "" }, "ctx")).toThrow(/stateField/);
		expect(() => assertFlowDef({ ...base, stateField: "a.__proto__.b" }, "ctx")).toThrow(
			/stateField/,
		);
		expect(() => assertFlowDef({ ...base, title: 7 }, "ctx")).toThrow(/title/);
		expect(() => assertFlowDef({ ...base, owner: 7 }, "ctx")).toThrow(/owner/);
		expect(() => assertFlowDef({ ...base, permission: "NoDots" }, "ctx")).toThrow(/permission/);
		expect(() => assertFlowDef({ ...base, permission: "has space.action" }, "ctx")).toThrow(
			/permission/,
		);
	});

	it("validates states, initial and transition targets", () => {
		expect(() => assertFlowDef({ ...base, states: {} }, "ctx")).toThrow(/non-empty/);
		expect(() => assertFlowDef({ ...base, states: "x" }, "ctx")).toThrow(/non-empty/);
		expect(() =>
			assertFlowDef({ ...base, states: { "bad name!": {} }, initial: "bad name!" }, "ctx"),
		).toThrow(/state name/);
		expect(() => assertFlowDef({ ...base, initial: "nowhere" }, "ctx")).toThrow(/initial/);
		expect(() => assertFlowDef({ ...base, initial: 3 as never }, "ctx")).toThrow(/initial/);
		// Prototype members satisfy the state-name pattern but were never
		// declared — `in` would have accepted them, hasOwn rejects.
		expect(() => assertFlowDef({ ...base, initial: "constructor" }, "ctx")).toThrow(/initial/);
		expect(() =>
			assertFlowDef(
				{
					...base,
					states: {
						draft: { on: { go: { target: "toString" } } },
						review: {},
						published: {},
					},
				},
				"ctx",
			),
		).toThrow(/not a declared state/);
		expect(() => assertFlowDef({ ...base, states: { draft: "x" } }, "ctx")).toThrow(
			/must be an object/,
		);
		expect(() =>
			assertFlowDef({ ...base, states: { draft: { final: "yes" } }, initial: "draft" }, "ctx"),
		).toThrow(/final must be a boolean/);
		expect(() =>
			assertFlowDef({ ...base, states: { draft: { on: "x" }, review: {}, published: {} } }, "ctx"),
		).toThrow(/on must be an object/);
		expect(() =>
			assertFlowDef(
				{
					...base,
					states: {
						draft: { on: { go: { target: "nowhere" } } },
						review: {},
						published: {},
					},
				},
				"ctx",
			),
		).toThrow(/not a declared state/);
	});

	it("rejects transitions on final states and bad event names", () => {
		expect(() =>
			assertFlowDef(
				{
					...base,
					states: {
						...base.states,
						published: { final: true, on: { reopen: { target: "draft" } } },
					},
				},
				"ctx",
			),
		).toThrow(/final/);
		expect(() =>
			assertFlowDef(
				{
					...base,
					states: {
						draft: { on: { "bad event!": { target: "review" } } },
						review: {},
						published: {},
					},
				},
				"ctx",
			),
		).toThrow(/event name/);
		expect(() =>
			assertFlowDef(
				{
					...base,
					states: {
						draft: { on: { submit: { target: "review" }, bad: "x" as never } },
						review: {},
						published: {},
					},
				},
				"ctx",
			),
		).toThrow(/transition must be an object/);
	});

	it("validates guards through the wizards condition contract", () => {
		expect(() =>
			assertFlowDef(
				{
					...base,
					states: {
						draft: { on: { submit: { target: "review", guard: { path: "" } } } },
						review: {},
						published: {},
					},
				},
				"ctx",
			),
		).toThrow(/condition/);
		expect(() =>
			assertFlowDef(
				{
					...base,
					states: {
						draft: { on: { submit: { target: "review", guard: { all: "nope" } } } },
						review: {},
						published: {},
					},
				},
				"ctx",
			),
		).toThrow(/condition/);
	});

	it("validates set-field and hook actions", () => {
		const withAction = (action: unknown) =>
			assertFlowDef(
				{
					...base,
					states: {
						draft: { on: { submit: { target: "review", actions: [action] as never } } },
						review: {},
						published: {},
					},
				},
				"ctx",
			);
		expect(() => withAction(null)).toThrow(/action must be an object/);
		expect(() => withAction({ kind: "nope" })).toThrow(/action kind/);
		expect(() => withAction({ kind: "set-field", field: "bad..path", value: "x" })).toThrow(
			/field path/,
		);
		expect(() => withAction({ kind: "set-field", field: "ok.path", value: 5 })).toThrow(/template/);
		expect(() => withAction({ kind: "set-field", field: "ok.path", value: "$bad" })).toThrow(
			/template/,
		);
		expect(() => withAction({ kind: "hook" })).toThrow(/hook id/);
		expect(() => withAction({ kind: "hook", hook: "has space" })).toThrow(/hook id/);
		// happy paths
		expect(withAction({ kind: "set-field", field: "a.b", value: "$event.x" })).toBeDefined();
		expect(withAction({ kind: "set-field", field: "a.b", value: "literal" })).toBeDefined();
		expect(withAction({ kind: "hook", hook: "my.hook-1" })).toBeDefined();
		expect(() =>
			assertFlowDef(
				{
					...base,
					states: {
						draft: {
							on: {
								submit: { target: "review", actions: "nope" as never },
							},
						},
						review: {},
						published: {},
					},
				},
				"ctx",
			),
		).toThrow(/actions must be an array/);
	});
});

describe("defineFlow / flowDefContribution", () => {
	it("returns the asserted def", () => {
		expect(defineFlow(base)).toEqual(base);
	});

	it("builds a JSON meta contribution", () => {
		const entry = flowDefContribution(base);
		expect(entry.kind).toBe(FLOW_DEF_KIND.id);
		expect(entry.id).toBe("doc-review");
		expect(entry.meta).toEqual(base);
		expect(JSON.parse(JSON.stringify(entry.meta))).toEqual(base);
	});
});

describe("toFlowDefinition / collectFlowDefinitions", () => {
	const plugin = (id: string, defs: readonly FlowDef[]): Plugin =>
		definePlugin({
			id,
			meta: { keywords: ["flows"] },
			contributions: defs.map(flowDefContribution),
		});

	it("stamps owner from the contributing plugin", () => {
		const def = toFlowDefinition(flowDefContribution(base), "plugin.owner");
		expect(def.owner).toBe("plugin.owner");
	});

	it("keeps an explicit owner", () => {
		const def = toFlowDefinition(
			flowDefContribution({ ...base, owner: "explicit" }),
			"plugin.owner",
		);
		expect(def.owner).toBe("explicit");
	});

	it("throws on malformed contributions", () => {
		expect(() => toFlowDefinition({ kind: "flow.def", id: "x", meta: { bad: true } }, "p")).toThrow(
			/must be an object|flow id/,
		);
	});

	it("collects across plugins in order", () => {
		const other: FlowDef = {
			id: "order-flow",
			collection: "orders",
			stateField: "stage",
			initial: "new",
			states: { new: {}, done: { final: true } },
		};
		const defs = collectFlowDefinitions([plugin("plugin.a", [base]), plugin("plugin.b", [other])]);
		expect(defs.map((d) => d.id)).toEqual(["doc-review", "order-flow"]);
		expect(defs[0]?.owner).toBe("plugin.a");
	});

	it("throws on duplicate flow ids", () => {
		expect(() =>
			collectFlowDefinitions([plugin("plugin.a", [base]), plugin("plugin.b", [base])]),
		).toThrow(/duplicate flow id/);
	});

	it("makeFlowDefinitions builds the service value", () => {
		const built = makeFlowDefinitions([plugin("plugin.a", [base])]);
		expect(built.flows).toHaveLength(1);
		expect(built.ownerIndex?.pkgById.get("plugin.a")).toBeUndefined();
		expect(makeFlowDefinitions([]).flows).toEqual([]);
	});
});

describe("buildDefOwnerIndex / defOwnerEnabled", () => {
	// Hand-built plugin rows — the index only reads id/pkg.
	const plugins = [
		{ id: "pkg.x.main", pkg: "pkg.x" },
		{ id: "pkg.x.extra", pkg: "pkg.x" },
		{ id: "solo.plugin" },
	] as unknown as Plugin[];
	const index = buildDefOwnerIndex(plugins);

	it("is package-granular: any enabled member keeps pkg-stamped owners live", () => {
		expect(defOwnerEnabled(index, "pkg.x.main", new Set(["pkg.x.extra"]))).toBe(true);
		expect(defOwnerEnabled(index, "pkg.x.main", new Set(["solo.plugin"]))).toBe(false);
		expect(defOwnerEnabled(index, "pkg.x.main", new Set())).toBe(false);
	});

	it("falls back to per-id for unstamped owners", () => {
		expect(defOwnerEnabled(index, "solo.plugin", new Set(["solo.plugin"]))).toBe(true);
		expect(defOwnerEnabled(index, "solo.plugin", new Set())).toBe(false);
	});

	it("unattributed or unindexed defs stay live", () => {
		expect(defOwnerEnabled(index, undefined, new Set())).toBe(true);
		expect(defOwnerEnabled(undefined, "pkg.x.main", new Set())).toBe(false);
		expect(defOwnerEnabled(undefined, "pkg.x.main", new Set(["pkg.x.main"]))).toBe(true);
	});
});
