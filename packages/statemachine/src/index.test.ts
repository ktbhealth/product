import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
	commit,
	defineStateMachine,
	InvalidTransitionError,
	StateNotFoundError,
	StateStoreError,
	TransitionConflictError,
	TransitionRejectedError,
	type StateStore,
} from "./index.ts";

// A small lifecycle shaped like the plugin machines this kit absorbs:
// a queued job that may fail and be retried, or complete.
const jobMachine = defineStateMachine({
	id: "test.job",
	initial: "queued",
	states: {
		queued: { on: { begin: "processing", fail: "failed", retry: "queued" } },
		processing: {
			on: {
				complete: "done",
				fail: "failed",
				retry: { to: "queued", guard: () => false },
			},
		},
		done: {},
		failed: { on: { retry: "queued" } },
	},
	terminal: ["done"],
});

describe("defineStateMachine", () => {
	it("declares topology and answers legality queries", () => {
		expect(jobMachine.initial).toBe("queued");
		expect(jobMachine.states).toEqual(["queued", "processing", "done", "failed"]);
		expect(jobMachine.can("queued", "begin")).toBe(true);
		expect(jobMachine.can("done", "begin")).toBe(false);
		expect(jobMachine.can("queued", "complete")).toBe(false);
		expect(jobMachine.events("processing")).toEqual(["complete", "fail", "retry"]);
		expect(jobMachine.isTerminal("done")).toBe(true);
		expect(jobMachine.isTerminal("failed")).toBe(false);
		expect(jobMachine.isState("queued")).toBe(true);
		expect(jobMachine.isState("bogus")).toBe(false);
		expect(jobMachine.isState(42)).toBe(false);
	});

	it("predecessors/edges derive conditional-write source sets", () => {
		expect(jobMachine.predecessors("retry")).toEqual(["queued", "processing", "failed"]);
		expect(jobMachine.predecessors("retry", "queued")).toEqual(["queued", "processing", "failed"]);
		expect(jobMachine.edges("fail")).toEqual([
			{ from: "queued", to: "failed" },
			{ from: "processing", to: "failed" },
		]);
	});

	it("throws at declaration on undeclared targets", () => {
		expect(() =>
			defineStateMachine({
				id: "bad",
				initial: "a",
				states: { a: { on: { go: "b" } }, b: {} } as never,
			}),
		).not.toThrow();
		expect(() =>
			defineStateMachine({
				id: "bad2",
				initial: "a",
				// @ts-expect-error -- deliberately undeclared target
				states: { a: { on: { go: "zzz" } } },
			}),
		).toThrow("targets an undeclared state");
	});
});

describe("step", () => {
	it("returns the transition result for a legal move", async () => {
		const result = await Effect.runPromise(jobMachine.step("queued", "begin"));
		expect(result).toEqual({ from: "queued", event: "begin", to: "processing", reentered: false });
	});

	it("marks self-transitions as reentered", async () => {
		const result = await Effect.runPromise(jobMachine.step("queued", "retry"));
		expect(result.to).toBe("queued");
		expect(result.reentered).toBe(true);
	});

	it("fails InvalidTransitionError on undeclared events and foreign states", async () => {
		const undeclared = await Effect.runPromise(Effect.flip(jobMachine.step("done", "begin")));
		expect(undeclared).toBeInstanceOf(InvalidTransitionError);
		expect((undeclared as InvalidTransitionError).from).toBe("done");

		const foreign = await Effect.runPromise(
			// @ts-expect-error -- runtime foreign state
			Effect.flip(jobMachine.step("bogus", "begin")),
		);
		expect(foreign).toBeInstanceOf(InvalidTransitionError);
		expect((foreign as InvalidTransitionError).from).toBe("bogus");
	});

	it("rejects when the guard returns false", async () => {
		const error = await Effect.runPromise(Effect.flip(jobMachine.step("processing", "retry")));
		expect(error).toBeInstanceOf(TransitionRejectedError);
		expect((error as TransitionRejectedError).cause).toBeUndefined();
	});

	it("rejects with cause when the guard effect fails", async () => {
		const guarded = defineStateMachine({
			id: "guarded",
			initial: "a",
			states: {
				a: {
					on: {
						go: {
							to: "b",
							guard: () => Effect.fail(new Error("db down")),
						},
					},
				},
				b: {},
			},
		});
		const error = await Effect.runPromise(Effect.flip(guarded.step("a", "go")));
		expect(error).toBeInstanceOf(TransitionRejectedError);
		const cause = (error as TransitionRejectedError).cause;
		expect(cause).toBeInstanceOf(Error);
		expect((cause as Error).message).toBe("db down");
	});

	it("passes context to guards", async () => {
		const ctxMachine = defineStateMachine<"a" | "b", "go", { allowed: boolean }>({
			id: "ctx",
			initial: "a",
			states: {
				a: { on: { go: { to: "b", guard: (input) => input.context.allowed } } },
				b: {},
			},
		});
		const ok = await Effect.runPromise(ctxMachine.step("a", "go", { allowed: true }));
		expect(ok.to).toBe("b");
		const no = await Effect.runPromise(Effect.flip(ctxMachine.step("a", "go", { allowed: false })));
		expect(no).toBeInstanceOf(TransitionRejectedError);
	});
});

