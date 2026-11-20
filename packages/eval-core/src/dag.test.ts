import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";

import { BatchDefect } from "./batch.ts";
import {
	builtinConditionContributions,
	buildStagePlan,
	builtinConditions,
	runStageGraph,
	StageGraphError,
	UnknownConditionError,
	type StageNodeOutcome,
} from "./dag.ts";

const statuses = (outcomes: readonly StageNodeOutcome<unknown, unknown>[]) =>
	Object.fromEntries(outcomes.map((o) => [o.node.id, o.status]));

describe("buildStagePlan", () => {
	it("string entries form a linear chain (declared order = needs)", () => {
		const plan = buildStagePlan(["a", "b", "c"]);
		expect(plan.levels.map((l) => l.map((n) => n.id))).toEqual([["a"], ["b"], ["c"]]);
		expect(plan.nodes.map((n) => n.needs)).toEqual([[], ["a"], ["a", "b"]]);
		// Single root ancestor → every node branches from "a".
		expect(plan.nodes.map((n) => n.branch)).toEqual(["a", "a", "a"]);
	});

	it("explicit needs declare edges; needs: [] starts a parallel branch", () => {
		const plan = buildStagePlan([
			"root",
			{ id: "left", needs: ["root"] },
			{ id: "right", needs: [] },
			{ id: "merge", needs: ["left", "right"] },
		]);
		expect(plan.levels.map((l) => l.map((n) => n.id))).toEqual([
			["root", "right"],
			["left"],
			["merge"],
		]);
		// "right" is its own root; "merge" fans in from two roots → no branch.
		expect(plan.byId.get("right")!.branch).toBe("right");
		expect(plan.byId.get("merge")!.branch).toBeUndefined();
		expect(plan.byId.get("left")!.branch).toBe("root");
	});

	it("absent needs on a node depends on all earlier entries", () => {
		const plan = buildStagePlan(["a", { id: "b", needs: [] }, "c"]);
		// "c" has no needs key → depends on BOTH earlier entries.
		expect(plan.byId.get("c")!.needs).toEqual(["a", "b"]);
		expect(plan.levels.map((l) => l.map((n) => n.id))).toEqual([["a", "b"], ["c"]]);
	});

	it("dedupes repeated needs and allows forward references", () => {
		const plan = buildStagePlan([
			{ id: "a", needs: ["b", "b"] },
			{ id: "b", needs: [] },
		]);
		expect(plan.byId.get("a")!.needs).toEqual(["b"]);
		expect(plan.levels.map((l) => l.map((n) => n.id))).toEqual([["b"], ["a"]]);
	});

	it("rejects duplicate stage ids", () => {
		expect(() => buildStagePlan(["a", "a"])).toThrowError(StageGraphError);
		expect(() => buildStagePlan(["a", "a"])).toThrowError(/duplicate stage id "a"/);
	});

	it("rejects self-needs and unknown needs", () => {
		expect(() => buildStagePlan([{ id: "a", needs: ["a"] }])).toThrowError(/cannot need itself/);
		expect(() => buildStagePlan([{ id: "a", needs: ["ghost"] }])).toThrowError(
			/needs unknown stage "ghost"/,
		);
	});

	it("rejects dependency cycles", () => {
		try {
			buildStagePlan([
				{ id: "a", needs: ["c"] },
				{ id: "b", needs: ["a"] },
				{ id: "c", needs: ["b"] },
			]);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(StageGraphError);
			expect(e).toMatchObject({ _tag: "StageGraphError" });
			expect((e as StageGraphError).message).toBe("stage graph has a dependency cycle");
			// The detail names the stuck nodes — the cycle diagnostic.
			expect((e as StageGraphError).detail).toBe("stuck: a, b, c");
		}
	});

	it("errors without detail omit the key entirely", () => {
		try {
			buildStagePlan(["a", "a"]);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toMatchObject({ _tag: "StageGraphError" });
			expect("detail" in (e as object)).toBe(false);
		}
	});
});

