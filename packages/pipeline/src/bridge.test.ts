import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "effect/Schema";
import type { NodeContext, OrchestrationEvent } from "@ktb/orchestrator";

import {
	pipelinePackToOrchestration,
	pipelineStageKind,
	PipelineStageError,
	UnknownStageError,
	type PipelinePack,
	type PipelineStage,
	type StageContext,
	type StageResult,
} from "./index.ts";

/**
 * bridge.test.ts — the stage→kind and pack→orchestration translations,
 * exercised against a fabricated NodeContext (the public contract is
 * structural; the real-engine end-to-end parity lives in
 * plugins/pipeline-transcript's orchestration.test.ts, which runs both
 * registries over the same fixtures).
 */

const event = (type: string, payload: JsonObject = {}): OrchestrationEvent =>
	({
		type,
		payload,
		source: "test",
		id: `evt-${type}`,
		ts: 0,
	}) as OrchestrationEvent;

const nodeContext = (
	overrides: Partial<NodeContext> & { event?: OrchestrationEvent } = {},
): NodeContext => ({
	event: overrides.event ?? event("input", {}),
	node: { id: "n1", kind: "k", on: [], emits: [] },
	config: {},
	state: {},
	params: {},
	emit: () => Effect.void,
	...overrides,
});

const ok = (id: string, result: StageResult, seen?: StageContext[]): PipelineStage => ({
	id,
	run: (ctx) => {
		seen?.push(ctx);
		return Effect.succeed(result);
	},
});

const failWith = (id: string, error: unknown): PipelineStage => ({
	id,
	run: () => Effect.fail(error as never),
});

/** Kind `run` effects declare R=unknown (ambient-probe idiom) — tests
 * provide no services, so the requirement channel is erased for
 * `Effect.runPromise` (which demands R=never). */
const runPromise = <A, E>(eff: Effect.Effect<A, E, unknown>): Promise<A> =>
	Effect.runPromise(eff as Effect.Effect<A, E, never>);

const runKind = (kind: ReturnType<typeof pipelineStageKind>, ctx: NodeContext) =>
	runPromise(kind.run(ctx));

