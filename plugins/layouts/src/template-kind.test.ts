import { describe, expect, it } from "vitest";

import { Effect, Layer, Schema } from "effect";

import { makeTemplateKinds, TemplateKinds } from "@ktb/templates/kinds";

import {
	layoutTemplateKind,
	LayoutsTemplateKindLive,
	type LayoutTemplateSource,
} from "./template-kind.ts";

const CONFIG = {
	sections: [
		{ id: "s1", title: "Hero", kind: "rich-text", refId: 1 },
		{ id: "s2", title: "Grid", kind: "rich-text", refId: 2 },
	],
};

/** The source form `serialize` accepts / `deserialize` returns:
 * `config` as raw JSON text — the `adminCreate` input contract. */
const SOURCE: LayoutTemplateSource = {
	name: "landing",
	description: "Landing snapshot",
	config: JSON.stringify(CONFIG),
};

describe("layoutTemplateKind", () => {
	it("serializes a layout source into a self-contained JSON payload", async () => {
		const payload = await Effect.runPromise(layoutTemplateKind.serialize(SOURCE));
		// Payload is stored as JSON — it must survive a JSON round trip.
		expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
		expect(payload).toEqual({
			name: "landing",
			description: "Landing snapshot",
			config: CONFIG,
			builderJson: null,
		});
	});

	it("snapshots and restores the builderJson document (PL-014)", async () => {
		const builderJson = '{"version":1,"data":{"content":[]}}';
		const payload = await Effect.runPromise(
			layoutTemplateKind.serialize({ ...SOURCE, builderJson }),
		);
		expect((payload as { builderJson?: unknown }).builderJson).toBe(builderJson);
		const instance = (await Effect.runPromise(
			layoutTemplateKind.deserialize(payload),
		)) as LayoutTemplateSource;
		expect(instance.builderJson).toBe(builderJson);
	});

	it("decodes payloads stored before builderJson existed", async () => {
		const legacy = {
			name: "old",
			description: null,
			config: { sections: [] },
		};
		const instance = (await Effect.runPromise(
			layoutTemplateKind.deserialize(legacy),
		)) as LayoutTemplateSource;
		expect(instance.builderJson).toBeNull();
	});

	it("round-trips: serialize → stored payload → deserialize yields an equivalent source", async () => {
		const payload = await Effect.runPromise(layoutTemplateKind.serialize(SOURCE));
		const instance = (await Effect.runPromise(
			layoutTemplateKind.deserialize(payload),
		)) as LayoutTemplateSource;
		expect(instance.name).toBe(SOURCE.name);
		expect(instance.description).toBe(SOURCE.description);
		// The deserialized config re-encodes to the same contract object —
		// feeding it through adminCreate renders the identical layout.
		expect(JSON.parse(instance.config)).toEqual(CONFIG);
	});

	it("normalizes an absent description to null on both directions", async () => {
		const payload = await Effect.runPromise(
			layoutTemplateKind.serialize({ name: "n", config: JSON.stringify({ sections: [] }) }),
		);
		expect((payload as { description: unknown }).description).toBeNull();
		const instance = (await Effect.runPromise(
			layoutTemplateKind.deserialize(payload),
		)) as LayoutTemplateSource;
		expect(instance.description).toBeNull();
	});

	it("validate accepts good payloads and reports issues for bad ones", async () => {
		const good = await Effect.runPromise(
			layoutTemplateKind.validate({
				name: "x",
				description: null,
				config: { sections: [] },
			}),
		);
		expect(good).toEqual([]);
		const badShape = await Effect.runPromise(layoutTemplateKind.validate({ nope: true }));
		expect(badShape.length).toBeGreaterThan(0);
		const badConfig = await Effect.runPromise(
			layoutTemplateKind.validate({
				name: "x",
				description: null,
				config: { sections: [{ id: "s", title: "t", kind: "rich-text" }] },
			}),
		);
		expect(badConfig.length).toBeGreaterThan(0);
	});

	it("fails serialize on malformed sources", async () => {
		// config not a string.
		await expect(
			Effect.runPromise(layoutTemplateKind.serialize({ name: "x", config: CONFIG })),
		).rejects.toThrowError(Schema.SchemaError);
		// config string that is not JSON.
		await expect(
			Effect.runPromise(layoutTemplateKind.serialize({ name: "x", config: "not json" })),
		).rejects.toThrowError(SyntaxError);
		// config JSON that is not a valid LayoutConfig.
		await expect(
			Effect.runPromise(layoutTemplateKind.serialize({ name: "x", config: '{"sections":"nope"}' })),
		).rejects.toThrowError(Schema.SchemaError);
	});

	it("fails deserialize on payloads that do not satisfy the contract", async () => {
		await expect(
			Effect.runPromise(layoutTemplateKind.deserialize({ nope: true })),
		).rejects.toThrowError(Schema.SchemaError);
		await expect(
			Effect.runPromise(
				layoutTemplateKind.deserialize({ name: "x", description: null, config: { bad: 1 } }),
			),
		).rejects.toThrowError(Schema.SchemaError);
	});

	it("registers under the 'layout' kind id", async () => {
		expect(layoutTemplateKind.kind).toBe("layout");
		expect(layoutTemplateKind.label).toBe("Layout");
		const kinds = makeTemplateKinds();
		await Effect.runPromise(kinds.register(layoutTemplateKind));
		expect(kinds.get("layout")).toBe(layoutTemplateKind);
	});
});

describe("LayoutsTemplateKindLive", () => {
	it("registers the layout kind into a provided TemplateKinds registry", async () => {
		const kinds = makeTemplateKinds();
		// Production wiring: templates.services provides TemplateKinds
		// into the layer's construction environment.
		const layer = LayoutsTemplateKindLive.pipe(Layer.provide(Layer.succeed(TemplateKinds, kinds)));
		await Effect.runPromise(Effect.void.pipe(Effect.provide(layer)));
		expect(kinds.get("layout")).toBe(layoutTemplateKind);
	});

	it("no-ops when TemplateKinds is absent (serviceOption degradation)", async () => {
		// No registry in the environment — the layer must still build.
		await expect(
			Effect.runPromise(Effect.void.pipe(Effect.provide(LayoutsTemplateKindLive))),
		).resolves.toBeUndefined();
	});
});
