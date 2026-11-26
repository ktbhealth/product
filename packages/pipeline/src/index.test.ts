import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
	DuplicatePipelineError,
	makePipelineRegistry,
	PipelineRegistry,
	PipelineRegistryLive,
	PipelineRunError,
	PipelineStageError,
	UnknownPipelineError,
	UnknownStageError,
	type PipelinePack,
	type PipelineStage,
	type StageContext,
	type StageResult,
} from "./index.ts";

const ok = (id: string, result: StageResult): PipelineStage => ({
	id,
	run: () => Effect.succeed(result),
});

const failWith = (id: string, error: PipelineStageError): PipelineStage => ({
	id,
	run: () => Effect.fail(error),
});

const pack = (
	id: string,
	stages: readonly PipelineStage[],
	entries?: PipelinePack["def"]["stages"],
): PipelinePack => ({
	def: {
		id,
		stages: entries ?? stages.map((s) => ({ id: s.id })),
	},
	stages: Object.fromEntries(stages.map((s) => [s.id, s])),
});

/** Synchronously capture what `fn` throws (typed-error assertions). */
const thrown = (fn: () => void): unknown => {
	try {
		fn();
	} catch (e) {
		return e;
	}
	throw new Error("expected fn to throw");
};

describe("makePipelineRegistry", () => {
	it("registers, gets, lists and checks packs", () => {
		const r = makePipelineRegistry();
		const p = pack("demo", [ok("a", { output: 1 })]);
		r.register(p);
		expect(r.get("demo")).toBe(p);
		expect(r.has("demo")).toBe(true);
		expect(r.has("nope")).toBe(false);
		expect(r.list().map((d) => d.id)).toEqual(["demo"]);
	});

	it("throws DuplicatePipelineError on re-register", () => {
		const r = makePipelineRegistry();
		r.register(pack("demo", [ok("a", {})]));
		expect(() => r.register(pack("demo", [ok("b", {})]))).toThrowError(DuplicatePipelineError);
		expect(thrown(() => r.register(pack("demo", [ok("b", {})])))).toMatchObject({
			_tag: "DuplicatePipelineError",
			pipelineId: "demo",
		});
	});

	it("throws UnknownStageError when a def entry has no implementation", () => {
		const r = makePipelineRegistry();
		const bad: PipelinePack = {
			def: { id: "broken", stages: [{ id: "ghost" }] },
			stages: {},
		};
		expect(() => r.register(bad)).toThrowError(UnknownStageError);
		expect(thrown(() => r.register(bad))).toMatchObject({
			_tag: "UnknownStageError",
			pipelineId: "broken",
			stageId: "ghost",
		});
		expect(r.has("broken")).toBe(false);
	});

	it("throws UnknownPipelineError on get of a missing id", () => {
		const r = makePipelineRegistry();
		expect(() => r.get("nope")).toThrowError(UnknownPipelineError);
		expect(thrown(() => r.get("nope"))).toMatchObject({
			_tag: "UnknownPipelineError",
			pipelineId: "nope",
		});
	});
});

