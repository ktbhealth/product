import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
	DuplicateKindError,
	DuplicateOrchestrationError,
	emitKind,
	gateKind,
	makeOrchestratorRegistry,
	NodeExecutionError,
	OrchestrationEvent,
	OrchestratorRegistry,
	OrchestratorRegistryLive,
	OrchestrationRunError,
	createOrchestrationSession,
	runOrchestration,
	UnknownKindError,
	UnknownOrchestrationError,
	type JsonObject,
	type KindResult,
	type NodeContext,
	type OrchestrationDef,
	type OrchestrationKind,
	type OrchestrationNode,
	type OrchestrationRunResult,
} from "./index.ts";

const kind = (
	id: string,
	run: (ctx: NodeContext) => Effect.Effect<KindResult, unknown, unknown>,
): OrchestrationKind => ({ id, run });

const succeed = (id: string, result: KindResult = {}): OrchestrationKind => ({
	id,
	run: () => Effect.succeed(result),
});

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

const eventTypes = (result: OrchestrationRunResult): string[] =>
	result.events.map((event) => event.type);

const traceFor = (result: OrchestrationRunResult, nodeId: string) =>
	result.trace.filter((record) => record.nodeId === nodeId);

describe("OrchestrationEvent constructors", () => {
	it("builds events with id, ts, type, payload and source", () => {
		const event = OrchestrationEvent.new("custom", { a: 1 }, "producer");
		expect(event).toMatchObject({
			type: "custom",
			payload: { a: 1 },
			source: "producer",
		});
		expect(event.id).toMatch(/^evt-/);
		expect(event.ts).toBeGreaterThan(0);
	});

	it("lifecycle constructors produce the reserved event types", () => {
		expect(OrchestrationEvent.start().type).toBe("start");
		expect(OrchestrationEvent.done().type).toBe("workflow.done");
		expect(OrchestrationEvent.cancel("why")).toMatchObject({
			type: "workflow.cancel",
			payload: { reason: "why" },
		});
		expect(OrchestrationEvent.nodeFailed("n", "e")).toMatchObject({
			type: "node.failed",
			payload: { nodeId: "n", error: "e" },
		});
		expect(OrchestrationEvent.nodeExhausted("n")).toMatchObject({
			type: "node.exhausted",
			payload: { nodeId: "n" },
		});
		expect(OrchestrationEvent.workflowFailed("n", "e")).toMatchObject({
			type: "workflow.failed",
			payload: { nodeId: "n", error: "e" },
		});
		expect(OrchestrationEvent.eventInvalid("bad", { extra: 1 })).toMatchObject({
			type: "event.invalid",
			payload: { message: "bad", extra: 1 },
		});
		expect(OrchestrationEvent.eventInvalid("bare").payload).toEqual({ message: "bare" });
	});
});

describe("makeOrchestratorRegistry", () => {
	it("registers, gets, lists and checks defs and kinds", () => {
		const r = makeOrchestratorRegistry([succeed("noop")]);
		const d = def("demo", [node("a", "noop", ["start"])]);
		r.registerDef(d);
		expect(r.get("demo")).toBe(d);
		expect(r.has("demo")).toBe(true);
		expect(r.has("nope")).toBe(false);
		expect(r.listDefs().map((x) => x.id)).toEqual(["demo"]);
		expect(r.listKinds().map((k) => k.id)).toEqual(["noop"]);
	});

	it("registerKind adds kinds after construction", () => {
		const r = makeOrchestratorRegistry();
		r.registerKind(succeed("late"));
		r.registerDef(def("d", [node("a", "late", ["start"])]));
		expect(r.listKinds().map((k) => k.id)).toEqual(["late"]);
	});

	it("throws DuplicateOrchestrationError on re-register", () => {
		const r = makeOrchestratorRegistry([succeed("k")]);
		r.registerDef(def("dup", [node("a", "k", [])]));
		expect(() => r.registerDef(def("dup", [node("b", "k", [])]))).toThrowError(
			DuplicateOrchestrationError,
		);
	});

	it("throws DuplicateKindError on duplicate kind ids", () => {
		expect(() => makeOrchestratorRegistry([succeed("k"), succeed("k")])).toThrowError(
			DuplicateKindError,
		);
		const r = makeOrchestratorRegistry();
		r.registerKind(succeed("k"));
		expect(() => r.registerKind(succeed("k"))).toThrowError(DuplicateKindError);
	});

	it("throws UnknownKindError when a node kind is not registered", () => {
		const r = makeOrchestratorRegistry();
		expect(() => r.registerDef(def("broken", [node("a", "ghost", ["start"])]))).toThrowError(
			UnknownKindError,
		);
		// A node with an inline handler does not need a registered kind.
		r.registerDef(def("inline", [{ ...node("a", "ghost", ["start"]), handler: succeed("ghost") }]));
		expect(r.has("inline")).toBe(true);
	});

	it("throws UnknownOrchestrationError on get of a missing id", () => {
		const r = makeOrchestratorRegistry();
		expect(() => r.get("nope")).toThrowError(UnknownOrchestrationError);
	});
});

