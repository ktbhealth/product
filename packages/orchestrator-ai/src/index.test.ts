import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { AsrPort } from "@ktb/eval-consultation/ports";
import {
	DecisionsPort,
	LlmPort,
	PlatformDecisions,
	PlatformLlm,
	PortError,
	type EvalQuestion,
	type TaskEnvelope,
} from "@ktb/eval-core";
import {
	emitKind,
	makeOrchestratorRegistry,
	OrchestrationEvent,
	type JsonObject,
	type OrchestrationDef,
	type OrchestrationNode,
	type OrchestrationRunResult,
} from "@ktb/orchestrator";

import { aiOrchestrationKind, aiOrchestrationKinds, aiOrchestrationPack } from "./index.ts";

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

const registry = () => makeOrchestratorRegistry([emitKind, aiOrchestrationKind]);

const eventTypes = (result: OrchestrationRunResult): string[] =>
	result.events.map((event) => event.type);

const traceFor = (result: OrchestrationRunResult, nodeId: string) =>
	result.trace.filter((record) => record.nodeId === nodeId);

const llmCapture = () => {
	const envelopes: TaskEnvelope[] = [];
	const port = {
		generate: (envelope: TaskEnvelope) => {
			envelopes.push(envelope);
			return Effect.succeed({
				text: `echo:${envelope.input}`,
				record: { engine: "stub" } as never,
			});
		},
		correct: () => Effect.die(new Error("correct unused")),
	} as unknown as LlmPort["Service"];
	return { envelopes, port };
};

const decisionsCapture = () => {
	const calls: { state: unknown; questions: readonly EvalQuestion[] }[] = [];
	const port = {
		judge: (input: { state: unknown; questions: readonly EvalQuestion[] }) => {
			calls.push(input);
			return Effect.succeed({
				answers: [{ verdict: "yes" }],
				record: { engine: "stub" } as never,
			});
		},
	} as unknown as DecisionsPort["Service"];
	return { calls, port };
};