describe("commit", () => {
	/** In-memory store: load reads a cell, save lands only when the
	 * cell still holds `from` — the optimistic-concurrency contract. */
	const makeStore = (initial: string | undefined) => {
		const cell = { value: initial as string | undefined };
		const saves: { from: string; to: string }[] = [];
		const store: StateStore<"queued" | "processing" | "done" | "failed"> = {
			load: () =>
				Effect.succeed(cell.value === undefined ? Option.none() : Option.some(cell.value as never)),
			save: ({ from, to }) =>
				Effect.sync(() => {
					// from === null means the entity was absent at load —
					// the write lands only while it stays absent.
					const matches = from === null ? cell.value === undefined : cell.value === from;
					if (!matches) return false;
					cell.value = to;
					saves.push({ from: from ?? "∅", to });
					return true;
				}),
		};
		return { cell, saves, store };
	};

	it("loads, steps and conditionally saves", async () => {
		const { cell, saves, store } = makeStore("queued");
		const result = await Effect.runPromise(commit(jobMachine, store, "begin"));
		expect(result.to).toBe("processing");
		expect(cell.value).toBe("processing");
		expect(saves).toEqual([{ from: "queued", to: "processing" }]);
	});

	it("fails StateNotFoundError when the row is missing and no initial is given", async () => {
		const { store } = makeStore(undefined);
		const error = await Effect.runPromise(Effect.flip(commit(jobMachine, store, "begin")));
		expect(error).toBeInstanceOf(StateNotFoundError);
	});

	it("uses opts.initial when the row is missing", async () => {
		const { cell, store } = makeStore(undefined);
		const result = await Effect.runPromise(
			commit(jobMachine, store, "begin", { initial: "queued" }),
		);
		expect(result.from).toBe("queued");
		expect(cell.value).toBe("processing");
	});

	it("fails TransitionConflictError when the conditional save loses the race", async () => {
		const { cell, store } = makeStore("queued");
		// Simulate a concurrent writer moving the row between load and
		// save: wrap save to mutate the cell first, then report the
		// conditional result honestly.
		const racing: StateStore<"queued" | "processing" | "done" | "failed"> = {
			load: store.load,
			save: ({ from, to }) =>
				Effect.sync(() => {
					cell.value = "failed"; // concurrent transition wins
					const matches = from === null ? cell.value === undefined : cell.value === from;
					return matches ? ((cell.value = to), true) : false;
				}),
		};
		const error = await Effect.runPromise(Effect.flip(commit(jobMachine, racing, "begin")));
		expect(error).toBeInstanceOf(TransitionConflictError);
		expect(cell.value).toBe("failed");
	});

	it("propagates InvalidTransition for a persisted state with no edge", async () => {
		const { store } = makeStore("done");
		const error = await Effect.runPromise(Effect.flip(commit(jobMachine, store, "begin")));
		expect(error).toBeInstanceOf(InvalidTransitionError);
	});

	it("normalizes store failures into StateStoreError", async () => {
		const boom = new Error("db gone");
		const failingLoad: StateStore<"queued" | "processing" | "done" | "failed"> = {
			load: () => Effect.fail(boom),
			save: () => Effect.succeed(true),
		};
		const error = await Effect.runPromise(Effect.flip(commit(jobMachine, failingLoad, "begin")));
		expect(error).toBeInstanceOf(StateStoreError);
		expect((error as StateStoreError).op).toBe("load");
		expect((error as StateStoreError).cause).toBe(boom);
	});
});