describe("run", () => {
	it("routes a linear chain through events: start → x → y → done", async () => {
		const r = makeOrchestratorRegistry([
			kind("a", (ctx) => ctx.emit("x", { n: 1 }).pipe(Effect.as({}))),
			kind("b", (ctx) => ctx.emit("y", { seen: ctx.event.payload["n"] }).pipe(Effect.as({}))),
			kind("c", (ctx) => Effect.succeed({ output: { final: ctx.event.payload["seen"] } })),
		]);
		r.registerDef(
			def("chain", [node("a", "a", ["start"]), node("b", "b", ["x"]), node("c", "c", ["y"])]),
		);
		const result = await Effect.runPromise(r.run("chain"));
		expect(result.status).toBe("done");
		expect(eventTypes(result)).toEqual(["start", "x", "y", "workflow.done"]);
		expect(result.state["c"]).toEqual({ final: 1 });
		expect(result.events[1]?.source).toBe("a");
		expect(result.events[2]?.source).toBe("b");
		for (const record of result.trace) {
			expect(record.status).toBe("ok");
			expect(record.latencyMs).toBeGreaterThanOrEqual(0);
			expect(record.fires).toBe(1);
		}
	});

	it("fans out implicitly: one event triggers two branch nodes", async () => {
		const r = makeOrchestratorRegistry([
			kind("emit-two", (ctx) =>
				Effect.all([ctx.emit("left", {}), ctx.emit("right", {})]).pipe(Effect.as({})),
			),
			succeed("sink"),
		]);
		r.registerDef(
			def("branch", [
				node("root", "emit-two", ["start"]),
				node("left", "sink", ["left"]),
				node("right", "sink", ["right"]),
			]),
		);
		const result = await Effect.runPromise(r.run("branch"));
		expect(eventTypes(result)).toEqual(["start", "left", "right", "workflow.done"]);
		expect(traceFor(result, "left")).toHaveLength(1);
		expect(traceFor(result, "right")).toHaveLength(1);
	});

	it("mode any/all both fire once per matching event in phase 1", async () => {
		const r2 = makeOrchestratorRegistry([
			kind("emit-ab", (ctx) =>
				Effect.all([ctx.emit("a", {}), ctx.emit("b", {})]).pipe(Effect.as({})),
			),
			succeed("k"),
		]);
		r2.registerDef(
			def("modes2", [
				node("root", "emit-ab", ["start"]),
				node("any-node", "k", ["a", "b"], { mode: "any" }),
				node("all-node", "k", ["a", "b"], { mode: "all" }),
			]),
		);
		const result2 = await Effect.runPromise(r2.run("modes2"));
		for (const id of ["any-node", "all-node"]) {
			const records = traceFor(result2, id);
			expect(records).toHaveLength(2);
			expect(records.every((x) => x.status === "ok")).toBe(true);
		}
	});

	it("maxFires caps a self-sustaining node and emits node.exhausted", async () => {
		const r = makeOrchestratorRegistry([
			kind("loop", (ctx) =>
				ctx.event.type === "start" || ctx.event.type === "tick"
					? ctx.emit("tick", {}).pipe(Effect.as({}))
					: Effect.succeed({}),
			),
		]);
		r.registerDef(def("capped", [node("loopy", "loop", ["start", "tick"], { maxFires: 2 })]));
		const result = await Effect.runPromise(r.run("capped"));
		expect(result.status).toBe("done");
		// start fire + tick fire = 2 fires, then exhausted + retired.
		expect(traceFor(result, "loopy")).toHaveLength(2);
		expect(eventTypes(result)).toContain("node.exhausted");
		expect(eventTypes(result).at(-1)).toBe("workflow.done");
	});

	it("until retires a node when the listed event type occurs", async () => {
		const r = makeOrchestratorRegistry([
			kind("emit-three", (ctx) =>
				Effect.all([ctx.emit("go", { n: 1 }), ctx.emit("stop", {}), ctx.emit("go", { n: 2 })]).pipe(
					Effect.as({}),
				),
			),
			kind("worker", (ctx) => Effect.succeed({ output: ctx.event.payload["n"] })),
		]);
		r.registerDef(
			def("until", [
				node("root", "emit-three", ["start"]),
				node("worker", "worker", ["go"], { until: ["stop"] }),
			]),
		);
		const result = await Effect.runPromise(r.run("until"));
		// worker fires on the first "go", retires on "stop", ignores the second.
		expect(traceFor(result, "worker")).toHaveLength(1);
		expect(result.state["worker"]).toBe(1);
	});

	it("retireOn retires a node on the listed event type", async () => {
		const r = makeOrchestratorRegistry([
			kind("emit-pair", (ctx) =>
				Effect.all([ctx.emit("go", {}), ctx.emit("halt", {})]).pipe(Effect.as({})),
			),
			succeed("k"),
		]);
		r.registerDef(
			def("retire", [
				node("root", "emit-pair", ["start"]),
				node("w", "k", ["go", "halt"], { retireOn: ["halt"] }),
			]),
		);
		const result = await Effect.runPromise(r.run("retire"));
		// "go" fires w; "halt" retires it before it can fire on "halt".
		expect(traceFor(result, "w")).toHaveLength(1);
	});

	it("retries a failing kind and succeeds within maxAttempts", async () => {
		let attempts = 0;
		const r = makeOrchestratorRegistry([
			kind("flaky", () => {
				attempts += 1;
				return attempts < 3
					? Effect.fail(new NodeExecutionError({ nodeId: "flaky", message: "transient" }))
					: Effect.succeed({ output: "recovered" });
			}),
		]);
		r.registerDef(
			def("retry", [
				node("flaky", "flaky", ["start"], { retry: { maxAttempts: 3, backoffMs: 1 } }),
			]),
		);
		const result = await Effect.runPromise(r.run("retry"));
		expect(attempts).toBe(3);
		expect(result.status).toBe("done");
		expect(result.state["flaky"]).toBe("recovered");
		expect(traceFor(result, "flaky")[0]?.status).toBe("ok");
	});

	it("retry defaults to 3 attempts / 100ms backoff when only retry is present", async () => {
		let attempts = 0;
		const r = makeOrchestratorRegistry([
			kind("flaky-default", () => {
				attempts += 1;
				return attempts < 3
					? Effect.fail(new NodeExecutionError({ nodeId: "f", message: "t" }))
					: Effect.succeed({});
			}),
		]);
		r.registerDef(def("retry-default", [node("f", "flaky-default", ["start"], { retry: {} })]));
		// backoffMs defaults to 100 — keep the test fast by succeeding on
		// attempt 3 anyway; two ~100ms sleeps are acceptable.
		const result = await Effect.runPromise(r.run("retry-default"));
		expect(attempts).toBe(3);
		expect(result.status).toBe("done");
	});

	it("circuit breaker opens with the default cooldown when only the threshold is set", async () => {
		const r = makeOrchestratorRegistry([
			kind("emit-two-fails", (ctx) =>
				Effect.all([ctx.emit("f", {}), ctx.emit("f", {})]).pipe(Effect.as({})),
			),
			kind("bad2", () => Effect.fail(new NodeExecutionError({ nodeId: "bad2", message: "x" }))),
		]);
		r.registerDef(
			def(
				"breaker-default",
				[
					node("root", "emit-two-fails", ["start"]),
					node("bad2", "bad2", ["f"], { circuitBreaker: { failureThreshold: 1 } }),
				],
				{ onNodeError: "continue" },
			),
		);
		const result = await Effect.runPromise(r.run("breaker-default"));
		const records = traceFor(result, "bad2");
		// First failure opens the circuit (threshold 1); second event skipped.
		expect(records.map((x) => x.status)).toEqual(["failed", "skipped"]);
	});

	it("fails the node after exhausting retries", async () => {
		let attempts = 0;
		const r = makeOrchestratorRegistry([
			kind("always-bad", () => {
				attempts += 1;
				return Effect.fail(new NodeExecutionError({ nodeId: "always-bad", message: "nope" }));
			}),
		]);
		r.registerDef(
			def(
				"retry-fail",
				[
					node("bad", "always-bad", ["start"], {
						retry: { maxAttempts: 2, backoffMs: 1 },
					}),
				],
				{ onNodeError: "continue" },
			),
		);
		const result = await Effect.runPromise(r.run("retry-fail"));
		expect(attempts).toBe(2);
		expect(result.status).toBe("done");
		expect(traceFor(result, "bad")[0]).toMatchObject({ status: "failed", error: "nope" });
		expect(eventTypes(result)).toContain("node.failed");
	});

	it("fanIn count joins N events and merges payloads in order", async () => {
		let seen: JsonObject | undefined;
		const r = makeOrchestratorRegistry([
			kind("emit-parts", (ctx) =>
				Effect.all([
					ctx.emit("part", { n: 1 }),
					ctx.emit("part", { n: 2 }),
					ctx.emit("part", { n: 3 }),
				]).pipe(Effect.as({})),
			),
			kind("join", (ctx) => {
				seen = ctx.event.payload;
				return Effect.succeed({ output: { joined: true } });
			}),
		]);
		r.registerDef(
			def("join", [
				node("root", "emit-parts", ["start"]),
				node("joiner", "join", ["part"], { fanIn: { count: 2 } }),
			]),
		);
		const result = await Effect.runPromise(r.run("join"));
		// 3 parts / count 2 → fires once after parts 1+2, buffer resets,
		// part 3 waits for a fourth that never comes.
		expect(traceFor(result, "joiner")).toHaveLength(1);
		expect(seen?.["n"]).toBe(2);
		expect(seen?.["events"]).toEqual([{ n: 1 }, { n: 2 }]);
		expect(seen?.["eventTypes"]).toEqual(["part", "part"]);
		expect(result.state["joiner"]).toEqual({ joined: true });
	});

	it("fanIn until waits for every listed event type", async () => {
		let fires = 0;
		const r = makeOrchestratorRegistry([
			kind("emit-mix", (ctx) =>
				Effect.all([ctx.emit("a-type", {}), ctx.emit("b-type", {})]).pipe(Effect.as({})),
			),
			kind("waiter", () => {
				fires += 1;
				return Effect.succeed({});
			}),
		]);
		r.registerDef(
			def("until-join", [
				node("root", "emit-mix", ["start"]),
				node("waiter", "waiter", ["a-type", "b-type"], {
					fanIn: { until: ["a-type", "b-type"] },
				}),
			]),
		);
		const result = await Effect.runPromise(r.run("until-join"));
		expect(fires).toBe(1);
		expect(traceFor(result, "waiter")).toHaveLength(1);
	});

	it("opens the circuit breaker after consecutive failures and skips fires", async () => {
		const r = makeOrchestratorRegistry([
			kind("emit-fails", (ctx) =>
				Effect.all([ctx.emit("fail", {}), ctx.emit("fail", {}), ctx.emit("fail", {})]).pipe(
					Effect.as({}),
				),
			),
			kind("bad", () => Effect.fail(new NodeExecutionError({ nodeId: "bad", message: "kaput" }))),
		]);
		r.registerDef(
			def(
				"breaker",
				[
					node("root", "emit-fails", ["start"]),
					node("bad", "bad", ["fail"], {
						circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
					}),
				],
				{ onNodeError: "continue" },
			),
		);
		const result = await Effect.runPromise(r.run("breaker"));
		const records = traceFor(result, "bad");
		expect(records.map((x) => x.status)).toEqual(["failed", "failed", "skipped"]);
		expect(eventTypes(result).filter((t) => t === "node.failed")).toHaveLength(2);
	});

	it("halts on node failure by default with node.failed + workflow.failed", async () => {
		const r = makeOrchestratorRegistry([
			kind("bad", () => Effect.fail(new NodeExecutionError({ nodeId: "bad", message: "boom" }))),
			succeed("never"),
		]);
		r.registerDef(
			def("halt", [node("bad", "bad", ["start"]), node("after", "never", ["workflow.failed"])]),
		);
		const result = await Effect.runPromise(r.run("halt"));
		expect(result.status).toBe("failed");
		expect(eventTypes(result).slice(-2)).toEqual(["node.failed", "workflow.failed"]);
		expect(result.events.at(-1)?.payload["nodeId"]).toBe("bad");
		expect(traceFor(result, "bad")[0]).toMatchObject({ status: "failed", error: "boom" });
		// The halt path records lifecycle events directly — "after" never fires.
		expect(traceFor(result, "after")).toHaveLength(0);
	});

	it("continues on node failure under onNodeError continue and routes node.failed", async () => {
		const r = makeOrchestratorRegistry([
			kind("bad", () => Effect.fail(new NodeExecutionError({ nodeId: "bad", message: "soft" }))),
			succeed("observer"),
		]);
		r.registerDef(
			def(
				"continue",
				[node("bad", "bad", ["start"]), node("observer", "observer", ["node.failed"])],
				{ onNodeError: "continue" },
			),
		);
		const result = await Effect.runPromise(r.run("continue"));
		expect(result.status).toBe("done");
		expect(traceFor(result, "observer")).toHaveLength(1);
	});

	it("normalizes foreign kind failures into the node-failure path", async () => {
		const r = makeOrchestratorRegistry([kind("foreign", () => Effect.fail("string failure"))]);
		r.registerDef(def("foreign", [node("f", "foreign", ["start"])], { onNodeError: "continue" }));
		const result = await Effect.runPromise(r.run("foreign"));
		expect(result.status).toBe("done");
		expect(traceFor(result, "f")[0]).toMatchObject({ status: "failed", error: "string failure" });
	});

	it("converts a synchronous throw from kind.run into a node failure", async () => {
		const r = makeOrchestratorRegistry([
			kind("thrower", () => {
				throw new Error("sync boom");
			}),
		]);
		r.registerDef(def("thrower", [node("t", "thrower", ["start"])], { onNodeError: "continue" }));
		const result = await Effect.runPromise(r.run("thrower"));
		expect(traceFor(result, "t")[0]).toMatchObject({ status: "failed", error: "sync boom" });
	});

	it("fails the run when the event budget is exceeded", async () => {
		const r = makeOrchestratorRegistry([
			kind("ping", (ctx) =>
				ctx.event.type === "a"
					? ctx.emit("b", {}).pipe(Effect.as({}))
					: ctx.emit("a", {}).pipe(Effect.as({})),
			),
		]);
		r.registerDef(def("loop", [node("pinger", "ping", ["start", "a", "b"])]));
		const error = await Effect.runPromise(Effect.flip(r.run("loop", undefined, { maxEvents: 8 })));
		expect(error).toBeInstanceOf(OrchestrationRunError);
		expect(error.message).toContain("event budget exceeded");
		expect(error.trace.length).toBeGreaterThan(0);
	});

	it("cancels the run on a workflow.cancel event", async () => {
		const r = makeOrchestratorRegistry([
			kind("canceller", (ctx) =>
				ctx.emit("workflow.cancel", { reason: "user" }).pipe(Effect.as({})),
			),
			succeed("k"),
		]);
		r.registerDef(
			def("cancel", [node("c", "canceller", ["start"]), node("late", "k", ["workflow.cancel"])]),
		);
		const result = await Effect.runPromise(r.run("cancel"));
		expect(result.status).toBe("cancelled");
		expect(traceFor(result, "late")).toHaveLength(0);
	});

	it("uses an injected OrchestrationEvent as the initial event", async () => {
		let source: string | undefined;
		const r = makeOrchestratorRegistry([
			kind("watch", (ctx) => {
				source = ctx.event.source;
				return Effect.succeed({ output: ctx.event.payload["v"] });
			}),
		]);
		r.registerDef(def("inject", [node("w", "watch", ["custom.trigger"])]));
		const trigger = OrchestrationEvent.new("custom.trigger", { v: 42 }, "external-system");
		const result = await Effect.runPromise(r.run("inject", trigger));
		expect(source).toBe("external-system");
		expect(result.state["w"]).toBe(42);
	});

	it("fails with OrchestrationRunError on an unknown orchestration id", async () => {
		const r = makeOrchestratorRegistry();
		const error = await Effect.runPromise(Effect.flip(r.run("ghost")));
		expect(error).toBeInstanceOf(OrchestrationRunError);
		expect(error).toMatchObject({ orchestrationId: "ghost", trace: [] });
	});

	it("fails with OrchestrationRunError when runOrchestration sees an unknown kind", async () => {
		const error = await Effect.runPromise(
			Effect.flip(runOrchestration(def("direct", [node("a", "ghost", ["start"])]), new Map())),
		);
		expect(error).toBeInstanceOf(OrchestrationRunError);
		expect(error.message).toContain("unknown kind");
	});

	it("wraps non-object run input as {value} on an input event", async () => {
		let payload: JsonObject | undefined;
		const r = makeOrchestratorRegistry([
			kind("watch", (ctx) => {
				payload = ctx.event.payload;
				return Effect.succeed({});
			}),
		]);
		r.registerDef(def("wrap", [node("w", "watch", ["input"])]));
		const result = await Effect.runPromise(r.run("wrap", 42));
		expect(payload).toEqual({ value: 42 });
		expect(result.events[0]?.type).toBe("input");
	});

	it("uses a plain object run input as the input event payload", async () => {
		let payload: JsonObject | undefined;
		const r = makeOrchestratorRegistry([
			kind("watch", (ctx) => {
				payload = ctx.event.payload;
				return Effect.succeed({});
			}),
		]);
		r.registerDef(def("obj", [node("w", "watch", ["input"])]));
		await Effect.runPromise(r.run("obj", { direct: true }));
		expect(payload).toEqual({ direct: true });
	});

	it("merges node.state into the initial run state and config over def.config", async () => {
		let seenState: unknown;
		let seenConfig: unknown;
		const r = makeOrchestratorRegistry([
			kind("inspect", (ctx) => {
				seenState = ctx.state["seed"];
				seenConfig = ctx.config["level"];
				return Effect.succeed({ state: { wrote: true } });
			}),
		]);
		r.registerDef(
			def("cfg", [node("i", "inspect", ["start"], { state: { seed: "from-node" } })], {
				config: { level: "def" },
			}),
		);
		await Effect.runPromise(r.run("cfg", undefined, { config: { level: "run" } }));
		expect(seenState).toBe("from-node");
		expect(seenConfig).toBe("run");
	});

	it("returns KindResult.events as emitted events with the node as source", async () => {
		const r = makeOrchestratorRegistry([
			kind("multi", () =>
				Effect.succeed({
					events: [{ type: "e1", payload: { a: 1 } }, { type: "e2" }],
				}),
			),
			succeed("k"),
		]);
		r.registerDef(
			def("events-out", [
				node("m", "multi", ["start"]),
				node("s1", "k", ["e1"]),
				node("s2", "k", ["e2"]),
			]),
		);
		const result = await Effect.runPromise(r.run("events-out"));
		expect(eventTypes(result)).toEqual(["start", "e1", "e2", "workflow.done"]);
		expect(result.events[1]?.source).toBe("m");
		expect(result.events[2]?.payload).toEqual({});
	});
});

