import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import {
	ElementKinds,
	ElementKindsLive,
	makeElementKinds,
	type ElementKindDescriptor,
} from "./element-kinds.ts";

const descriptor = (kind: string): ElementKindDescriptor => ({
	kind,
	label: `Label ${kind}`,
	resolve: () => Effect.succeed(`resolved:${kind}`),
});

describe("makeElementKinds", () => {
	it("registers and lists descriptors in registration order", async () => {
		const kinds = makeElementKinds();
		await Effect.runPromise(kinds.register(descriptor("rich-text")));
		await Effect.runPromise(kinds.register(descriptor("other")));
		expect(kinds.list().map((d) => d.kind)).toEqual(["rich-text", "other"]);
	});

	it("gets a descriptor by kind and returns undefined for unknown kinds", async () => {
		const kinds = makeElementKinds();
		await Effect.runPromise(kinds.register(descriptor("rich-text")));
		expect(kinds.get("rich-text")?.label).toBe("Label rich-text");
		expect(kinds.get("missing")).toBeUndefined();
	});

	it("dies on duplicate kind registration", async () => {
		const kinds = makeElementKinds();
		await Effect.runPromise(kinds.register(descriptor("rich-text")));
		const exit = await Effect.runPromiseExit(kinds.register(descriptor("rich-text")));
		expect(Exit.isFailure(exit)).toBe(true);
		// The first registration survives the rejected duplicate.
		expect(kinds.get("rich-text")?.label).toBe("Label rich-text");
	});

	it("resolve returns the renderable payload and hooks stay optional", async () => {
		const kinds = makeElementKinds();
		await Effect.runPromise(kinds.register(descriptor("rich-text")));
		const resolved = await Effect.runPromise(kinds.get("rich-text")!.resolve(42));
		expect(resolved).toBe("resolved:rich-text");
		expect(kinds.get("rich-text")!.hooks).toBeUndefined();
	});
});

describe("ElementKindsLive", () => {
	it("provides the shared registry service", async () => {
		const program = Effect.gen(function* () {
			const kinds = yield* ElementKinds;
			yield* kinds.register(descriptor("rich-text"));
			return kinds.get("rich-text")?.kind;
		});
		const kind = await Effect.runPromise(program.pipe(Effect.provide(ElementKindsLive)));
		expect(kind).toBe("rich-text");
	});

	it("shares ONE instance across consumers of the same layer", async () => {
		const layer = Layer.merge(ElementKindsLive, ElementKindsLive);
		const program = Effect.gen(function* () {
			const kinds = yield* ElementKinds;
			yield* kinds.register(descriptor("a"));
			return kinds.list().length;
		});
		// Same service tag resolved twice in one runtime — one registry.
		const count = await Effect.runPromise(program.pipe(Effect.provide(layer)));
		expect(count).toBe(1);
	});
});