describe("runStageGraph", () => {
	const runOf = (fn: (id: string) => Effect.Effect<string, Error>) => (node: { id: string }) =>
		fn(node.id);

	it("runs a linear graph in order and returns declared-order outcomes", async () => {
		const seen: string[] = [];
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: ["a", "b", "c"],
				run: (n) =>
					Effect.sync(() => {
						seen.push(n.id);
						return n.id.toUpperCase();
					}),
			}),
		);
		expect(seen).toEqual(["a", "b", "c"]);
		expect(outcomes.map((o) => [o.node.id, o.status, o.value])).toEqual([
			["a", "ok", "A"],
			["b", "ok", "B"],
			["c", "ok", "C"],
		]);
		expect(outcomes[0]!.node.needs).toEqual([]);
		expect(outcomes[1]!.node.branch).toBe("a");
	});

	it("runs independent branches concurrently within a level", async () => {
		const started: string[] = [];
		let release!: () => void;
		const blocker = new Promise<void>((r) => {
			release = r;
		});
		const outcomes = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					runStageGraph({
						entries: [
							{ id: "a", needs: [] },
							{ id: "b", needs: [] },
							{ id: "join", needs: ["a", "b"] },
						],
						concurrency: 2,
						run: (n) =>
							Effect.promise(async () => {
								started.push(n.id);
								if (n.id !== "join") await blocker;
								return n.id;
							}),
					}),
				);
				// Let both roots start, then release them.
				yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)));
				expect(started.sort()).toEqual(["a", "b"]);
				release();
				return yield* Fiber.join(fiber);
			}),
		);
		expect(statuses(outcomes)).toEqual({ a: "ok", b: "ok", join: "ok" });
	});

	it("fails the graph build on invalid entries", async () => {
		const err = await Effect.runPromise(
			runStageGraph({ entries: ["a", "a"], run: () => Effect.succeed("x") }).pipe(Effect.flip),
		);
		expect(err).toBeInstanceOf(StageGraphError);
	});

	it("collects typed failures per node and skips dependents", async () => {
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: ["a", "b", "c"],
				run: runOf((id) => (id === "b" ? Effect.fail(new Error("boom")) : Effect.succeed(id))),
			}),
		);
		expect(outcomes.map((o) => o.status)).toEqual(["ok", "failed", "skipped"]);
		expect(outcomes[1]!.error).toBeInstanceOf(Error);
		expect(outcomes[2]!.reason).toBe('dependency "b" failed');
	});

	it("optional nodes tolerate their own failure — dependents still run", async () => {
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: ["a", { id: "b", optional: true }, { id: "c", needs: ["a", "b"] }],
				run: runOf((id) => (id === "b" ? Effect.fail(new Error("soft")) : Effect.succeed(id))),
			}),
		);
		expect(statuses(outcomes)).toEqual({ a: "ok", b: "failed", c: "ok" });
	});

	it("a skipped dependency always blocks its dependents", async () => {
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: [
					{ id: "a", when: { condition: "never" } },
					{ id: "b", needs: ["a"] },
				],
				run: () => Effect.succeed("x"),
				conditions: builtinConditions,
			}),
		);
		expect(outcomes[0]!.status).toBe("skipped");
		expect(outcomes[0]!.reason).toBe('condition "never" false');
		expect(outcomes[1]!.status).toBe("skipped");
		expect(outcomes[1]!.reason).toBe('dependency "a" skipped');
	});

	it("when conditions see prior outputs (builtin nonempty)", async () => {
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: [
					"produce",
					{ id: "maybe", when: { condition: "nonempty", params: { key: "produce" } } },
				],
				run: () => Effect.succeed("payload"),
				conditions: builtinConditions,
			}),
		);
		expect(statuses(outcomes)).toEqual({ produce: "ok", maybe: "ok" });
	});

	it("an Effect-returning evaluator works and sees outputs", async () => {
		const outcomes = await Effect.runPromise(
			runStageGraph<string, Error, never>({
				entries: ["a", { id: "b", needs: [], when: { condition: "check" } }],
				run: () => Effect.succeed("v"),
				conditions: {
					check: ({ outputs }) => Effect.succeed(outputs.get("a") === "v"),
				},
			}),
		);
		expect(statuses(outcomes)).toEqual({ a: "ok", b: "ok" });
	});

	it("a missing condition evaluator fails the node (never silently runs)", async () => {
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: [{ id: "a", when: { condition: "ghost" } }],
				run: () => Effect.succeed("x"),
			}),
		);
		expect(outcomes[0]!.status).toBe("failed");
		const err = outcomes[0]!.error;
		expect(err).toBeInstanceOf(UnknownConditionError);
		expect(err).toMatchObject({
			_tag: "UnknownConditionError",
			condition: "ghost",
			stage: "a",
		});
	});

	it("a throwing condition evaluator surfaces as a BatchDefect outcome", async () => {
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: [{ id: "a", when: { condition: "explode" } }],
				run: () => Effect.succeed("x"),
				conditions: {
					explode: () => {
						throw new Error("eval boom");
					},
				},
			}),
		);
		expect(outcomes[0]!.status).toBe("failed");
		expect(outcomes[0]!.error).toBeInstanceOf(BatchDefect);
		expect(outcomes[0]!.error).toMatchObject({ _tag: "BatchDefect" });
		expect((outcomes[0]!.error as BatchDefect).message).toContain("eval boom");
		expect((outcomes[0]!.error as BatchDefect).defect).toBeInstanceOf(Error);
	});

	it("a step defect becomes a BatchDefect outcome, not a crash", async () => {
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: ["a", "b"],
				run: (n) => (n.id === "a" ? Effect.die(new Error("defect")) : Effect.succeed("ok")),
			}),
		);
		expect(outcomes[0]!.status).toBe("failed");
		expect(outcomes[0]!.error).toBeInstanceOf(BatchDefect);
		expect(outcomes[0]!.error).toMatchObject({ _tag: "BatchDefect" });
		expect((outcomes[0]!.error as BatchDefect).message).toContain("defect");
		// "b" depends on "a" (linear default) → skipped.
		expect(outcomes[1]!.status).toBe("skipped");
	});

	it("a typed step failure surfaces the typed error, not a BatchDefect", async () => {
		const failure = new Error("boom");
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: ["a", { id: "b", needs: [] }],
				run: (n) => (n.id === "a" ? Effect.fail(failure) : Effect.succeed("ok")),
			}),
		);
		expect(outcomes[0]!.status).toBe("failed");
		expect(outcomes[0]!.error).toBe(failure);
		expect(outcomes[0]!.error).not.toBeInstanceOf(BatchDefect);
	});

	it("honors the concurrency bound within a level", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: [
					{ id: "a", needs: [] },
					{ id: "b", needs: [] },
					{ id: "c", needs: [] },
					{ id: "d", needs: [] },
				],
				concurrency: 2,
				run: (n) =>
					Effect.gen(function* () {
						inFlight++;
						maxInFlight = Math.max(maxInFlight, inFlight);
						yield* Effect.sleep("30 millis");
						inFlight--;
						return n.id;
					}),
			}),
		);
		expect(outcomes.every((o) => o.status === "ok")).toBe(true);
		expect(maxInFlight).toBe(2);
	});

	it("a skipped OPTIONAL dependency still blocks its dependents", async () => {
		const outcomes = await Effect.runPromise(
			runStageGraph({
				entries: [
					{ id: "a", when: { condition: "never" } },
					{ id: "b", needs: ["a"], optional: true },
					{ id: "c", needs: ["b"] },
				],
				run: () => Effect.succeed("x"),
				conditions: builtinConditions,
			}),
		);
		expect(statuses(outcomes)).toEqual({ a: "skipped", b: "skipped", c: "skipped" });
		expect(outcomes[2]!.reason).toBe('dependency "b" skipped');
	});
});