describe("run", () => {
	it("threads state and aliases outputs at state[stageId]", async () => {
		const seen: StageContext[] = [];
		const r = makePipelineRegistry();
		r.register(
			pack("demo", [
				{
					id: "first",
					run: (ctx) => {
						seen.push(ctx);
						return Effect.succeed({
							output: { n: 1 },
							state: { shared: "yes" },
						});
					},
				},
				{
					id: "second",
					run: (ctx) => {
						seen.push(ctx);
						return Effect.succeed({ output: ctx.state["first"] });
					},
				},
			]),
		);
		const result = await Effect.runPromise(r.run("demo", { seed: true }));
		expect(result.state).toEqual({
			shared: "yes",
			first: { n: 1 },
			second: { n: 1 },
		});
		expect(result.trace.map((t) => [t.stageId, t.status])).toEqual([
			["first", "ok"],
			["second", "ok"],
		]);
		for (const t of result.trace) {
			expect(t.latencyMs).toBeGreaterThanOrEqual(0);
		}
		// Stage contexts: input/config plumbing + accumulated state.
		expect(seen[0]?.input).toEqual({ seed: true });
		expect(seen[0]?.config).toEqual({});
		expect(seen[0]?.stageConfig).toEqual({});
		expect(seen[1]?.state["first"]).toEqual({ n: 1 });
		expect(seen[1]?.state["shared"]).toBe("yes");
	});

	it("passes stage config entries and pipeline-level config through", async () => {
		const seen: StageContext[] = [];
		const r = makePipelineRegistry();
		const p: PipelinePack = {
			def: {
				id: "cfg",
				stages: [{ id: "s", config: { tuning: 3 } }],
			},
			stages: {
				s: {
					id: "s",
					run: (ctx) => {
						seen.push(ctx);
						return Effect.succeed({});
					},
				},
			},
			config: { fromPack: true },
		};
		r.register(p);
		await Effect.runPromise(r.run("cfg", null));
		expect(seen[0]?.config).toEqual({ fromPack: true });
		expect(seen[0]?.stageConfig).toEqual({ tuning: 3 });

		// run-level config overrides the pack config.
		await Effect.runPromise(r.run("cfg", null, { fromRun: true }));
		expect(seen[1]?.config).toEqual({ fromRun: true });
	});

	it("stores {} for a stage that returns neither output nor state", async () => {
		const r = makePipelineRegistry();
		r.register(pack("empty-result", [ok("s", {})]));
		const result = await Effect.runPromise(r.run("empty-result", null));
		expect(result.state).toEqual({ s: {} });
	});

	it("runs a def with zero stages to an empty result", async () => {
		const r = makePipelineRegistry();
		r.register({ def: { id: "void", stages: [] }, stages: {} });
		const result = await Effect.runPromise(r.run("void", null));
		expect(result.state).toEqual({});
		expect(result.trace).toEqual([]);
	});

	it("fails with PipelineRunError on an unknown pipeline id", async () => {
		const r = makePipelineRegistry();
		const error = await Effect.runPromise(Effect.flip(r.run("ghost", null)));
		expect(error).toBeInstanceOf(PipelineRunError);
		expect(error).toMatchObject({
			_tag: "PipelineRunError",
			pipelineId: "ghost",
			trace: [],
		});
		expect(error.stageId).toBeUndefined();
	});

	it("halts on stage failure by default and carries the trace-so-far", async () => {
		const after = ok("after", { output: "never" });
		let afterRan = false;
		const r = makePipelineRegistry();
		r.register({
			def: {
				id: "halt",
				stages: [{ id: "boom" }, { id: "after" }],
			},
			stages: {
				boom: failWith(
					"boom",
					new PipelineStageError({
						stageId: "boom",
						message: "kaput",
						cause: new Error("root"),
					}),
				),
				after: {
					id: "after",
					run: (ctx) => {
						afterRan = true;
						return after.run(ctx);
					},
				},
			},
		});
		const error = await Effect.runPromise(Effect.flip(r.run("halt", null)));
		expect(error).toBeInstanceOf(PipelineRunError);
		expect(error).toMatchObject({
			pipelineId: "halt",
			stageId: "boom",
			message: "kaput",
		});
		expect(error.cause).toBeInstanceOf(Error);
		// Trace includes the failed stage; stages after the halt are absent.
		expect(error.trace).toHaveLength(1);
		expect(error.trace[0]).toMatchObject({
			stageId: "boom",
			status: "failed",
			error: "kaput",
		});
		expect(afterRan).toBe(false);
	});

	it('skips a failing stage under onError "skip" and continues', async () => {
		const r = makePipelineRegistry();
		r.register({
			def: {
				id: "skip",
				stages: [{ id: "bad", onError: "skip" }, { id: "good" }],
			},
			stages: {
				bad: failWith(
					"bad",
					new PipelineStageError({
						stageId: "bad",
						message: "soft fail",
					}),
				),
				good: ok("good", { output: 42 }),
			},
		});
		const result = await Effect.runPromise(r.run("skip", null));
		// The skipped stage contributes nothing to state.
		expect(result.state).toEqual({ good: 42 });
		expect(result.trace.map((t) => [t.stageId, t.status])).toEqual([
			["bad", "skipped"],
			["good", "ok"],
		]);
		expect(result.trace[0]?.error).toBe("soft fail");
	});

	it("normalizes foreign stage failures into PipelineStageError", async () => {
		const r = makePipelineRegistry();
		r.register({
			def: { id: "foreign", stages: [{ id: "s" }] },
			stages: {
				// Deliberately violates the typed contract — the registry
				// still surfaces it as a typed stage error.
				s: {
					id: "s",
					run: () => Effect.fail("string failure" as never),
				},
			},
		});
		const error = await Effect.runPromise(Effect.flip(r.run("foreign", null)));
		expect(error).toMatchObject({
			_tag: "PipelineRunError",
			stageId: "s",
			message: "string failure",
		});
	});

	it("converts a synchronous throw from stage.run into a halt", async () => {
		const r = makePipelineRegistry();
		r.register({
			def: { id: "thrower", stages: [{ id: "s" }] },
			stages: {
				s: {
					id: "s",
					run: () => {
						throw new Error("sync boom");
					},
				},
			},
		});
		const error = await Effect.runPromise(Effect.flip(r.run("thrower", null)));
		expect(error).toMatchObject({ _tag: "PipelineRunError", message: "sync boom" });
	});

	it("normalizes a non-Error typed failure through toStageError", async () => {
		const r = makePipelineRegistry();
		r.register({
			def: { id: "err-obj", stages: [{ id: "s" }] },
			stages: {
				s: {
					id: "s",
					// Deliberately violates the typed contract with an
					// Error instance — the message branch of toStageError.
					run: () => Effect.fail(new Error("plain error") as never),
				},
			},
		});
		const error = await Effect.runPromise(Effect.flip(r.run("err-obj", null)));
		expect(error).toMatchObject({ _tag: "PipelineRunError", stageId: "s", message: "plain error" });
	});

	it("stringifies a synchronous non-Error throw", async () => {
		const r = makePipelineRegistry();
		r.register({
			def: { id: "throw-raw", stages: [{ id: "s" }] },
			stages: {
				s: {
					id: "s",
					run: () => {
						// Deliberately non-Error — exercises the String(cause) arm.
						throw { code: 7 };
					},
				},
			},
		});
		const error = await Effect.runPromise(Effect.flip(r.run("throw-raw", null)));
		expect(error).toMatchObject({ _tag: "PipelineRunError", message: "[object Object]" });
	});
});

