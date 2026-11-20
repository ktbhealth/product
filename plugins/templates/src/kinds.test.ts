import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { makeTemplateKinds, TemplateKinds, TemplateKindsLive, type TemplateKind } from "./kinds.ts";

const kind = (id: string): TemplateKind => ({
	kind: id,
	label: `Label ${id}`,
	serialize: (source) => Effect.succeed(source),
	deserialize: (payload) => Effect.succeed(payload),
	validate: () => Effect.succeed([]),
});

describe("makeTemplateKinds", () => {
	it("registers, gets and lists kinds in registration order", async () => {
		const kinds = makeTemplateKinds();
		await Effect.runPromise(kinds.register(kind("alpha")));
		await Effect.runPromise(kinds.register(kind("beta")));
		expect(kinds.get("alpha")?.label).toBe("Label alpha");
		expect(kinds.get("missing")).toBeUndefined();
		expect(kinds.list().map((k) => k.kind)).toEqual(["alpha", "beta"]);
	});

	it("dies on duplicate kind registration", async () => {
		const kinds = makeTemplateKinds();
		await Effect.runPromise(kinds.register(kind("dup")));
		await expect(Effect.runPromise(kinds.register(kind("dup")))).rejects.toThrow(
			'duplicate template kind "dup"',
		);
	});
});

describe("TemplateKindsLive", () => {
	it("provides a working registry through the service tag", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const kinds = yield* TemplateKinds;
				yield* kinds.register(kind("svc"));
				return kinds.get("svc")?.kind;
			}).pipe(Effect.provide(TemplateKindsLive)),
		);
		expect(result).toBe("svc");
	});
});