describe("builtin kinds", () => {
	const registry = () => makeOrchestratorRegistry([emitKind, gateKind]);

	it("emit kind emits the literal events from params.events", async () => {
		const r = registry();
		r.registerDef(
			def("emit", [
				node("e", "emit", ["start"], {
					params: { events: [{ type: "ping", payload: { x: 1 } }, { type: "pong" }] },
				}),
				node("s", "emit", ["ping", "pong"], { maxFires: 2 }),
			]),
		);
		const result = await Effect.runPromise(r.run("emit"));
		// "s" hits its maxFires cap on the second event and retires.
		expect(eventTypes(result)).toEqual([
			"start",
			"ping",
			"pong",
			"node.exhausted",
			"workflow.done",
		]);
	});

	it("emit kind tolerates malformed params.events", async () => {
		const r = registry();
		r.registerDef(
			def("emit-bad", [
				node("e", "emit", ["start"], {
					params: { events: "not-an-array" },
				}),
				node("e2", "emit", ["start"], {
					params: {
						events: [
							{ type: 7 },
							"junk",
							{ type: "ok", payload: { v: 1 } },
							{ type: "arr", payload: [1, 2] },
						],
					},
				}),
				node("sink", "emit", ["ok", "arr"]),
			]),
		);
		const result = await Effect.runPromise(r.run("emit-bad"));
		// Only the well-formed specs emitted; non-string types,
		// non-object specs and non-object payloads are tolerated.
		expect(eventTypes(result)).toEqual(["start", "ok", "arr", "workflow.done"]);
		expect(traceFor(result, "sink")).toHaveLength(2);
	});

	it("gate kind compares object literals by value and misses deep paths", async () => {
		const r = registry();
		r.registerDef(
			def("gate-deep", [
				node("g", "gate", ["go"], {
					params: {
						when: { path: "payload.cfg", equals: { a: 1 } },
						passEvent: "yes",
						failEvent: "no",
					},
				}),
				node("miss", "gate", ["go"], {
					params: { when: { path: "payload.a.b.c", equals: 1 } },
				}),
			]),
		);
		const result = await Effect.runPromise(
			r.run("gate-deep", OrchestrationEvent.new("go", { cfg: { a: 1 }, a: 5 }, "test")),
		);
		expect(eventTypes(result)).toContain("yes");
		// "miss" resolved payload.a.b.c through a non-object intermediate
		// → undefined → gate.fail emitted.
		expect(eventTypes(result)).toContain("gate.fail");
	});

	it("gate kind treats unserializable equals as non-equal", async () => {
		const circular: Record<string, unknown> = {};
		circular["self"] = circular;
		const r = registry();
		r.registerDef(
			def("gate-circular", [
				node("g", "gate", ["go"], {
					params: {
						when: { path: "payload.x", equals: circular as JsonObject },
						passEvent: "yes",
						failEvent: "no",
					},
				}),
			]),
		);
		const result = await Effect.runPromise(
			r.run("gate-circular", OrchestrationEvent.new("go", { x: { a: 1 } }, "test")),
		);
		// JSON.stringify throws on the circular `equals` → looseEquals
		// returns false → fail branch.
		expect(eventTypes(result)).toContain("no");
	});

	it("gate kind routes pass/fail branches", async () => {
		const r = registry();
		r.registerDef(
			def("gate", [
				node("g", "gate", ["go"], {
					params: { when: { path: "ok", equals: true }, passEvent: "yes", failEvent: "no" },
				}),
				node("pass-sink", "emit", ["yes"]),
				node("fail-sink", "emit", ["no"]),
			]),
		);
		const pass = await Effect.runPromise(
			r.run("gate", OrchestrationEvent.new("go", { ok: true }, "test")),
		);
		expect(eventTypes(pass)).toContain("yes");
		expect(traceFor(pass, "pass-sink")).toHaveLength(1);
		expect(traceFor(pass, "fail-sink")).toHaveLength(0);

		const fail = await Effect.runPromise(
			r.run("gate", OrchestrationEvent.new("go", { ok: false }, "test")),
		);
		expect(eventTypes(fail)).toContain("no");
		expect(traceFor(fail, "fail-sink")).toHaveLength(1);
	});

	it("gate kind falls back to defaults for missing/malformed params", async () => {
		const r = registry();
		r.registerDef(
			def("gate-defaults", [
				node("g", "gate", ["go"], {
					// No `when`, no passEvent/failEvent — path resolves to ""
					// (missing everywhere → undefined), equals is absent
					// (undefined === undefined → pass), defaults emit
					// "gate.pass".
					params: {},
				}),
			]),
		);
		const result = await Effect.runPromise(
			r.run("gate-defaults", OrchestrationEvent.new("go", {}, "test")),
		);
		expect(eventTypes(result)).toContain("gate.pass");
		expect(result.state["g"]).toMatchObject({ result: "pass", path: "" });
	});
});