const asrCapture = () => {
	const calls: { audio: unknown; opts: unknown }[] = [];
	const port = {
		transcribe: (audio: unknown, opts?: unknown) => {
			calls.push({ audio, opts });
			return Effect.succeed({
				asr: { text: "oi", segments: [] },
				record: { engine: "stub" } as never,
			});
		},
	} as unknown as AsrPort["Service"];
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
				.pipe(Effect.provideService(LlmPort, port)),
		);
		expect(envelopes).toHaveLength(1);
		const envelope = envelopes[0] as TaskEnvelope;
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
				.pipe(Effect.provideService(LlmPort, port)),
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
				.pipe(Effect.provideService(DecisionsPort, port)),
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
				.pipe(Effect.provideService(DecisionsPort, port)),
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
				.pipe(Effect.provideService(DecisionsPort, port)),
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
				.pipe(Effect.provideService(DecisionsPort, port)),
		);
		expect(calls[0]?.state).toEqual({ prompt: "t" });
	});

	it("resolves llm through PlatformLlm.defaultLayer", async () => {
		const { envelopes, port } = llmCapture();
		const platform = PlatformLlm.of({
			defaultLayer: () => Effect.succeed(Layer.succeed(LlmPort, port)),
		});
		const r = registry();
		r.registerDef(
			def("llm-platform", [node("a", "ai", ["start"], { params: { template: "via platform" } })]),
		);
		const result = await Effect.runPromise(
			r.run("llm-platform").pipe(Effect.provideService(PlatformLlm, platform)),
		);
		expect(envelopes[0]?.input).toBe("via platform");
		expect(result.state["a"]).toMatchObject({ text: "echo:via platform" });
	});

	it("resolves decide through PlatformDecisions.defaultLayer", async () => {
		const { calls, port } = decisionsCapture();
		const platform = PlatformDecisions.of({
			defaultLayer: () => Effect.succeed(Layer.succeed(DecisionsPort, port)),
		});
		const r = registry();
		r.registerDef(
			def("dec-platform", [
				node("d", "ai", ["go"], { params: { kind: "decide", input: { v: 1 } } }),
			]),
		);
		await Effect.runPromise(
			r
				.run("dec-platform", OrchestrationEvent.new("go", {}, "test"))
				.pipe(Effect.provideService(PlatformDecisions, platform)),
		);
		expect(calls[0]?.state).toEqual({ v: 1 });
	});

	it("degrades decide on every missing/broken platform path", async () => {
		const scenarios = [
			// defaultLayer → null
			PlatformDecisions.of({ defaultLayer: () => Effect.succeed(null) }),
			// defaultLayer typed failure (not expressible on the never
			// channel — cast like app-host's platform-llm tests)
			PlatformDecisions.of({
				defaultLayer: () => Effect.fail(new Error("decisions table missing")) as never,
			}),
			// defaultLayer defect
			PlatformDecisions.of({ defaultLayer: () => Effect.die(new Error("boom")) }),
			// layer builds but judge defects
			PlatformDecisions.of({
				defaultLayer: () =>
					Effect.succeed(
						Layer.succeed(DecisionsPort, {
							judge: () => Effect.die(new Error("judge exploded")),
						} as unknown as DecisionsPort["Service"]),
					),
			}),
		];
		for (const platform of scenarios) {
			const r = registry();
			r.registerDef(def("dec-deg", [node("d", "ai", ["go"], { params: { kind: "decide" } })]));
			const result = await Effect.runPromise(
				r
					.run("dec-deg", OrchestrationEvent.new("go", {}, "test"))
					.pipe(Effect.provideService(PlatformDecisions, platform)),
			);
			expect(result.state["d"]).toMatchObject({
				skipped: true,
				reason: "no-port",
				kind: "decide",
			});
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
		const platform = PlatformLlm.of({ defaultLayer: () => Effect.succeed(null) });
		const r = registry();
		r.registerDef(def("llm-null", [node("a", "ai", ["start"])]));
		const result = await Effect.runPromise(
			r.run("llm-null").pipe(Effect.provideService(PlatformLlm, platform)),
		);
		expect(result.state["a"]).toMatchObject({ skipped: true, reason: "no-port", kind: "llm" });
	});

	it("degrades when defaultLayer fails typed or defects", async () => {
		const failing = PlatformLlm.of({
			defaultLayer: () => Effect.fail(new Error("endpoint table missing")) as never,
		});
		const defecting = PlatformLlm.of({ defaultLayer: () => Effect.die(new Error("boom")) });
		for (const platform of [failing, defecting]) {
			const r = registry();
			r.registerDef(def("llm-bad-layer", [node("a", "ai", ["start"])]));
			const result = await Effect.runPromise(
				r.run("llm-bad-layer").pipe(Effect.provideService(PlatformLlm, platform)),
			);
			expect(result.state["a"]).toMatchObject({ skipped: true, reason: "no-port" });
		}
	});

	it("degrades when the provided layer's generate defects", async () => {
		const platform = PlatformLlm.of({
			defaultLayer: () =>
				Effect.succeed(
					Layer.succeed(LlmPort, {
						generate: () => Effect.die(new Error("provider exploded")),
						correct: () => Effect.die(new Error("unused")),
					} as unknown as LlmPort["Service"]),
				),
		});
		const r = registry();
		r.registerDef(def("llm-die", [node("a", "ai", ["start"])]));
		const result = await Effect.runPromise(
			r.run("llm-die").pipe(Effect.provideService(PlatformLlm, platform)),
		);
		expect(result.state["a"]).toMatchObject({ skipped: true, reason: "no-port" });
	});

	it("propagates typed port failures as node failures", async () => {
		const port = {
			generate: () => Effect.fail(new PortError({ port: "llm", message: "rate limited" })),
			correct: () => Effect.die(new Error("unused")),
		} as unknown as LlmPort["Service"];
		const r = registry();
		r.registerDef(def("llm-fail", [node("a", "ai", ["start"])], { onNodeError: "continue" }));
		const result = await Effect.runPromise(
			r.run("llm-fail").pipe(Effect.provideService(LlmPort, port)),
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
		await Effect.runPromise(r.run("schemas").pipe(Effect.provideService(LlmPort, port)));
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
		const result = await Effect.runPromise(r.run("asr").pipe(Effect.provideService(AsrPort, port)));
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
		await Effect.runPromise(r.run("asr-ref").pipe(Effect.provideService(AsrPort, port)));
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
			r.run("asr-no-audio").pipe(Effect.provideService(AsrPort, port)),
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

	it("degrades to no-port output when no AI port is bound", async () => {
		const r = registry();
		r.registerDef(def("ai-bad", [node("a", "ai", ["start"])]));
		const result = await Effect.runPromise(r.run("ai-bad"));
		expect(result.state["a"]).toMatchObject({ skipped: true, reason: "no-port", kind: "llm" });
	});

	it("emits ai.done even on the degrade path", async () => {
		const r = registry();
		r.registerDef(
			def("ai", [
				node("a", "ai", ["start"], {
					params: { template: "summarize", model: "stub-1" },
				}),
				node("sink", "ai", ["ai.done"], { maxFires: 1 }),
			]),
		);
		const result = await Effect.runPromise(r.run("ai"));
		expect(eventTypes(result)).toContain("ai.done");
		expect(traceFor(result, "sink")).toHaveLength(1);
		expect(result.state["a"]).toMatchObject({ skipped: true, reason: "no-port" });
	});
});

describe("aiOrchestrationPack", () => {
	it("is a kinds-only pack carrying the ai kind", () => {
		expect(aiOrchestrationPack.def).toBeUndefined();
		expect(aiOrchestrationPack.kinds).toEqual(aiOrchestrationKinds);
		expect(aiOrchestrationKinds.map((kind) => kind.id)).toEqual(["ai"]);
		expect(aiOrchestrationKind.id).toBe("ai");
	});
});
