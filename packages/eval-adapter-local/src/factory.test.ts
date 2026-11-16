import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { LlmFactory } from "@ktb/eval-consultation";

import { evalLlmFactoryDriver } from "./factory.ts";

describe("evalLlmFactoryDriver", () => {
	const factory = evalLlmFactoryDriver.provides!({} as never) as Layer.Layer<LlmFactory>;

	it("resolves openai endpoints and rejects missing models", async () => {
		const layer = await Effect.runPromise(
			Effect.flatMap(LlmFactory, (f) =>
				f.resolve({ kind: "openai", baseUrl: "http://x/v1", model: "m" }),
			).pipe(Effect.provide(factory)),
		);
		expect(layer).toBeDefined();
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmFactory, (f) =>
					f.resolve({ kind: "openai", baseUrl: "http://x/v1" }),
				).pipe(Effect.provide(factory)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("require a model") });
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmFactory, (f) =>
					f.resolve({ kind: "nope" as never, baseUrl: "http://x" }),
				).pipe(Effect.provide(factory)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("unknown endpoint kind") });
	});

	it("resolves acp descriptors and reads api keys from secretRef env", async () => {
		process.env.TEST_EVAL_KEY = "sek";
		const layer = await Effect.runPromise(
			Effect.flatMap(LlmFactory, (f) =>
				f.resolve({
					kind: "openai",
					baseUrl: "http://x/v1",
					model: "m",
					secretRef: "TEST_EVAL_KEY",
					sessionId: "s",
					timeoutMs: 5,
				}),
			).pipe(Effect.provide(factory)),
		);
		expect(layer).toBeDefined();
		const acp = await Effect.runPromise(
			Effect.flatMap(LlmFactory, (f) =>
				f.resolve({ kind: "acp", baseUrl: "http://x/acp", sessionId: "s" }),
			).pipe(Effect.provide(factory)),
		);
		expect(acp).toBeDefined();
		const acpNoSession = await Effect.runPromise(
			Effect.flatMap(LlmFactory, (f) => f.resolve({ kind: "acp", baseUrl: "http://x/acp" })).pipe(
				Effect.provide(factory),
			),
		);
		expect(acpNoSession).toBeDefined();
		delete process.env.TEST_EVAL_KEY;
	});

	it("drives ws acp transports and delegates child/ssh to @ktb/ai-adapter-node", async () => {
		const ws = await Effect.runPromise(
			Effect.flatMap(LlmFactory, (f) =>
				f.resolve({ kind: "acp", baseUrl: "http://x/acp", transport: "ws" }),
			).pipe(Effect.provide(factory)),
		);
		expect(ws).toBeDefined();
		// child/ssh resolve through the node adapter — layers build
		// eagerly (spawning happens per generate call).
		for (const transport of ["child", "ssh"] as const) {
			const layer = await Effect.runPromise(
				Effect.flatMap(LlmFactory, (f) =>
					f.resolve({
						kind: "acp",
						baseUrl: "x",
						transport,
						agentCmd: "cat",
						...(transport === "ssh" ? { sshHost: "u@h" } : {}),
					}),
				).pipe(Effect.provide(factory)),
			);
			expect(layer).toBeDefined();
		}
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmFactory, (f) =>
					f.resolve({ kind: "acp", baseUrl: "x", transport: "child" }),
				).pipe(Effect.provide(factory)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("require agentCmd") });
	});

	it("routes empty-baseUrl acp+ws endpoints through the ACP_BRIDGE DO binding", async () => {
		// Without the binding (Node dev, tests) bridge endpoints fail typed.
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmFactory, (f) =>
					f.resolve({ kind: "acp", baseUrl: "", transport: "ws", endpointId: 5 }),
				).pipe(Effect.provide(factory)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("ACP_BRIDGE binding") });
		// Without endpointId the DO has no name.
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmFactory, (f) =>
					f.resolve({ kind: "acp", baseUrl: "", transport: "ws" }),
				).pipe(Effect.provide(factory)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("endpointId") });
		// With the binding the layer resolves — the DO stub is only
		// touched when generate runs.
		const bridge = {
			idFromName: (n: string) => n,
			get: () => ({ fetch: async () => new Response("{}") }),
		};
		const withBridge = evalLlmFactoryDriver.provides!({
			ACP_BRIDGE: bridge,
		} as never) as Layer.Layer<LlmFactory>;
		const layer = await Effect.runPromise(
			Effect.flatMap(LlmFactory, (f) =>
				f.resolve({ kind: "acp", baseUrl: "", transport: "ws", endpointId: 5 }),
			).pipe(Effect.provide(withBridge)),
		);
		expect(layer).toBeDefined();
		// A caller-pinned session id flows through to the bridge layer.
		const withSession = await Effect.runPromise(
			Effect.flatMap(LlmFactory, (f) =>
				f.resolve({
					kind: "acp",
					baseUrl: "",
					transport: "ws",
					endpointId: 5,
					sessionId: "s-1",
				}),
			).pipe(Effect.provide(withBridge)),
		);
		expect(withSession).toBeDefined();
	});

	it("test() pings the endpoint and maps failures to PortError", async () => {
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmFactory, (f) =>
					f.test({ kind: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "m", timeoutMs: 500 }),
				).pipe(Effect.provide(factory)),
			),
		).rejects.toMatchObject({ _tag: "PortError" });
	});
});