describe("builtinConditions", () => {
	it("nonempty checks presence + emptiness across value shapes", () => {
		const outputs = new Map<string, unknown>([
			["s", "  "],
			["t", "x"],
			["e", ""],
			["arr", []],
			["arr2", [1]],
			["n", null],
			["num", 0],
		]);
		const ctx = { params: { key: "t" }, outputs };
		expect(builtinConditions.nonempty!(ctx)).toBe(true);
		expect(builtinConditions.nonempty!({ ...ctx, params: { key: "s" } })).toBe(false);
		expect(builtinConditions.nonempty!({ ...ctx, params: { key: "e" } })).toBe(false);
		expect(builtinConditions.nonempty!({ ...ctx, params: { key: "arr" } })).toBe(false);
		expect(builtinConditions.nonempty!({ ...ctx, params: { key: "arr2" } })).toBe(true);
		expect(builtinConditions.nonempty!({ ...ctx, params: { key: "n" } })).toBe(false);
		expect(builtinConditions.nonempty!({ ...ctx, params: { key: "num" } })).toBe(true);
		expect(builtinConditions.nonempty!({ ...ctx, params: { key: "missing" } })).toBe(false);
		expect(builtinConditions.nonempty!({ ...ctx, params: {} })).toBe(false);
		expect(builtinConditions.nonempty!({ ...ctx, params: { key: 42 } })).toBe(false);
		expect(builtinConditions.nonempty!({ ...ctx, params: undefined })).toBe(false);
		// A non-string key is rejected even if outputs holds that exact
		// (non-string) key — stage ids are always strings.
		const numericOutputs = new Map<unknown, unknown>([[42, "x"]]);
		expect(
			builtinConditions.nonempty!({
				params: { key: 42 },
				outputs: numericOutputs as never,
			}),
		).toBe(false);
	});

	it("always/never are constant", () => {
		const ctx = { params: undefined, outputs: new Map() };
		expect(builtinConditions.always!(ctx)).toBe(true);
		expect(builtinConditions.never!(ctx)).toBe(false);
	});
});

