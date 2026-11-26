import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { DecisionsPort, PortError } from "@ktb/eval-core";
import { DecisionsFactory, type LlmEndpointDescriptor } from "@ktb/eval-consultation";

import { systemOneDecisionsDriver } from "./factory.ts";

const wireAnswers = {
	answers: {
		alive: { type: "noul", noul: 0.99 },
	},
};

const descriptor = (over: Partial<LlmEndpointDescriptor> = {}): LlmEndpointDescriptor => ({
	kind: "systemone",
	baseUrl: "http://localhost:9",
	...over,
});

// `provides` returns Layer.Any — restore the concrete service type the
// same way app-host's layerFor does.
const factory = systemOneDecisionsDriver.provides({
	SYSTEMONE_KEY: "env-secret",
}) as Layer.Layer<DecisionsFactory>;

const withFactory = <A>(eff: Effect.Effect<A, unknown, DecisionsFactory>) =>
	Effect.runPromise(Effect.provide(eff, factory));

describe("systemOneDecisionsDriver", () => {
	it("is registered for the DecisionsFactory port and always eligible", () => {
		expect(systemOneDecisionsDriver.port).toBe(DecisionsFactory.key);
		expect(systemOneDecisionsDriver.when).toBeUndefined();
		expect(systemOneDecisionsDriver.id).toBe("systemone-decisions-factory");
	});

	it("exposes the OpenJev local preset", async () => {
		const presets = await withFactory(
			Effect.gen(function* () {
				const f = yield* DecisionsFactory;
				return f.presets ?? [];
			}),
		);
		expect(presets).toEqual([
			{
				label: "System One (OpenJev local)",
				kind: "systemone",
				baseUrl: "http://127.0.0.1:8009",
				model: "wev-latest",
			},
		]);
	});

	it("resolve fails typed for non-systemone kinds", async () => {
		const err = await withFactory(
			Effect.gen(function* () {
				const f = yield* DecisionsFactory;
				return yield* f.resolve(descriptor({ kind: "openai", model: "gpt-4o" }));
			}),
		).then(
			() => null,
			(e) => e,
		);
		expect(err).toBeInstanceOf(PortError);
		expect(err.message).toContain('kind "openai"');
	});

	it("resolve fails typed without a baseUrl", async () => {
		const err = await withFactory(
			Effect.gen(function* () {
				const f = yield* DecisionsFactory;
				return yield* f.resolve(descriptor({ baseUrl: "  " }));
			}),
		).then(
			() => null,
			(e) => e,
		);
		expect(err).toBeInstanceOf(PortError);
		expect(err.message).toContain("baseUrl");
	});

	it("resolve produces a working DecisionsPort layer honoring apiKey/env secretRef", async () => {
		const seen: { auth: string | null; url: string }[] = [];
		// The driver captures `fetch` at provides() time — stub the
		// global for this test only.
		const original = globalThis.fetch;
		globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
			seen.push({
				auth: new Headers(init?.headers).get("authorization"),
				url: String(u),
			});
			return new Response(JSON.stringify(wireAnswers));
		}) as typeof fetch;
		try {
			// apiKey on the descriptor wins over secretRef env lookup.
			const r = await withFactory(
				Effect.gen(function* () {
					const f = yield* DecisionsFactory;
					const layer = yield* f.resolve(
						descriptor({ apiKey: "direct-key", secretRef: "SYSTEMONE_KEY" }),
					);
					return yield* DecisionsPort.pipe(
						Effect.flatMap((d) =>
							d.judge({
								state: {},
								questions: [{ id: "alive", kind: "noul", text: "up?" }],
							}),
						),
						Effect.provide(layer),
					);
				}),
			);
			expect(r.answers[0]?.value).toBe(true);
			expect(seen[0]?.auth).toBe("Bearer direct-key");
			expect(seen[0]?.url).toBe("http://localhost:9/v1/systemone");

			// secretRef resolves against the env passed to provides().
			await withFactory(
				Effect.gen(function* () {
					const f = yield* DecisionsFactory;
					const layer = yield* f.resolve(descriptor({ secretRef: "SYSTEMONE_KEY" }));
					return yield* DecisionsPort.pipe(
						Effect.flatMap((d) =>
							d.judge({
								state: {},
								questions: [{ id: "alive", kind: "noul", text: "up?" }],
							}),
						),
						Effect.provide(layer),
					);
				}),
			);
			expect(seen[1]?.auth).toBe("Bearer env-secret");

			// Unknown secretRef resolves to no key — header omitted.
			await withFactory(
				Effect.gen(function* () {
					const f = yield* DecisionsFactory;
					const layer = yield* f.resolve(descriptor({ secretRef: "MISSING_VAR" }));
					return yield* DecisionsPort.pipe(
						Effect.flatMap((d) =>
							d.judge({
								state: {},
								questions: [{ id: "alive", kind: "noul", text: "up?" }],
							}),
						),
						Effect.provide(layer),
					);
				}),
			);
			expect(seen[2]?.auth).toBeNull();
		} finally {
			globalThis.fetch = original;
		}
	});

	it("test() pings the endpoint through DecisionsPort", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify(wireAnswers))) as typeof fetch;
		try {
			await withFactory(
				Effect.gen(function* () {
					const f = yield* DecisionsFactory;
					return yield* f.test(descriptor());
				}),
			);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("test() fails typed on HTTP errors", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
		try {
			const err = await withFactory(
				Effect.gen(function* () {
					const f = yield* DecisionsFactory;
					return yield* f.test(descriptor());
				}),
			).then(
				() => null,
				(e) => e,
			);
			expect(err).toBeInstanceOf(PortError);
			expect(err.message).toContain("503");
		} finally {
			globalThis.fetch = original;
		}
	});
});
