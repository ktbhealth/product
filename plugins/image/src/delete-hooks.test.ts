import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	ImageDeleteHooks,
	ImageDeleteHooksLive,
	type ImageDeleteHook,
	type ImageReferencerItem,
} from "./delete-hooks.ts";

/** Fresh runtime per test — the hook registry is per-layer, so tests
 * never leak registrations into each other. */
const run = async <A>(eff: Effect.Effect<A, unknown, ImageDeleteHooks>): Promise<A> => {
	const runtime = ManagedRuntime.make(ImageDeleteHooksLive);
	try {
		return await runtime.runPromise(eff);
	} finally {
		await runtime.dispose();
	}
};

const hook = (
	id: string,
	usage: ImageDeleteHook["usage"],
	cleanup: ImageDeleteHook["cleanup"] = () => Effect.void,
): ImageDeleteHook => ({ id, usage, cleanup });

const item = (id: number | string, title = `item-${id}`): ImageReferencerItem => ({ id, title });

describe("ImageDeleteHooksLive", () => {
	it("returns an empty owner list when no hooks are registered", async () => {
		const owners = await run(
			Effect.gen(function* () {
				const hooks = yield* ImageDeleteHooks;
				return yield* hooks.usage(1);
			}),
		);
		expect(owners).toEqual([]);
	});

	it("dedupes registrations by id — the latest hook wins", async () => {
		const calls: string[] = [];
		const owners = await run(
			Effect.gen(function* () {
				const hooks = yield* ImageDeleteHooks;
				yield* hooks.register(
					hook(
						"builder",
						() => Effect.succeed([item(1, "stale")]),
						() => Effect.sync(() => calls.push("stale")),
					),
				);
				yield* hooks.register(
					hook(
						"builder",
						() => Effect.succeed([item(2, "fresh")]),
						() => Effect.sync(() => calls.push("fresh")),
					),
				);
				return yield* hooks.usage(7);
			}),
		);
		expect(owners).toEqual([{ id: "builder", items: [item(2, "fresh")] }]);
		await run(
			Effect.gen(function* () {
				const hooks = yield* ImageDeleteHooks;
				yield* hooks.register(
					hook(
						"builder",
						() => Effect.succeed([]),
						() => Effect.sync(() => calls.push("fresh2")),
					),
				);
				yield* hooks.cleanup(7, "act");
			}),
		);
		expect(calls).toEqual(["fresh2"]);
	});

	it("groups usage by hook id and omits owners with zero referents", async () => {
		const owners = await run(
			Effect.gen(function* () {
				const hooks = yield* ImageDeleteHooks;
				yield* hooks.register(hook("a", () => Effect.succeed([item(1), item("doc-9")])));
				yield* hooks.register(hook("b", () => Effect.succeed([])));
				yield* hooks.register(hook("c", () => Effect.succeed([item(3, "with path")])));
				return yield* hooks.usage(9);
			}),
		);
		expect(owners).toEqual([
			{ id: "a", items: [item(1), item("doc-9")] },
			{ id: "c", items: [item(3, "with path")] },
		]);
	});

	it("cleanup fans out to every registered hook with the same args", async () => {
		const calls: Array<readonly [number, string]> = [];
		await run(
			Effect.gen(function* () {
				const hooks = yield* ImageDeleteHooks;
				yield* hooks.register(
					hook(
						"a",
						() => Effect.succeed([]),
						(imageId, actionId) => Effect.sync(() => calls.push([imageId, actionId])),
					),
				);
				yield* hooks.register(
					hook(
						"b",
						() => Effect.succeed([]),
						(imageId, actionId) => Effect.sync(() => calls.push([imageId, actionId])),
					),
				);
				yield* hooks.cleanup(42, "builder.unlink");
			}),
		);
		expect(calls).toEqual([
			[42, "builder.unlink"],
			[42, "builder.unlink"],
		]);
	});

	it("cleanup aborts on the first hook failure — later hooks never run", async () => {
		const later: string[] = [];
		const failure = new Error("cleanup boom");
		await expect(
			run(
				Effect.gen(function* () {
					const hooks = yield* ImageDeleteHooks;
					yield* hooks.register(
						hook(
							"a",
							() => Effect.succeed([]),
							() => Effect.fail(failure),
						),
					);
					yield* hooks.register(
						hook(
							"b",
							() => Effect.succeed([]),
							() => Effect.sync(() => later.push("b")),
						),
					);
					yield* hooks.cleanup(1, "act");
				}),
			),
		).rejects.toBe(failure);
		expect(later).toEqual([]);
	});

	it("usage propagates hook failures instead of hiding referencers", async () => {
		const failure = { _tag: "HookBoom" };
		await expect(
			run(
				Effect.gen(function* () {
					const hooks = yield* ImageDeleteHooks;
					yield* hooks.register(hook("a", () => Effect.fail(failure)));
					yield* hooks.usage(1);
				}),
			),
		).rejects.toMatchObject({ _tag: "HookBoom" });
	});
});