describe("pipelineStageKind", () => {
	it("maps NodeContext onto StageContext and StageResult onto KindResult", async () => {
		const seen: StageContext[] = [];
		const stage = ok("s1", { state: { frag: 1 }, output: { done: true } }, seen);
		const kind = pipelineStageKind(stage);
		const ctx = nodeContext({
			event: event("input", { text: "oi" }),
			config: { c: 1 } as JsonObject,
			state: { prior: true },
			params: { tuning: 2 } as JsonObject,
		});
		const result = await runKind(kind, ctx);
		expect(result.output).toEqual({ done: true });
		expect(result.state).toEqual({ frag: 1 });
		expect(seen[0]).toMatchObject({
			input: { text: "oi" },
			state: { prior: true },
			config: { c: 1 },
			stageConfig: { tuning: 2 },
		});
	});

	it("recovers input from payload.input on chained events", async () => {
		const seen: StageContext[] = [];
		const kind = pipelineStageKind(ok("s", { output: 1 }, seen));
		await runKind(
			kind,
			nodeContext({
				event: event("def.s0.done", { cleanup: { enabled: true }, input: { text: "x" } }),
			}),
		);
		expect(seen[0]?.input).toEqual({ text: "x" });
	});

	it("recovers undefined input from the start event", async () => {
		const seen: StageContext[] = [];
		const kind = pipelineStageKind(ok("s", {}, seen));
		await runKind(kind, nodeContext({ event: event("start") }));
		expect(seen[0]?.input).toBeUndefined();
	});

	it("aliases output ?? state ?? {} like the pipeline runner", async () => {
		const kind = pipelineStageKind(ok("s", { state: { only: "state" } }));
		const result = await runKind(kind, nodeContext());
		expect(result.output).toEqual({ only: "state" });
		const empty = pipelineStageKind(ok("e", {}));
		expect((await runKind(empty, nodeContext())).output).toEqual({});
	});

	it("emits the configured follow-up event with the default payload", async () => {
		const kind = pipelineStageKind(ok("s", { state: { gate: { enabled: true } } }), {
			emit: { type: "def.s.done" },
		});
		const result = await runKind(kind, nodeContext({ event: event("input", { text: "raw" }) }));
		expect(result.events).toHaveLength(1);
		expect(result.events?.[0]?.type).toBe("def.s.done");
		expect(result.events?.[0]?.payload).toEqual({
			gate: { enabled: true },
			input: { text: "raw" },
		});
	});

	it("omits the input key from the emit payload when input is undefined", async () => {
		const kind = pipelineStageKind(ok("s", { state: { frag: 1 } }), {
			emit: { type: "def.s.done" },
		});
		const result = await runKind(kind, nodeContext({ event: event("start") }));
		expect(result.events?.[0]?.payload).toEqual({ frag: 1 });
		expect(result.events?.[0]?.payload).not.toHaveProperty("input");
	});

	it("uses a custom emit payload builder", async () => {
		const kind = pipelineStageKind(ok("s", { output: 7 }), {
			emit: {
				type: "custom.event",
				payload: ({ input, result }) => ({ got: input, out: result?.output }) as JsonObject,
			},
		});
		const result = await runKind(kind, nodeContext({ event: event("input", { a: 1 }) }));
		expect(result.events?.[0]?.payload).toEqual({ got: { a: 1 }, out: 7 });
	});

	it("emits nothing when no emit option is configured", async () => {
		const result = await runKind(pipelineStageKind(ok("s", {})), nodeContext());
		expect(result.events).toBeUndefined();
	});

	it("propagates stage failures under the default halt policy", async () => {
		const kind = pipelineStageKind(
			failWith("s", new PipelineStageError({ stageId: "s", message: "boom" })),
			{ emit: { type: "def.s.done" } },
		);
		const error = await runPromise(Effect.flip(kind.run(nodeContext())));
		expect(error).toBeInstanceOf(PipelineStageError);
		expect((error as PipelineStageError).message).toBe("boom");
	});

	it("converts synchronous throws into PipelineStageError", async () => {
		const kind = pipelineStageKind({
			id: "s",
			run: () => {
				throw new Error("sync boom");
			},
		});
		const error = await runPromise(Effect.flip(kind.run(nodeContext())));
		expect(error).toBeInstanceOf(PipelineStageError);
		expect((error as PipelineStageError).message).toBe("sync boom");
	});

	it("stringifies non-Error synchronous throws into PipelineStageError", async () => {
		const kind = pipelineStageKind({
			id: "s",
			run: () => {
				// eslint-disable-next-line no-throw-literal -- intentional: proves the bridge stringifies non-Error throws
				throw "plain string failure";
			},
		});
		const error = await runPromise(Effect.flip(kind.run(nodeContext())));
		expect(error).toBeInstanceOf(PipelineStageError);
		expect((error as PipelineStageError).message).toBe("plain string failure");
	});

	it("skip policy: logs, contributes no state, still emits", async () => {
		const kind = pipelineStageKind(
			failWith("s", new PipelineStageError({ stageId: "s", message: "soft" })),
			{ onError: "skip", emit: { type: "def.s.done" } },
		);
		const result = await runKind(kind, nodeContext({ event: event("input", { text: "x" }) }));
		expect(result.state).toBeUndefined();
		expect(result.output).toBeUndefined();
		expect(result.events?.[0]?.type).toBe("def.s.done");
		// The wire input still forwards so the chain keeps its contract.
		expect(result.events?.[0]?.payload).toEqual({ input: { text: "x" } });
	});

	it("skip policy tolerates foreign (non-PipelineStageError) failures", async () => {
		const kind = pipelineStageKind(failWith("s", { reason: "foreign" }), {
			onError: "skip",
			emit: { type: "def.s.done" },
		});
		const result = await runKind(kind, nodeContext());
		expect(result.output).toBeUndefined();
		expect(result.events?.[0]?.type).toBe("def.s.done");
	});

	it("skip policy does not catch defects", async () => {
		const kind = pipelineStageKind(
			{
				id: "s",
				run: () => Effect.die(new Error("defect")),
			},
			{ onError: "skip" },
		);
		const exit = await runPromise(Effect.exit(kind.run(nodeContext())));
		expect(exit._tag).toBe("Failure");
	});
});

