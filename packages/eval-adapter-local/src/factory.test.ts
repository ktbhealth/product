import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { LlmFactory, LlmPort } from "@ktb/eval-consultation";

import { makeChatLlm } from "./chat.ts";
import { evalLlmFactoryDriver } from "./factory.ts";

const chatBody = (text: string) => ({
	ok: true,
	json: async () => ({ choices: [{ message: { content: text } }] }),
	text: async () => "",
});

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<unknown>) =>
	impl as unknown as typeof fetch;

describe("makeChatLlm", () => {
	it("posts the envelope input and maps choices[0].content", async () => {
		let seenUrl = "";
		let seenBody = "";
		let seenAuth: string | undefined;
		const layer = makeChatLlm({
			baseUrl: "http://localhost:11434/v1/",
			model: "qwen",
			apiKey: "k",
			fetchImpl: stubFetch(async (url, init) => {
				seenUrl = String(url);
				seenBody = String(init?.body);
				seenAuth = (init?.headers as Record<string, string>).Authorization;
				return chatBody("doctor: oi\npatient: oi");
			}),
		});
		const out = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) =>
				l.generate({
					taskId: "t",
					role: "generator",
					input: "say hi",
					seed: 7,
					outputSchema: "Text",
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(out.text).toContain("doctor: oi");
		expect(seenUrl).toBe("http://localhost:11434/v1/chat/completions");
		expect(seenAuth).toBe("Bearer k");
		const body = JSON.parse(seenBody);
		expect(body.model).toBe("qwen");
		expect(body.seed).toBe(7);
		expect(body.messages[0].content).toBe("say hi");
		// Seedless envelope hits the `?? 0` hash arm on the success path.
		const out2 = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) =>
				l.generate({ taskId: "t2", role: "generator", input: "again", outputSchema: "Text" }),
			).pipe(Effect.provide(layer)),
		);
		expect(out2.text).toContain("doctor: oi");
	});

	it("wraps non-ok responses and transport failures in PortError", async () => {
		const bad = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => ({
				ok: false,
				status: 500,
				text: async () => "boom — echoed Authorization: Bearer sk-secret",
			})),
		});
		// The provider body never reaches the wire-visible message — a
		// hostile endpoint could echo our Authorization header in it.
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(bad)),
			),
		).rejects.toMatchObject({ _tag: "PortError", message: "chat 500" });
		const dead = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => {
				throw new Error("conn refused");
			}),
		});
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(dead)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("conn refused") });
	});

	it("an unreadable error body still fails as PortError with the status only", async () => {
		const bad = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => ({
				ok: false,
				status: 500,
				text: async () => {
					throw new Error("stream reset");
				},
			})),
		});
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(bad)),
			),
		).rejects.toMatchObject({ _tag: "PortError", message: "chat 500" });
	});

	it("wraps an undecodable response body in PortError 'chat response'", async () => {
		const garbled = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => ({
				ok: true,
				json: async () => {
					throw new Error("unexpected token");
				},
			})),
		});
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(garbled)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("chat response:") });
	});

	it("handles missing choices and non-string content", async () => {
		const empty = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => ({ ok: true, json: async () => ({}) })),
		});
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(empty)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("empty content") });
		const odd = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => ({
				ok: true,
				json: async () => ({ choices: [{ message: { content: 42 } }] }),
			})),
		});
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(odd)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("empty content") });
	});

	it("correct is unsupported on chat endpoints", async () => {
		const layer = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => chatBody("")),
		});
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.correct({ taskId: "t", role: "corrector", input: "raw", outputSchema: "EditList" }),
				).pipe(Effect.provide(layer)),
			),
		).rejects.toMatchObject({ _tag: "PortError" });
	});
});

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

	it("generates without a seed and survives non-Error transport throws", async () => {
		const layer = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => {
				throw "string boom";
			}),
		});
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(layer)),
			),
		).rejects.toMatchObject({ message: expect.stringContaining("string boom") });
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

	it("drives ws acp transports and rejects node-only ones", async () => {
		const ws = await Effect.runPromise(
			Effect.flatMap(LlmFactory, (f) =>
				f.resolve({ kind: "acp", baseUrl: "http://x/acp", transport: "ws" }),
			).pipe(Effect.provide(factory)),
		);
		expect(ws).toBeDefined();
		for (const transport of ["child", "ssh"] as const) {
			await expect(
				Effect.runPromise(
					Effect.flatMap(LlmFactory, (f) =>
						f.resolve({ kind: "acp", baseUrl: "http://x/acp", transport }),
					).pipe(Effect.provide(factory)),
				),
			).rejects.toMatchObject({
				message: expect.stringContaining(`transport ${transport} requires Node runtime`),
			});
		}
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
