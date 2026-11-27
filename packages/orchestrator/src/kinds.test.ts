import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import {
	AmbientAsrPort,
	AmbientDecisionsPort,
	AmbientLlmPort,
	AmbientPlatformDecisions,
	AmbientPlatformLlm,
	builtinKinds,
	makeOrchestratorRegistry,
	OrchestratorRegistry,
	OrchestrationEvent,
	type AmbientAsrPortShape,
	type AmbientDecisionsPortShape,
	type AmbientLlmPortShape,
	type AmbientPlatformDecisionsShape,
	type AmbientPlatformLlmShape,
	type AmbientTaskEnvelope,
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

const llmCapture = () => {
	const envelopes: AmbientTaskEnvelope[] = [];
	const port: AmbientLlmPortShape = {
		generate: (envelope) => {
			envelopes.push(envelope);
			return Effect.succeed({ text: `echo:${envelope.input}`, record: { engine: "stub" } });
		},
	};
	return { envelopes, port };
};

const decisionsCapture = () => {
	const calls: { state: unknown; questions: readonly unknown[] }[] = [];
	const port: AmbientDecisionsPortShape = {
		judge: (input) => {
			calls.push(input);
			return Effect.succeed({ answers: [{ verdict: "yes" }], record: { engine: "stub" } });
		},
	};
	return { calls, port };
};

const asrCapture = () => {
	const calls: { audio: unknown; opts: unknown }[] = [];
	const port: AmbientAsrPortShape = {
		transcribe: (audio, opts) => {
			calls.push({ audio, opts });
			return Effect.succeed({ asr: { text: "oi", segments: [] }, record: { engine: "stub" } });
		},
	};
	return { calls, port };
};

describe("ai kind — llm", () => {
	it("calls a directly-bound LlmPort and emits the result", async () => {
		const { envelopes, port } = llmCapture();
		const r = registry();
		r.registerDef(
			def("llm", [
				node("a", "ai", ["start"], {
					params: {
						template: "Summarize ${event.payload.topic}",
						model: "gpt-x",
						outputSchema: "Summary",
						emitEvent: "llm.result",
						input: { seed: 7 },
					},
				}),
				node("sink", "emit", ["llm.result"], {
					params: { events: [{ type: "seen", payload: { routed: true } }] },
				}),
			]),
		);
		const result = await Effect.runPromise(
			r
				.run("llm", OrchestrationEvent.new("start", { topic: "cardiology" }, "test"))
				.pipe(Effect.provideService(AmbientLlmPort, port)),
		);
		expect(envelopes).toHaveLength(1);
		const envelope = envelopes[0] as AmbientTaskEnvelope;
		expect(envelope.role).toBe("generator");
		expect(envelope.input).toBe("Summarize cardiology");
		expect(envelope.modelHint).toBe("gpt-x");
		expect(envelope.outputSchema).toBe("Summary");
		expect(envelope.seed).toBe(7);
		expect(envelope.taskId).toContain("orch-a-");
		expect(result.state["a"]).toMatchObject({ text: "echo:Summarize cardiology" });
		expect(eventTypes(result)).toEqual(["start", "llm.result", "seen", "workflow.done"]);
		expect(result.events[1]?.payload).toMatchObject({ text: "echo:Summarize cardiology" });
	});

	it("interpolates every placeholder scope and tolerates misses", async () => {
		const { envelopes, port } = llmCapture();
		const circular: Record<string, unknown> = {};
		circular["self"] = circular;
		const r = registry();
		r.registerDef(
			def("interp", [
				node("a", "ai", ["start"], {
					state: { user: { name: "Ana" }, obj: { a: 1 }, circular: circular as JsonObject },
					params: {
						template:
							"u=${state.user.name} n=${event.payload.num} b=${config.debug}" +
							" t=${params.tag} node=${node.id} miss=${event.payload.nope}" +
							" nil=${event.payload.nothing} obj=${state.obj} circ=${state.circular}",
						tag: "T1",
					},
				}),
			]),
		);
		await Effect.runPromise(
			r
				.run("interp", OrchestrationEvent.new("start", { num: 42, nothing: null }, "test"), {
					config: { debug: true },
				})
				.pipe(Effect.provideService(AmbientLlmPort, port)),
		);
		expect(envelopes[0]?.input).toBe('u=Ana n=42 b=true t=T1 node=a miss= nil= obj={"a":1} circ=');
	});

	it("deep-interpolates string leaves inside params.input", async () => {
		const { calls, port } = decisionsCapture();
		const r = registry();
		r.registerDef(
			def("dec-input", [
				node("d", "ai", ["go"], {
					params: {
						kind: "decide",
						template: "prompt ${event.payload.x}",
						qq: "Q1",
						input: {
							state: { q: "${event.payload.x}" },
							questions: ["${params.qq}"],
							n: 5,
							flag: true,
							nil: null,
						},
					},
				}),
			]),
		);
		await Effect.runPromise(
			r
				.run("dec-input", OrchestrationEvent.new("go", { x: 7 }, "test"))
				.pipe(Effect.provideService(AmbientDecisionsPort, port)),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.state).toEqual({ q: "7" });
		expect(calls[0]?.questions).toEqual(["Q1"]);
	});

	it("uses {prompt} as judge state and [] questions when input is absent", async () => {
		const { calls, port } = decisionsCapture();
		const r = registry();
		r.registerDef(
			def("dec-default", [
				node("d", "ai", ["go"], {
					params: { kind: "decide", template: "hello ${event.payload.x}" },
				}),
			]),
		);
		const result = await Effect.runPromise(
			r
				.run("dec-default", OrchestrationEvent.new("go", { x: 9 }, "test"))
				.pipe(Effect.provideService(AmbientDecisionsPort, port)),
		);
		expect(calls[0]?.state).toEqual({ prompt: "hello 9" });
		expect(calls[0]?.questions).toEqual([]);
		expect(result.state["d"]).toMatchObject({ answers: [{ verdict: "yes" }] });
	});

	it("treats input without state/questions as the judge state verbatim", async () => {
		const { calls, port } = decisionsCapture();
		const r = registry();
		r.registerDef(
			def("dec-plain", [
				node("d", "ai", ["go"], {
					params: { kind: "decide", input: { foo: "bar ${event.payload.x}" } },
				}),
			]),
		);
		await Effect.runPromise(
			r
				.run("dec-plain", OrchestrationEvent.new("go", { x: 3 }, "test"))
				.pipe(Effect.provideService(AmbientDecisionsPort, port)),
		);
		expect(calls[0]?.state).toEqual({ foo: "bar 3" });
		expect(calls[0]?.questions).toEqual([]);
	});

	it("ignores non-object params.input", async () => {
		const { calls, port } = decisionsCapture();
		const r = registry();
		r.registerDef(
			def("dec-junk", [
				node("d", "ai", ["go"], {
					params: { kind: "decide", template: "t", input: "junk" },
				}),
			]),
		);
		await Effect.runPromise(
			r
				.run("dec-junk", OrchestrationEvent.new("go", {}, "test"))
				.pipe(Effect.provideService(AmbientDecisionsPort, port)),
		);
		expect(calls[0]?.state).toEqual({ prompt: "t" });
	});

	it("resolves llm through AmbientPlatformLlm.defaultLayer", async () => {
		const { envelopes, port } = llmCapture();
		const platform: AmbientPlatformLlmShape = {
			defaultLayer: () => Effect.succeed(Layer.succeed(AmbientLlmPort, port)),
		};
		const r = registry();
		r.registerDef(
			def("llm-platform", [node("a", "ai", ["start"], { params: { template: "via platform" } })]),
		);
		const result = await Effect.runPromise(
			r.run("llm-platform").pipe(Effect.provideService(AmbientPlatformLlm, platform)),
		);
		expect(envelopes[0]?.input).toBe("via platform");
		expect(result.state["a"]).toMatchObject({ text: "echo:via platform" });
	});

	it("resolves decide through AmbientPlatformDecisions.defaultLayer", async () => {
		const { calls, port } = decisionsCapture();
		const platform: AmbientPlatformDecisionsShape = {
			defaultLayer: () => Effect.succeed(Layer.succeed(AmbientDecisionsPort, port)),
		};
		const r = registry();
		r.registerDef(
			def("dec-platform", [
				node("d", "ai", ["go"], { params: { kind: "decide", input: { v: 1 } } }),
			]),
		);
		await Effect.runPromise(
			r
				.run("dec-platform", OrchestrationEvent.new("go", {}, "test"))
				.pipe(Effect.provideService(AmbientPlatformDecisions, platform)),
		);
		expect(calls[0]?.state).toEqual({ v: 1 });
	});

	it("degrades decide on every missing/broken platform path", async () => {
		const scenarios: AmbientPlatformDecisionsShape[] = [
			// defaultLayer → null
			{ defaultLayer: () => Effect.succeed(null) },
			// defaultLayer typed failure
			{ defaultLayer: () => Effect.fail("decisions table missing") },
			// defaultLayer defect
			{ defaultLayer: () => Effect.die(new Error("boom")) },
			// layer builds but judge defects
			{
				defaultLayer: () =>
					Effect.succeed(
						Layer.succeed(AmbientDecisionsPort, {
							judge: () => Effect.die(new Error("judge exploded")),
						}),
					),
			},
		];
		for (const platform of scenarios) {
			const r = registry();
			r.registerDef(def("dec-deg", [node("d", "ai", ["go"], { params: { kind: "decide" } })]));
			const result = await Effect.runPromise(
				r
					.run("dec-deg", OrchestrationEvent.new("go", {}, "test"))
					.pipe(Effect.provideService(AmbientPlatformDecisions, platform)),
			);
			expect(result.state["d"]).toMatchObject({ skipped: true, reason: "no-port", kind: "decide" });
		}
		// And with NO platform service bound at all.
		const r = registry();
		r.registerDef(def("dec-none", [node("d", "ai", ["go"], { params: { kind: "decide" } })]));
		const result = await Effect.runPromise(
			r.run("dec-none", OrchestrationEvent.new("go", {}, "test")),
		);
		expect(result.state["d"]).toMatchObject({ skipped: true, reason: "no-port", kind: "decide" });
	});

	it("degrades when the platform defaultLayer resolves null", async () => {
		const platform: AmbientPlatformLlmShape = { defaultLayer: () => Effect.succeed(null) };
		const r = registry();
		r.registerDef(def("llm-null", [node("a", "ai", ["start"])]));
		const result = await Effect.runPromise(
			r.run("llm-null").pipe(Effect.provideService(AmbientPlatformLlm, platform)),
		);
		expect(result.state["a"]).toMatchObject({ skipped: true, reason: "no-port", kind: "llm" });
	});

	it("degrades when defaultLayer fails typed or defects", async () => {
		const failing: AmbientPlatformLlmShape = {
			defaultLayer: () => Effect.fail("endpoint table missing"),
		};
		const defecting: AmbientPlatformLlmShape = {
			defaultLayer: () => Effect.die(new Error("boom")),
		};
		for (const platform of [failing, defecting]) {
			const r = registry();
			r.registerDef(def("llm-bad-layer", [node("a", "ai", ["start"])]));
			const result = await Effect.runPromise(
				r.run("llm-bad-layer").pipe(Effect.provideService(AmbientPlatformLlm, platform)),
			);
			expect(result.state["a"]).toMatchObject({ skipped: true, reason: "no-port" });
		}
	});

	it("degrades when the provided layer's generate defects", async () => {
		const platform: AmbientPlatformLlmShape = {
			defaultLayer: () =>
				Effect.succeed(
					Layer.succeed(AmbientLlmPort, {
						generate: () => Effect.die(new Error("provider exploded")),
					}),
				),
		};
		const r = registry();
		r.registerDef(def("llm-die", [node("a", "ai", ["start"])]));
		const result = await Effect.runPromise(
			r.run("llm-die").pipe(Effect.provideService(AmbientPlatformLlm, platform)),
		);
		expect(result.state["a"]).toMatchObject({ skipped: true, reason: "no-port" });
	});

	it("propagates typed port failures as node failures", async () => {
		const port: AmbientLlmPortShape = {
			generate: () => Effect.fail(new Error("rate limited")),
		};
		const r = registry();
		r.registerDef(def("llm-fail", [node("a", "ai", ["start"])], { onNodeError: "continue" }));
		const result = await Effect.runPromise(
			r.run("llm-fail").pipe(Effect.provideService(AmbientLlmPort, port)),
		);
		expect(result.status).toBe("done");
		expect(traceFor(result, "a")[0]).toMatchObject({ status: "failed" });
	});

	it("fails the node on an unsupported kind param", async () => {
		const r = registry();
		r.registerDef(
			def("ai-bad-kind", [node("a", "ai", ["start"], { params: { kind: "telepathy" } })], {
				onNodeError: "continue",
			}),
		);
		const result = await Effect.runPromise(r.run("ai-bad-kind"));
		expect(traceFor(result, "a")[0]?.error).toContain("unsupported kind");
	});

	it("maps outputSchema variants to the envelope contract", async () => {
		const { envelopes, port } = llmCapture();
		const r = registry();
		r.registerDef(
			def("schemas", [
				node("s1", "ai", ["start"], { params: { outputSchema: "Named" } }),
				node("s2", "ai", ["start"], { params: { outputSchema: { name: "ByName" } } }),
				node("s3", "ai", ["start"], { params: { outputSchema: { type: "ByType" } } }),
				node("s4", "ai", ["start"], { params: { outputSchema: { custom: 1 } } }),
				node("s5", "ai", ["start"], { params: { outputSchema: 42 } }),
			]),
		);
		await Effect.runPromise(r.run("schemas").pipe(Effect.provideService(AmbientLlmPort, port)));
		const byNode = new Map(envelopes.map((e) => [e.taskId.split("-")[1], e.outputSchema]));
		expect(byNode.get("s1")).toBe("Named");
		expect(byNode.get("s2")).toBe("ByName");
		expect(byNode.get("s3")).toBe("ByType");
		expect(byNode.get("s4")).toBe('{"custom":1}');
		expect(byNode.get("s5")).toBe("Text");
	});
});

describe("ai kind — asr", () => {
	it("calls AsrPort with input.audio and language", async () => {
		const { calls, port } = asrCapture();
		const r = registry();
		r.registerDef(
			def("asr", [
				node("a", "ai", ["start"], {
					params: {
						kind: "asr",
						input: { audio: { uri: "file://consult.wav" }, language: "pt-BR" },
					},
				}),
			]),
		);
		const result = await Effect.runPromise(
			r.run("asr").pipe(Effect.provideService(AmbientAsrPort, port)),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.audio).toEqual({ uri: "file://consult.wav" });
		expect(calls[0]?.opts).toEqual({ language: "pt-BR" });
		expect(result.state["a"]).toMatchObject({ asr: { text: "oi" } });
	});

	it("accepts an AudioRef-shaped input directly and omits empty opts", async () => {
		const { calls, port } = asrCapture();
		const r = registry();
		r.registerDef(
			def("asr-ref", [
				node("a", "ai", ["start"], {
					params: { kind: "asr", input: { uri: "file://direct.wav", size: 12 } },
				}),
			]),
		);
		await Effect.runPromise(r.run("asr-ref").pipe(Effect.provideService(AmbientAsrPort, port)));
		expect(calls[0]?.audio).toEqual({ uri: "file://direct.wav", size: 12 });
		expect(calls[0]?.opts).toEqual({});
	});

	it("fails the node when no audio ref is provided", async () => {
		const { port } = asrCapture();
		const r = registry();
		r.registerDef(
			def("asr-no-audio", [node("a", "ai", ["start"], { params: { kind: "asr" } })], {
				onNodeError: "continue",
			}),
		);
		const result = await Effect.runPromise(
			r.run("asr-no-audio").pipe(Effect.provideService(AmbientAsrPort, port)),
		);
		expect(traceFor(result, "a")[0]?.error).toContain("requires params.input.audio");
	});

	it("degrades to no-port when AsrPort is absent", async () => {
		const r = registry();
		r.registerDef(def("asr-none", [node("a", "ai", ["start"], { params: { kind: "asr" } })]));
		const result = await Effect.runPromise(r.run("asr-none"));
		expect(result.state["a"]).toMatchObject({ skipped: true, reason: "no-port", kind: "asr" });
	});
});

describe("ai kind — degrade paths", () => {
	it("emits the configured event even when skipping", async () => {
		const r = registry();
		r.registerDef(
			def("degrade-route", [
				node("a", "ai", ["start"], { params: { emitEvent: "ai.skipped" } }),
				node("sink", "ai", ["ai.skipped"], { maxFires: 1 }),
			]),
		);
		const result = await Effect.runPromise(r.run("degrade-route"));
		expect(eventTypes(result)).toContain("ai.skipped");
		expect(traceFor(result, "sink")).toHaveLength(1);
	});
});

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
