import { describe, expect, it } from "vitest";

import { defineFlow, type FlowDef } from "./definition.ts";
import {
	currentState,
	planWrites,
	readState,
	resolveTemplate,
	resolveTransition,
	transitionScope,
	type TransitionResolution,
} from "./interpreter.ts";

const def: FlowDef = defineFlow({
	id: "doc-review",
	title: "Document review",
	collection: "documents",
	stateField: "status",
	initial: "draft",
	states: {
		draft: {
			on: {
				submit: {
					target: "review",
					guard: { path: "record.ready", op: "eq", value: true },
					actions: [
						{ kind: "set-field", field: "submittedBy", value: "$event.by" },
						{ kind: "set-field", field: "meta.seen", value: "$record.note" },
						{ kind: "hook", hook: "docs.submitted" },
					],
				},
			},
		},
		review: { on: { approve: { target: "published" } } },
		published: { final: true },
	},
});

const nested: FlowDef = defineFlow({
	id: "nested-flow",
	collection: "docs",
	stateField: "review.state",
	initial: "open",
	states: {
		open: { on: { close: { target: "done" } } },
		done: { final: true },
	},
});

describe("readState / currentState", () => {
	it("reads the stored stateField value", () => {
		expect(readState(def, { status: "review" })).toBe("review");
		expect(readState(nested, { review: { state: "done" } })).toBe("done");
	});

	it("returns undefined for absent/empty/non-string values", () => {
		expect(readState(def, {})).toBeUndefined();
		expect(readState(def, { status: "" })).toBeUndefined();
		expect(readState(def, { status: 3 })).toBeUndefined();
		expect(readState(def, { review: "not-an-object" })).toBeUndefined();
	});

	it("currentState falls back to initial only when absent/empty", () => {
		expect(currentState(def, {})).toBe("draft");
		expect(currentState(def, { status: "" })).toBe("draft");
		// a stored undeclared state is NOT silently reset to initial
		expect(currentState(def, { status: "bogus" })).toBe("bogus");
	});
});

describe("transitionScope", () => {
	it("builds record/event/flow scopes", () => {
		const scope = transitionScope(def, { status: "draft" }, { by: "u1" });
		expect(scope.record).toEqual({ status: "draft" });
		expect(scope.event).toEqual({ by: "u1" });
		expect(scope.flow).toEqual({ id: "doc-review", title: "Document review" });
	});

	it("wraps non-object payloads as { value }", () => {
		expect(transitionScope(def, {}, "raw").event).toEqual({ value: "raw" });
		expect(transitionScope(def, {}, undefined).event).toEqual({ value: undefined });
	});
});

describe("resolveTransition", () => {
	it("resolves a guarded transition", () => {
		const res = resolveTransition(def, { ready: true }, "submit", { by: "u1" });
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.from).toBe("draft");
			expect(res.to).toBe("review");
			expect(res.transition.target).toBe("review");
		}
	});

	it("rejects unknown-state for undeclared stored states", () => {
		const res = resolveTransition(def, { status: "bogus" }, "submit");
		expect(res).toMatchObject({ ok: false, reason: "unknown-state", state: "bogus" });
	});

	it("rejects no-transition for missing event handlers", () => {
		const res = resolveTransition(def, { status: "review" }, "submit");
		expect(res).toMatchObject({ ok: false, reason: "no-transition", state: "review" });
		// final states declare no `on` at all
		const fin = resolveTransition(def, { status: "published" }, "approve");
		expect(fin).toMatchObject({ ok: false, reason: "no-transition", state: "published" });
	});

	it("rejects guard-failed when the condition does not hold", () => {
		const res = resolveTransition(def, { ready: false }, "submit");
		expect(res).toMatchObject({ ok: false, reason: "guard-failed", state: "draft" });
		const missing = resolveTransition(def, {}, "submit");
		expect(missing).toMatchObject({ ok: false, reason: "guard-failed" });
	});

	it("evaluates guards over record/event/flow paths", () => {
		const gated: FlowDef = defineFlow({
			id: "gated",
			collection: "c",
			stateField: "s",
			initial: "a",
			states: {
				a: {
					on: {
						go: {
							target: "b",
							guard: {
								all: [
									{ path: "record.flag", op: "eq", value: true },
									{ path: "event.payload.n", op: "gte", value: 2 },
									{ path: "flow.id", op: "eq", value: "gated" },
								],
							},
						},
					},
				},
				b: {},
			},
		});
		expect(resolveTransition(gated, { flag: true }, "go", { payload: { n: 3 } }).ok).toBe(true);
		expect(resolveTransition(gated, { flag: true }, "go", { payload: { n: 1 } }).ok).toBe(false);
		expect(resolveTransition(gated, { flag: false }, "go", { n: 9 }).ok).toBe(false);
	});

	it("uses the stored stateField, not initial, when present", () => {
		const res = resolveTransition(def, { status: "review" }, "approve");
		expect(res).toMatchObject({ ok: true, from: "review", to: "published" });
	});
});

describe("resolveTemplate", () => {
	const scope = transitionScope(def, { note: "hi" }, { by: "u1", n: 4 });

	it("resolves $scope.path templates", () => {
		expect(resolveTemplate("$event.by", scope)).toBe("u1");
		expect(resolveTemplate("$record.note", scope)).toBe("hi");
		expect(resolveTemplate("$flow.id", scope)).toBe("doc-review");
		expect(resolveTemplate("$event.n", scope)).toBe(4);
	});

	it("passes literals and unresolvable templates through", () => {
		expect(resolveTemplate("plain", scope)).toBe("plain");
		expect(resolveTemplate("$event.missing", scope)).toBe("$event.missing");
		expect(resolveTemplate("$bogus.path", scope)).toBe("$bogus.path");
		expect(resolveTemplate("$event", scope)).toBe("$event");
	});
});