describe("PipelineRegistry service + live layer", () => {
	it("resolves through the service tag and PipelineRegistryLive", async () => {
		const program = Effect.gen(function* () {
			const registry = yield* PipelineRegistry;
			registry.register(pack("via-service", [ok("s", { output: "done" })]));
			return yield* registry.run("via-service", null);
		});
		// Empty layer: registration happens through the service API.
		const result = await Effect.runPromise(program.pipe(Effect.provide(PipelineRegistryLive([]))));
		expect(result.state).toEqual({ s: "done" });
	});

	it("PipelineRegistryLive registers initial packs", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const registry = yield* PipelineRegistry;
				expect(registry.list().map((d) => d.id)).toEqual(["seeded"]);
				return yield* registry.run("seeded", null);
			}).pipe(Effect.provide(PipelineRegistryLive([pack("seeded", [ok("s", { output: 7 })])]))),
		);
		expect(result.state).toEqual({ s: 7 });
	});

	it("PipelineRegistryLive surfaces duplicate registration as a typed failure", async () => {
		const bad = PipelineRegistryLive([pack("dup", [ok("a", {})]), pack("dup", [ok("b", {})])]);
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				yield* PipelineRegistry;
				return "unreachable";
			}).pipe(Effect.provide(bad), Effect.exit),
		);
		// The registration throw rides the layer's error channel —
		// squash surfaces the typed error, not a defect.
		const squashed = exit._tag === "Failure" ? Cause.squash(exit.cause) : exit;
		expect(squashed).toBeInstanceOf(DuplicatePipelineError);
	});
});