describe("OrchestratorRegistry service + live layer", () => {
	it("resolves through the service tag", async () => {
		const program = Effect.gen(function* () {
			const registry = yield* OrchestratorRegistry;
			registry.registerKind(succeed("svc-kind"));
			registry.registerDef(def("via-service", [node("a", "svc-kind", ["start"])]));
			return yield* registry.run("via-service");
		});
		const result = await Effect.runPromise(
			program.pipe(Effect.provide(OrchestratorRegistryLive([]))),
		);
		expect(result.status).toBe("done");
	});

	it("OrchestratorRegistryLive registers seed kinds and defs", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const registry = yield* OrchestratorRegistry;
				expect(registry.listDefs().map((d) => d.id)).toEqual(["seeded"]);
				return yield* registry.run("seeded");
			}).pipe(
				Effect.provide(
					OrchestratorRegistryLive([succeed("k")], [def("seeded", [node("a", "k", ["start"])])]),
				),
			),
		);
		expect(result.status).toBe("done");
	});

	it("OrchestratorRegistryLive surfaces registration errors as typed failures", async () => {
		const bad = OrchestratorRegistryLive(
			[succeed("k")],
			[def("dup", [node("a", "k", [])]), def("dup", [node("b", "k", [])])],
		);
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				yield* OrchestratorRegistry;
				return "unreachable";
			}).pipe(Effect.provide(bad), Effect.exit),
		);
		const squashed = exit._tag === "Failure" ? Cause.squash(exit.cause) : exit;
		expect(squashed).toBeInstanceOf(DuplicateOrchestrationError);
	});

	it("OrchestratorRegistryLive surfaces duplicate seed kinds as typed failures", async () => {
		const bad = OrchestratorRegistryLive([succeed("k"), succeed("k")]);
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				yield* OrchestratorRegistry;
				return "unreachable";
			}).pipe(Effect.provide(bad), Effect.exit),
		);
		const squashed = exit._tag === "Failure" ? Cause.squash(exit.cause) : exit;
		expect(squashed).toBeInstanceOf(DuplicateKindError);
	});
});