describe("pipelinePackToOrchestration", () => {
	const pack: PipelinePack = {
		def: {
			id: "demo-pipe",
			version: "3",
			description: "three stages",
			stages: [{ id: "alpha", config: { k: 1 } }, { id: "beta", onError: "skip" }, { id: "gamma" }],
		},
		stages: {
			alpha: ok("alpha", { state: { a: 1 }, output: "A" }),
			beta: ok("beta", { output: "B" }),
			gamma: ok("gamma", { output: "C" }),
		},
		config: { packCfg: true },
	};

	it("derives def identity, config and onNodeError", () => {
		const orch = pipelinePackToOrchestration(pack);
		expect(orch.def.id).toBe("demo-pipe");
		expect(orch.def.version).toBe("3");
		expect(orch.def.description).toBe("three stages");
		expect(orch.def.config).toEqual({ packCfg: true });
		expect(orch.def.onNodeError).toBe("halt");
		expect(orch.kinds.map((k) => k.id)).toEqual([
			"pipeline.demo-pipe.alpha",
			"pipeline.demo-pipe.beta",
			"pipeline.demo-pipe.gamma",
		]);
	});

	it("wires the linear chain: input/start → *.done events", () => {
		const { def } = pipelinePackToOrchestration(pack);
		expect(def.nodes.map((n) => [n.id, n.on, n.emits])).toEqual([
			["alpha", ["input", "start"], ["demo-pipe.alpha.done"]],
			["beta", ["demo-pipe.alpha.done"], ["demo-pipe.beta.done"]],
			["gamma", ["demo-pipe.beta.done"], ["demo-pipe.gamma.done"]],
		]);
		expect(def.nodes[0]?.params).toEqual({ k: 1 });
		expect(def.nodes[1]?.params).toBeUndefined();
	});

	it("honors a def-level onNodeError override", () => {
		const orch = pipelinePackToOrchestration(pack, { onNodeError: "continue" });
		expect(orch.def.onNodeError).toBe("continue");
	});

	it("throws UnknownStageError for a def entry with no implementation", () => {
		const bad: PipelinePack = {
			def: { id: "bad", stages: [{ id: "ghost" }] },
			stages: {},
		};
		expect(() => pipelinePackToOrchestration(bad)).toThrowError(UnknownStageError);
	});

	it("derives an empty def for a zero-stage pipeline", () => {
		const orch = pipelinePackToOrchestration({
			def: { id: "void", stages: [] },
			stages: {},
		});
		expect(orch.def.nodes).toEqual([]);
		expect(orch.kinds).toEqual([]);
	});

	it("chains kinds end-to-end: state accumulates like the pipeline runner", async () => {
		const orch = pipelinePackToOrchestration(pack);
		const [alpha, beta, gamma] = orch.kinds;
		const state: Record<string, unknown> = {};

		// Node alpha fires on the entry event.
		const r1 = await runKind(alpha, {
			...nodeContext({ event: event("input", { seed: 1 }) }),
			state: { ...state },
		});
		Object.assign(state, r1.state);
		state["alpha"] = r1.output;
		const e1 = r1.events?.[0];
		expect(e1?.type).toBe("demo-pipe.alpha.done");

		// Node beta fires on alpha's emit; its skip policy is armed.
		const r2 = await runKind(beta, {
			...nodeContext({ event: event(e1?.type ?? "", e1?.payload ?? {}) }),
			state: { ...state },
		});
		Object.assign(state, r2.state);
		state["beta"] = r2.output;
		const e2 = r2.events?.[0];

		const r3 = await runKind(gamma, {
			...nodeContext({ event: event(e2?.type ?? "", e2?.payload ?? {}) }),
			state: { ...state },
		});
		Object.assign(state, r3.state);
		state["gamma"] = r3.output;

		expect(state).toEqual({ a: 1, alpha: "A", beta: "B", gamma: "C" });
	});
});