describe("planWrites", () => {
	it("folds set-field actions + stateField into one top-level patch", () => {
		const data = {
			status: "draft",
			ready: true,
			note: "hello",
			meta: { seen: "old", keep: 1 },
			extra: "x",
		};
		const resolution = resolveTransition(def, data, "submit", { by: "u1" });
		if (!resolution.ok) throw new Error("expected ok");
		const plan = planWrites(def, data, resolution);
		expect(plan.patch).toEqual({
			status: "review",
			submittedBy: "u1",
			meta: { seen: "hello", keep: 1 },
		});
		expect(plan.hookIds).toEqual(["docs.submitted"]);
		// the input data is never mutated
		expect(data.status).toBe("draft");
		expect(data.meta.seen).toBe("old");
	});

	it("writes nested stateField paths", () => {
		const data = { review: { state: "open", note: "n" } };
		const resolution = resolveTransition(nested, data, "close");
		if (!resolution.ok) throw new Error("expected ok");
		const plan = planWrites(nested, data, resolution);
		expect(plan.patch).toEqual({ review: { state: "done", note: "n" } });
		expect(plan.hookIds).toEqual([]);
	});

	it("creates intermediate objects for new nested paths", () => {
		const data = { status: "draft", ready: true };
		const resolution = resolveTransition(def, data, "submit", { by: "u2" });
		if (!resolution.ok) throw new Error("expected ok");
		const plan = planWrites(def, data, resolution);
		// `$record.note` is absent → the template passes through literally
		expect(plan.patch).toEqual({
			status: "review",
			submittedBy: "u2",
			meta: { seen: "$record.note" },
		});
	});

	it("stateField wins over a set-field targeting the same path", () => {
		const clash: FlowDef = defineFlow({
			id: "clash",
			collection: "c",
			stateField: "status",
			initial: "a",
			states: {
				a: {
					on: {
						go: {
							target: "b",
							actions: [{ kind: "set-field", field: "status", value: "hacked" }],
						},
					},
				},
				b: {},
			},
		});
		const resolution = resolveTransition(clash, { status: "a" }, "go");
		if (!resolution.ok) throw new Error("expected ok");
		const plan = planWrites(clash, { status: "a" }, resolution);
		expect(plan.patch.status).toBe("b");
	});

	it("diffs array values deeply — equal arrays stay out of the patch", () => {
		const arrFlow: FlowDef = defineFlow({
			id: "arr-flow",
			collection: "c",
			stateField: "s",
			initial: "a",
			states: {
				a: {
					on: {
						go: {
							target: "b",
							actions: [
								{ kind: "set-field", field: "same", value: "$event.same" },
								{ kind: "set-field", field: "diff", value: "$event.diff" },
								{ kind: "set-field", field: "scalar", value: "$event.scalar" },
							],
						},
					},
				},
				b: {},
			},
		});
		const data = { s: "a", same: [1, 2], diff: [1, 2], scalar: "old" };
		const resolution = resolveTransition(arrFlow, data, "go", {
			same: [1, 2],
			diff: [1, 2, 3],
			scalar: "new",
		});
		if (!resolution.ok) throw new Error("expected ok");
		const plan = planWrites(arrFlow, data, resolution);
		expect(plan.patch).toEqual({ s: "b", diff: [1, 2, 3], scalar: "new" });
	});

	it("creates arrays for numeric path segments", () => {
		const arrPath: FlowDef = defineFlow({
			id: "arr-path",
			collection: "c",
			stateField: "s",
			initial: "a",
			states: {
				a: {
					on: {
						go: {
							target: "b",
							actions: [{ kind: "set-field", field: "items.0.name", value: "first" }],
						},
					},
				},
				b: {},
			},
		});
		const resolution = resolveTransition(arrPath, { s: "a" }, "go");
		if (!resolution.ok) throw new Error("expected ok");
		const plan = planWrites(arrPath, { s: "a" }, resolution);
		expect(plan.patch).toEqual({ s: "b", items: [{ name: "first" }] });
	});

	it("ignores prototype-polluting paths on hand-built defs", () => {
		// Bypass defineFlow/assertFlowDef — the runtime guard is
		// defense-in-depth for defs that skipped validation.
		const evil = {
			id: "evil",
			collection: "c",
			stateField: "s",
			initial: "a",
			states: {
				a: {
					on: {
						go: {
							target: "b",
							actions: [{ kind: "set-field", field: "a.__proto__.polluted", value: "x" }],
						},
					},
				},
				b: {},
			},
		} as unknown as FlowDef;
		const resolution = resolveTransition(evil, { s: "a" }, "go");
		if (!resolution.ok) throw new Error("expected ok");
		const plan = planWrites(evil, { s: "a" }, resolution);
		// only the stateField write lands — the polluted path is dropped
		expect(plan.patch).toEqual({ s: "b" });
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("emits no patch keys for unchanged top-level values", () => {
		const quiet: FlowDef = defineFlow({
			id: "quiet",
			collection: "c",
			stateField: "s",
			initial: "a",
			states: {
				a: { on: { go: { target: "a", actions: [] } } },
			},
		});
		const resolution = resolveTransition(quiet, { s: "a", keep: { x: 1 } }, "go");
		if (!resolution.ok) throw new Error("expected ok");
		const plan = planWrites(quiet, { s: "a", keep: { x: 1 } }, resolution);
		// self-transition: stateField writes "a" over "a" — nothing changed
		expect(plan.patch).toEqual({});
	});
});

describe("type surface", () => {
	it("TransitionResolution is a discriminated union", () => {
		const res: TransitionResolution = resolveTransition(def, {}, "submit");
		expect(typeof res.ok).toBe("boolean");
	});
});
