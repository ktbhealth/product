import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import {
	defineElementKind,
	elementKindsLive,
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

describe("defineElementKind", () => {
	interface TestServices {
		readonly prefix: string;
	}

	const testServices = Effect.succeed<TestServices>({ prefix: "svc" });

	const kind = defineElementKind<TestServices>({
		manifest: { kind: "test-kind", label: "Test kind" },
		server: ({ prefix }) => ({
			resolve: (ref) => Effect.succeed(`${prefix}:${String(ref)}`),
			hooks: {
				usage: () => Effect.succeed([]),
				cleanup: () => Effect.void,
			},
		}),
	});

	it("exposes the manifest entry verbatim for the client contribution", () => {
		expect(kind.manifest).toEqual({ kind: "test-kind", label: "Test kind" });
	});

	// Mirror the app-host composition: `core` (ElementKinds) is merged at
	// top level AND provided into the registration layer — the same layer
	// object, so the registry instance is shared.
	const composed = () => {
		const core = ElementKindsLive;
		return Layer.mergeAll(core, kind.live(testServices).pipe(Layer.provide(core)));
	};

	it("derives kind/label from the manifest — the descriptor cannot drift", async () => {
		const program = Effect.gen(function* () {
			const kinds = yield* ElementKinds;
			return kinds.get("test-kind");
		});
		const registered = await Effect.runPromise(program.pipe(Effect.provide(composed())));
		expect(registered?.kind).toBe("test-kind");
		expect(registered?.label).toBe("Test kind");
	});

	it("live registers resolve/hooks built from the services record", async () => {
		const program = Effect.gen(function* () {
			const kinds = yield* ElementKinds;
			const descriptor = kinds.get("test-kind")!;
			const resolved = yield* descriptor.resolve(7);
			const usage = yield* descriptor.hooks!.usage!("anything");
			return { resolved, usage };
		});
		const result = await Effect.runPromise(program.pipe(Effect.provide(composed())));
		expect(result).toEqual({ resolved: "svc:7", usage: [] });
	});

	it("builds without the ElementKinds registry (optional consumer)", async () => {
		await expect(
			Effect.runPromise(Effect.void.pipe(Effect.provide(kind.live(testServices)))),
		).resolves.toBeUndefined();
	});
});

describe("elementKindsLive", () => {
	it("registers every definition in declaration order through one layer", async () => {
		const services = Effect.succeed<Record<string, never>>({});
		const defs = ["first", "second", "third"].map((id) =>
			defineElementKind<Record<string, never>>({
				manifest: { kind: id, label: id },
				server: () => ({ resolve: (ref) => Effect.succeed(`${id}:${String(ref)}`) }),
			}),
		);
		const program = Effect.gen(function* () {
			const kinds = yield* ElementKinds;
			return {
				order: kinds.list().map((d) => d.kind),
				resolved: yield* kinds.get("second")!.resolve("x"),
			};
		});
		const core = ElementKindsLive;
		const layer = Layer.mergeAll(core, elementKindsLive(defs, services).pipe(Layer.provide(core)));
		const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
		expect(result.order).toEqual(["first", "second", "third"]);
		expect(result.resolved).toBe("second:x");
	});

	it("builds without the ElementKinds registry (optional consumer)", async () => {
		const def = defineElementKind<Record<string, never>>({
			manifest: { kind: "solo", label: "Solo" },
			server: () => ({ resolve: () => Effect.succeed(null) }),
		});
		await expect(
			Effect.runPromise(
				Effect.void.pipe(
					Effect.provide(elementKindsLive([def], Effect.succeed<Record<string, never>>({}))),
				),
			),
		).resolves.toBeUndefined();
	});
});
