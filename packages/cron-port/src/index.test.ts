import { describe, expect, it } from "vitest";

import { makeCronRegistry, type CronDescriptor } from "./index.ts";

const job = (id: string, schedules: string[], outcome = { ok: true }): CronDescriptor => ({
	id,
	schedules,
	run: async () => outcome,
});

describe("makeCronRegistry", () => {
	it("lists jobs with their schedules and descriptions", () => {
		const registry = makeCronRegistry([
			{ ...job("a", ["*/5 * * * *"]), description: "sweep" },
			job("b", ["17 3 * * *"]),
		]);
		expect(registry.list()).toEqual([
			{ id: "a", schedules: ["*/5 * * * *"], description: "sweep" },
			{ id: "b", schedules: ["17 3 * * *"], description: undefined },
		]);
	});

	it("returns the unique union of schedules for trigger provisioning", () => {
		const registry = makeCronRegistry([
			job("a", ["*/5 * * * *", "17 3 * * *"]),
			job("b", ["17 3 * * *"]),
			job("c", ["0 * * * *"]),
		]);
		expect(registry.schedules()).toEqual(["*/5 * * * *", "17 3 * * *", "0 * * * *"]);
	});

	it("dispatches every job bound to the fired expression, in order", async () => {
		const calls: string[] = [];
		const registry = makeCronRegistry([
			{
				id: "a",
				schedules: ["*/5 * * * *"],
				run: async () => {
					calls.push("a");
					return { ok: true, summary: "a done" };
				},
			},
			{
				id: "b",
				schedules: ["17 3 * * *"],
				run: async () => {
					calls.push("b");
					return { ok: true };
				},
			},
			{
				id: "c",
				schedules: ["*/5 * * * *", "17 3 * * *"],
				run: async () => {
					calls.push("c");
					return { ok: true };
				},
			},
		]);
		const five = await registry.dispatch("*/5 * * * *");
		expect(five.map((r) => r.id)).toEqual(["a", "c"]);
		expect(calls).toEqual(["a", "c"]);
		calls.length = 0;
		const daily = await registry.dispatch("17 3 * * *");
		expect(daily.map((r) => r.id)).toEqual(["b", "c"]);
		expect(calls).toEqual(["b", "c"]);
	});

	it("returns an empty result for unknown expressions", async () => {
		const registry = makeCronRegistry([job("a", ["*/5 * * * *"])]);
		expect(await registry.dispatch("0 0 1 1 *")).toEqual([]);
	});

	it("collapses thrown errors into failed outcomes without starving siblings", async () => {
		const registry = makeCronRegistry([
			{
				id: "bad",
				schedules: ["* * * * *"],
				run: async () => {
					throw new Error("boom");
				},
			},
			job("good", ["* * * * *"]),
		]);
		const results = await registry.dispatch("* * * * *");
		expect(results[0]).toEqual({ id: "bad", outcome: { ok: false, error: "boom" } });
		expect(results[1]).toEqual({ id: "good", outcome: { ok: true } });
	});

	it("stringifies non-Error throws", async () => {
		const registry = makeCronRegistry([
			{
				id: "bad",
				schedules: ["* * * * *"],
				run: async () => {
					// eslint-disable-next-line @typescript-eslint/only-throw-error
					throw "string failure";
				},
			},
		]);
		const results = await registry.dispatch("* * * * *");
		expect(results[0]?.outcome).toEqual({ ok: false, error: "string failure" });
	});

	it("runById fires a single job and returns null for unknown ids", async () => {
		let fired = 0;
		const registry = makeCronRegistry([
			{
				id: "a",
				schedules: ["*/5 * * * *"],
				run: async () => {
					fired += 1;
					return { ok: true, summary: "ran" };
				},
			},
		]);
		expect(await registry.runById("missing")).toBeNull();
		expect(await registry.runById("a")).toEqual({
			id: "a",
			outcome: { ok: true, summary: "ran" },
		});
		expect(fired).toBe(1);
	});

	it("keeps the first registration on duplicate ids", async () => {
		const registry = makeCronRegistry([
			{ ...job("a", ["* * * * *"]), description: "first" },
			{ ...job("a", ["0 0 * * *"]), description: "second" },
		]);
		expect(registry.list()).toEqual([{ id: "a", schedules: ["* * * * *"], description: "first" }]);
		expect(registry.schedules()).toEqual(["* * * * *"]);
	});

	it("resolves an empty registry", async () => {
		const registry = makeCronRegistry([]);
		expect(registry.list()).toEqual([]);
		expect(registry.schedules()).toEqual([]);
		expect(await registry.dispatch("* * * * *")).toEqual([]);
		expect(await registry.runById("x")).toBeNull();
	});
});