describe("delayed routing (notBefore)", () => {
	it("holds not-yet-due events out of routing and reports nextWakeAt", async () => {
		const delayEmit = kind("delay-emit", () =>
			Effect.succeed({
				events: [
					{ type: "wake", payload: {}, notBefore: Date.now() + 60_000 },
					{ type: "now", payload: {} },
				],
			}),
		);
		const seen: string[] = [];
		const sink = kind("sink", (ctx) =>
			Effect.sync(() => {
				seen.push(ctx.event.type);
				return {};
			}),
		);
		const session = await Effect.runPromise(
			createOrchestrationSession(
				def("d", [node("a", "delay-emit", ["start"]), node("b", "sink", ["wake", "now"])]),
				new Map([
					["delay-emit", delayEmit],
					["sink", sink],
				]),
			),
		);
		await Effect.runPromise(session.step());
		// "now" routed; "wake" is still pending — the run is NOT finished
		// (quiescence waits for delayed events too).
		expect(seen).toEqual(["now"]);
		expect(session.isFinished()).toBe(false);
		expect(session.pendingEvents().map((e) => e.type)).toEqual(["wake"]);
		const wakeAt = session.nextWakeAt();
		expect(wakeAt).not.toBeNull();
		expect(wakeAt as number).toBeGreaterThan(Date.now());
		// A second step changes nothing until the wake instant.
		await Effect.runPromise(session.step());
		expect(seen).toEqual(["now"]);
	});

	it("routes a delayed event once its notBefore has passed", async () => {
		const delayEmit = kind("delay-emit", () =>
			Effect.succeed({
				events: [{ type: "wake", payload: {}, notBefore: Date.now() + 30 }],
			}),
		);
		const seen: string[] = [];
		const sink = kind("sink", (ctx) =>
			Effect.sync(() => {
				seen.push(ctx.event.type);
				return {};
			}),
		);
		const session = await Effect.runPromise(
			createOrchestrationSession(
				def("d", [node("a", "delay-emit", ["start"]), node("b", "sink", ["wake"])]),
				new Map([
					["delay-emit", delayEmit],
					["sink", sink],
				]),
			),
		);
		await Effect.runPromise(session.step());
		expect(seen).toEqual([]);
		await Effect.runPromise(Effect.sleep(50));
		await Effect.runPromise(session.step());
		expect(seen).toEqual(["wake"]);
	});

	it("nextWakeAt is null when due work remains queued", async () => {
		const mixed = kind("mixed", () =>
			Effect.succeed({
				events: [
					{ type: "later", payload: {}, notBefore: Date.now() + 60_000 },
					{ type: "soon", payload: {} },
				],
			}),
		);
		// batchSize 1: step stops after the first event with "soon"
		// still queued → next step must run immediately.
		const session = await Effect.runPromise(
			createOrchestrationSession(
				def("d", [node("a", "mixed", ["start"])]),
				new Map([["mixed", mixed]]),
			),
		);
		await Effect.runPromise(session.step(1));
		expect(session.pendingEvents().map((e) => e.type)).toEqual(["later", "soon"]);
		expect(session.nextWakeAt()).toBeNull();
	});
});