describe("builtinConditionContributions (P-078)", () => {
	const validator = (id: string) =>
		builtinConditionContributions.find((c) => c.id === id)!.validateConfig!;

	it("declares eval.condition contributions for each builtin", () => {
		expect(builtinConditionContributions.map((c) => `${c.kind}:${c.id}`)).toEqual([
			"eval.condition:nonempty",
			"eval.condition:always",
			"eval.condition:never",
		]);
		for (const c of builtinConditionContributions) {
			expect(c.version).toBe("1");
			expect(c.meta).toEqual({ builtin: true });
		}
	});

	it("nonempty requires a string key param and rejects unknown keys", () => {
		const v = validator("nonempty");
		expect(v(undefined)).toEqual({
			ok: false,
			error: 'condition param "key" must be a non-empty string',
		});
		expect(v({ key: "stage" })).toEqual({ ok: true, config: { key: "stage" } });
		expect(v({ key: 1 })).toEqual({
			ok: false,
			error: 'condition param "key" must be a non-empty string',
		});
		// An empty-string key is just as invalid as a missing one.
		expect(v({ key: "" })).toEqual({
			ok: false,
			error: 'condition param "key" must be a non-empty string',
		});
		expect(v({ key: "s", extra: 1 })).toEqual({
			ok: false,
			error: 'unknown condition param "extra" (known: key)',
		});
		expect(v("nope")).toEqual({ ok: false, error: "condition params must be a JSON object" });
		expect(v(null)).toEqual({ ok: false, error: "condition params must be a JSON object" });
		// Arrays are not JSON objects for params purposes.
		expect(v([1, 2])).toEqual({ ok: false, error: "condition params must be a JSON object" });
	});

	it("always/never reject any declared params", () => {
		for (const id of ["always", "never"]) {
			const v = validator(id);
			expect(v(undefined)).toEqual({ ok: true, config: {} });
			expect(v({})).toEqual({ ok: true, config: {} });
			expect(v({ anything: 1 })).toEqual({
				ok: false,
				error: 'unknown condition param "anything" (known: none)',
			});
		}
	});
});
