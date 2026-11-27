import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
	builtinKinds,
	makeOrchestratorRegistry,
	OrchestratorRegistry,
	OrchestrationEvent,
	type JsonObject,
	type NodeContext,
	type OrchestrationDef,
	type OrchestrationNode,
	type OrchestrationRunResult,
} from "./index.ts";

const node = (
	id: string,
	kindId: string,
	on: readonly string[],
	extra?: Partial<OrchestrationNode>,
): OrchestrationNode => ({
	id,
	kind: kindId,
	on,
	emits: [],
	...extra,
});

const def = (
	id: string,
	nodes: readonly OrchestrationNode[],
	extra?: Partial<OrchestrationDef>,
) => ({
	id,
	nodes,
	...extra,
});

const registry = () => makeOrchestratorRegistry([...builtinKinds]);

const eventTypes = (result: OrchestrationRunResult): string[] =>
	result.events.map((event) => event.type);

const traceFor = (result: OrchestrationRunResult, nodeId: string) =>
	result.trace.filter((record) => record.nodeId === nodeId);

describe("poll kind", () => {
	it("emits a tick per fire with an incrementing count", async () => {
		const r = registry();
		r.registerDef(
			def("poll", [
				node("p", "poll", ["start", "p.tick"], {
					params: { intervalMs: 500 },
					maxFires: 3,
				}),
			]),
		);
		const result = await Effect.runPromise(r.run("poll"));
		const ticks = result.events.filter((e) => e.type === "p.tick");
		expect(ticks.map((e) => e.payload["count"])).toEqual([1, 2, 3]);
		expect(ticks[0]?.payload["intervalMs"]).toBe(500);
		expect(result.state["p"]).toEqual({ count: 3 });
		expect(eventTypes(result).at(-1)).toBe("workflow.done");
	});

	it("defaults the tick event to <nodeId>.tick and omits intervalMs", async () => {
		const r = registry();
		r.registerDef(
			def("poll-default", [node("watcher", "poll", ["start", "watcher.tick"], { maxFires: 2 })]),
		);
		const result = await Effect.runPromise(r.run("poll-default"));
		const ticks = result.events.filter((e) => e.type === "watcher.tick");
		expect(ticks).toHaveLength(2);
		expect(ticks[0]?.payload).toEqual({ count: 1 });
	});

	it("honors a custom emitEvent name", async () => {
		const r = registry();
		r.registerDef(
			def("poll-custom", [
				node("p", "poll", ["start", "custom.tick"], {
					params: { emitEvent: "custom.tick" },
					maxFires: 2,
				}),
			]),
		);
		const result = await Effect.runPromise(r.run("poll-custom"));
		expect(result.events.filter((e) => e.type === "custom.tick")).toHaveLength(2);
	});
});

