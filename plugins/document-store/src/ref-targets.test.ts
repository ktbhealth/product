import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import {
	DocumentRefTargets,
	DocumentRefTargetsLive,
	makeDocumentRefTargets,
	registerRefTarget,
	registerRefTargetIfPresent,
	type RefTargetExists,
} from "./ref-targets.ts";

/** Run a checker to completion — its `unknown` requirements are
 * erased exactly like the service does (test checkers are pure). */
const runChecker = (checker: RefTargetExists, ids: readonly number[] = []) =>
	Effect.runPromise(checker(ids) as Effect.Effect<ReadonlySet<number>, never, never>);

/** Checker returning a fixed existence set regardless of the ids
 * asked about — tests only need the batched-call contract. */
const existsOf =
	(found: readonly number[]): RefTargetExists =>
	() =>
		Effect.succeed(new Set(found));

describe("makeDocumentRefTargets", () => {
	it("register/get round-trips checkers", async () => {
		const targets = makeDocumentRefTargets();
		const exists = existsOf([1, 2]);
		await Effect.runPromise(targets.register("patients", exists));
		expect(targets.get("patients")).toBe(exists);
		expect(targets.get("wards")).toBeUndefined();
	});

	it("duplicate registration dies as a defect", async () => {
		const targets = makeDocumentRefTargets();
		await Effect.runPromise(targets.register("patients", existsOf([])));
		await expect(Effect.runPromise(targets.register("patients", existsOf([])))).rejects.toThrow(
			/duplicate document ref target/,
		);
	});
});

describe("DocumentRefTargetsLive", () => {
	it("provides a shared registry service", async () => {
		const program = Effect.gen(function* () {
			const targets = yield* DocumentRefTargets;
			yield* targets.register("patients", existsOf([7]));
			return targets.get("patients");
		});
		const checker = await Effect.runPromise(program.pipe(Effect.provide(DocumentRefTargetsLive)));
		expect(checker).toBeDefined();
		const found = await runChecker(checker!);
		expect([...found]).toEqual([7]);
	});
});

describe("registerRefTarget", () => {
	it("registers through the provided service", async () => {
		const program = Effect.gen(function* () {
			yield* registerRefTarget("patients", existsOf([3]));
			const targets = yield* DocumentRefTargets;
			return targets.get("patients");
		});
		const checker = await Effect.runPromise(program.pipe(Effect.provide(DocumentRefTargetsLive)));
		const found = await runChecker(checker!);
		expect([...found]).toEqual([3]);
	});
});

describe("registerRefTargetIfPresent", () => {
	it("no-ops when the service is absent", async () => {
		await expect(
			Effect.runPromise(registerRefTargetIfPresent("patients", existsOf([1]))),
		).resolves.toBeUndefined();
	});

	it("registers when the service is present", async () => {
		const program = Effect.gen(function* () {
			yield* registerRefTargetIfPresent("patients", existsOf([4]));
			const targets = yield* DocumentRefTargets;
			return targets.get("patients");
		});
		const checker = await Effect.runPromise(program.pipe(Effect.provide(DocumentRefTargetsLive)));
		const found = await runChecker(checker!);
		expect([...found]).toEqual([4]);
	});
});
