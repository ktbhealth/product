import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ElementKinds, ElementKindsLive } from "@ktb/platform/element-kinds";

import { BUILDER_BLOCKS_ELEMENT_KINDS_LIVE } from "./element-kinds.ts";
import { BUILDER_BLOCK_KINDS } from "./kinds.tsx";

/** Mirror the app-host composition: `core` (ElementKinds) is merged at
 * top level AND provided into the plugin layer — the same layer object,
 * so the registry instance is shared (same contract as
 * plugins/rich-text/src/element-kind.test.ts). */
const composed = () => {
	const core = ElementKindsLive;
	return Layer.mergeAll(core, BUILDER_BLOCKS_ELEMENT_KINDS_LIVE.pipe(Layer.provide(core)));
};

describe("BUILDER_BLOCKS_ELEMENT_KINDS_LIVE", () => {
	it("registers every block kind into ElementKinds", async () => {
		const program = Effect.gen(function* () {
			const kinds = yield* ElementKinds;
			return kinds.list().map((kind) => kind.kind);
		});
		const registered = await Effect.runPromise(program.pipe(Effect.provide(composed())));
		expect(registered).toEqual(BUILDER_BLOCK_KINDS.map((kind) => kind.kind));
	});

	it("resolve is the identity — the stored ref IS the props payload", async () => {
		const program = Effect.gen(function* () {
			const kinds = yield* ElementKinds;
			const heading = kinds.get("heading");
			if (heading === undefined) return "missing";
			return yield* heading.resolve({ text: "Hi", level: "h1" });
		});
		const resolved = await Effect.runPromise(program.pipe(Effect.provide(composed())));
		expect(resolved).toEqual({ text: "Hi", level: "h1" });
	});

	it("builds without the ElementKinds registry (optional consumer)", async () => {
		await expect(
			Effect.runPromise(Effect.void.pipe(Effect.provide(BUILDER_BLOCKS_ELEMENT_KINDS_LIVE))),
		).resolves.toBeUndefined();
	});
});