describe("subworkflow kind", () => {
	it("runs a child def and routes on the outcome event", async () => {
		const r = registry();
		r.registerDef(
			def("child", [
				node("c", "emit", ["start"], {
					params: { events: [{ type: "child.done", payload: { ok: true } }] },
				}),
			]),
		);
		r.registerDef(
			def("parent", [
				node("sub", "subworkflow", ["start"], { params: { defId: "child" } }),
				node("sink", "emit", ["subworkflow.done"], {
					params: { events: [{ type: "parent.saw", payload: { routed: true } }] },
					maxFires: 1,
				}),
			]),
		);
		const result = await Effect.runPromise(
			r.run("parent").pipe(Effect.provideService(OrchestratorRegistry, r)),
		);
		expect(result.state["sub"]).toMatchObject({
			defId: "child",
			status: "done",
		});
		// The child's emit node returns no output, so its state is empty.
		expect((result.state["sub"] as { state: unknown }).state).toEqual({});
		expect(eventTypes(result)).toContain("parent.saw");
	});

	it("passes the triggering event verbatim by default (inputFrom event)", async () => {
		let seenType: string | undefined;
		let seenPayload: JsonObject | undefined;
		const r = makeOrchestratorRegistry([
			...builtinKinds,
			{
				id: "watch",
				run: (ctx: NodeContext) =>
					Effect.sync(() => {
						seenType = ctx.event.type;
						seenPayload = ctx.event.payload;
						return {};
					}),
			},
		]);
		r.registerDef(def("child2", [node("w", "watch", ["custom.go"])]));
		r.registerDef(
			def("parent2", [node("sub", "subworkflow", ["custom.go"], { params: { defId: "child2" } })]),
		);
		await Effect.runPromise(
			r
				.run("parent2", OrchestrationEvent.new("custom.go", { v: 5 }, "ext"))
				.pipe(Effect.provideService(OrchestratorRegistry, r)),
		);
		expect(seenType).toBe("custom.go");
		expect(seenPayload).toEqual({ v: 5 });
	});

	it("inputFrom state hands the run state to the child as an input event", async () => {
		let seenPayload: JsonObject | undefined;
		const r = makeOrchestratorRegistry([
			...builtinKinds,
			{
				id: "watch",
				run: (ctx: NodeContext) =>
					Effect.sync(() => {
						seenPayload = ctx.event.payload;
						return {};
					}),
			},
		]);
		r.registerDef(def("child3", [node("w", "watch", ["input"])]));
		r.registerDef(
			def("parent3", [
				node("sub", "subworkflow", ["start"], {
					params: { defId: "child3", inputFrom: "state" },
					state: { seeded: "yes" },
				}),
			]),
		);
		await Effect.runPromise(r.run("parent3").pipe(Effect.provideService(OrchestratorRegistry, r)));
		expect(seenPayload).toMatchObject({ seeded: "yes" });
	});

	it("nests to the default maxDepth and reports the innermost failure as status", async () => {
		const r = registry();
		// d0 → d1 → d2 → d3 → d4(terminal). Depths: d0's node runs at
		// depth 0, d1 at 1, d2 at 2, d3 at 3 — d3's subworkflow node hits
		// depth 3 >= maxDepth 3 and fails INSIDE d3's run, so d3's result
		// status is "failed" and that status propagates upward as data.
		r.registerDef(def("d4", [node("t", "emit", ["start"])]));
		r.registerDef(def("d3", [node("s", "subworkflow", ["start"], { params: { defId: "d4" } })]));
		r.registerDef(def("d2", [node("s", "subworkflow", ["start"], { params: { defId: "d3" } })]));
		r.registerDef(def("d1", [node("s", "subworkflow", ["start"], { params: { defId: "d2" } })]));
		r.registerDef(def("d0", [node("s", "subworkflow", ["start"], { params: { defId: "d1" } })]));
		const result = await Effect.runPromise(
			r.run("d0").pipe(Effect.provideService(OrchestratorRegistry, r)),
		);
		expect(result.status).toBe("done");
		// d0 sees d1 done; d1 sees d2 done; d2 sees d3 FAILED (its
		// subworkflow node hit depth 3 >= maxDepth inside d3's run).
		// Child run failures are data — status:"failed" — not errors.
		const l0 = result.state["s"] as {
			status: string;
			state: Record<string, { status: string; state: Record<string, { status: string }> }>;
		};
		expect(l0.status).toBe("done");
		expect(l0.state["s"]?.status).toBe("done");
		expect(l0.state["s"]?.state["s"]?.status).toBe("failed");
	});

	it("honors a custom maxDepth of 0 as an immediate node failure", async () => {
		const r = registry();
		r.registerDef(def("childx", [node("t", "emit", ["start"])]));
		r.registerDef(
			def(
				"parentx",
				[
					node("s", "subworkflow", ["start"], {
						params: { defId: "childx", maxDepth: 0 },
					}),
				],
				{ onNodeError: "continue" },
			),
		);
		const result = await Effect.runPromise(
			r.run("parentx").pipe(Effect.provideService(OrchestratorRegistry, r)),
		);
		expect(traceFor(result, "s")[0]?.error).toContain("exceeds maxDepth");
	});

	it("degrades to no-registry when OrchestratorRegistry is not ambient", async () => {
		const r = registry();
		r.registerDef(def("childy", [node("t", "emit", ["start"])]));
		r.registerDef(
			def("parenty", [
				node("s", "subworkflow", ["start"], { params: { defId: "childy" } }),
				node("sink", "emit", ["subworkflow.done"], {
					params: { events: [{ type: "routed", payload: {} }] },
					maxFires: 1,
				}),
			]),
		);
		// No Effect.provideService — the probe finds nothing.
		const result = await Effect.runPromise(r.run("parenty"));
		expect(result.state["s"]).toMatchObject({
			skipped: true,
			reason: "no-registry",
			defId: "childy",
		});
		expect(eventTypes(result)).toContain("routed");
	});

	it("fails the node when defId is missing or the child def is unknown", async () => {
		const r = registry();
		r.registerDef(
			def(
				"bad-sub",
				[
					node("missing", "subworkflow", ["start"], { params: {} }),
					node("ghost", "subworkflow", ["start"], { params: { defId: "nope" } }),
				],
				{ onNodeError: "continue" },
			),
		);
		const result = await Effect.runPromise(
			r.run("bad-sub").pipe(Effect.provideService(OrchestratorRegistry, r)),
		);
		expect(traceFor(result, "missing")[0]?.error).toContain("requires params.defId");
		expect(traceFor(result, "ghost")[0]?.error).toContain("subworkflow nope failed");
	});

	it("honors a custom emitEvent for the outcome", async () => {
		const r = registry();
		r.registerDef(def("childz", [node("t", "emit", ["start"])]));
		r.registerDef(
			def("parentz", [
				node("s", "subworkflow", ["start"], {
					params: { defId: "childz", emitEvent: "child.finished" },
				}),
				node("sink", "emit", ["child.finished"], {
					params: { events: [{ type: "seen", payload: {} }] },
					maxFires: 1,
				}),
			]),
		);
		const result = await Effect.runPromise(
			r.run("parentz").pipe(Effect.provideService(OrchestratorRegistry, r)),
		);
		const finished = result.events.find((e) => e.type === "child.finished");
		expect(finished?.payload).toMatchObject({ defId: "childz", status: "done" });
	});
});
