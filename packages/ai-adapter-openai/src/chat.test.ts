import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import { describe, expect, it, vi } from "vitest";

import { fnvHex, LlmPort } from "@ktb/eval-consultation";

import { makeChatLlm } from "./chat.ts";

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
		let seenMethod = "";
		let seenBody = "";
		let seenAuth: string | undefined;
		let seenContentType: string | undefined;
		const layer = makeChatLlm({
			baseUrl: "http://localhost:11434/v1/",
			model: "qwen",
			apiKey: "k",
			engineVersion: "qwen@v-test",
			fetchImpl: stubFetch(async (url, init) => {
				seenUrl = String(url);
				seenMethod = String(init?.method);
				seenBody = (init?.body ?? "") as string;
				const headers = init?.headers as Record<string, string>;
				seenAuth = headers.Authorization;
				seenContentType = headers["Content-Type"];
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
		expect(out.record.engineVersion).toBe("qwen@v-test");
		expect(seenUrl).toBe("http://localhost:11434/v1/chat/completions");
		expect(seenMethod).toBe("POST");
		expect(seenAuth).toBe("Bearer k");
		expect(seenContentType).toBe("application/json");
		const body = JSON.parse(seenBody);
		expect(body.model).toBe("qwen");
		expect(body.seed).toBe(7);
		expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);
		expect(body.temperature).toBe(0.8);
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
		).rejects.toMatchObject({ _tag: "PortError", port: "llm", message: "chat 500" });
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
		).rejects.toMatchObject({
			_tag: "PortError",
			port: "llm",
			message: expect.stringContaining("conn refused"),
		});
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
		).rejects.toMatchObject({ _tag: "PortError", port: "llm", message: "chat 500" });
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
		).rejects.toMatchObject({
			_tag: "PortError",
			port: "llm",
			message: expect.stringContaining("chat response:"),
		});
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
		).rejects.toMatchObject({
			_tag: "PortError",
			port: "llm",
			message: "chat response: empty content",
		});
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
		).rejects.toMatchObject({
			_tag: "PortError",
			port: "llm",
			message: "chat response: empty content",
		});
	});

	it("rejects whitespace-only content and missing message/choices entries", async () => {
		const cases = [
			{ choices: [{ message: { content: "   " } }] },
			{ choices: [] },
			{ choices: [{}] },
			{ choices: [null] },
		];
		for (const payload of cases) {
			const layer = makeChatLlm({
				baseUrl: "http://x/v1",
				model: "m",
				fetchImpl: stubFetch(async () => ({ ok: true, json: async () => payload })),
			});
			await expect(
				Effect.runPromise(
					Effect.flatMap(LlmPort, (l) =>
						l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
					).pipe(Effect.provide(layer)),
				),
			).rejects.toMatchObject({
				_tag: "PortError",
				port: "llm",
				message: "chat response: empty content",
			});
		}
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
		).rejects.toMatchObject({
			_tag: "PortError",
			port: "llm",
			message: "chat endpoints implement generate only — correct is an ACP concern",
		});
	});

	it("sends no Authorization header without an apiKey and declares egress", async () => {
		let seenHeaders: Record<string, string> = {};
		const layer = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async (_url, init) => {
				seenHeaders = init?.headers as Record<string, string>;
				return chatBody("ok");
			}),
		});
		const egress = await Effect.runPromise(
			Effect.map(LlmPort, (l) => l.egress).pipe(Effect.provide(layer)),
		);
		expect(egress).toBe(true);
		await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) =>
				l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
			).pipe(Effect.provide(layer)),
		);
		expect(seenHeaders["Content-Type"]).toBe("application/json");
		expect(seenHeaders).not.toHaveProperty("Authorization");
	});

	it("strips every trailing slash and defaults engineVersion to fnvHex(url:model)", async () => {
		let seenUrl = "";
		const layer = makeChatLlm({
			baseUrl: "http://x/v1//",
			model: "m",
			fetchImpl: stubFetch(async (url) => {
				seenUrl = String(url);
				return chatBody("ok");
			}),
		});
		const out = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) =>
				l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
			).pipe(Effect.provide(layer)),
		);
		expect(seenUrl).toBe("http://x/v1/chat/completions");
		expect(out.record.engineVersion).toBe(fnvHex("http://x/v1/chat/completions:m"));
	});

	it("stamps a full RunRecord with content-hash inputHash", async () => {
		const layer = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => chatBody("ok")),
		});
		const seeded = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) =>
				l.generate({
					taskId: "task-1",
					role: "generator",
					input: "hello",
					seed: 42,
					outputSchema: "Text",
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(seeded.record).toMatchObject({
			runId: "chat",
			taskId: "task-1",
			stage: "script_gen",
			engine: "openai-compat",
			model: "m",
			seed: 42,
			inputHash: fnvHex("task-1:Text:hello:42"),
		});
		expect(typeof seeded.record.startedAt).toBe("number");
		expect(seeded.record.latencyMs).toBeGreaterThanOrEqual(0);
		expect(seeded.record.latencyMs).toBeLessThan(60_000);

		const seedless = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) =>
				l.generate({ taskId: "task-2", role: "generator", input: "hi", outputSchema: "Text" }),
			).pipe(Effect.provide(layer)),
		);
		expect(seedless.record.runId).toBe("chat");
		expect(seedless.record.seed).toBeUndefined();
		expect(seedless.record.inputHash).toBe(fnvHex("task-2:Text:hi:0"));

		const session = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			sessionId: "sess-9",
			fetchImpl: stubFetch(async () => chatBody("ok")),
		});
		const out = await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) =>
				l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
			).pipe(Effect.provide(session)),
		);
		expect(out.record.runId).toBe("sess-9");
	});

	it("logs the provider error body truncated to 300 chars, status only on the wire", async () => {
		const entries: { message: unknown; annotations: Record<string, unknown> }[] = [];
		const logger = Logger.make((options) => {
			entries.push({
				message: options.message,
				annotations: options.fiber.getRef(References.CurrentLogAnnotations),
			});
		});
		const bodyText = `err-${"x".repeat(400)}`;
		const bad = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			fetchImpl: stubFetch(async () => ({
				ok: false,
				status: 503,
				text: async () => bodyText,
			})),
		});
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(bad), Effect.provide(Logger.layer([logger]))),
			),
		).rejects.toMatchObject({ _tag: "PortError", port: "llm", message: "chat 503" });
		expect(entries).toHaveLength(1);
		expect(String(entries[0]?.message)).toContain("chat endpoint 503 response body");
		expect(entries[0]?.annotations.body).toBe(bodyText.slice(0, 300));
	});

	it("fails a hanging endpoint as a PortError timeout", async () => {
		const hanging = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "m",
			timeoutMs: 20,
			fetchImpl: stubFetch(() => new Promise(() => {})),
		});
		await expect(
			Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(hanging)),
			),
		).rejects.toMatchObject({
			_tag: "PortError",
			port: "llm",
			message: "timeout after 20ms",
		});
	});

	it("emits an llm.chat span tagged with the model id", async () => {
		const spans: Tracer.NativeSpan[] = [];
		const tracer = Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options);
				spans.push(span);
				return span;
			},
		});
		const layer = makeChatLlm({
			baseUrl: "http://x/v1",
			model: "tagged-model",
			fetchImpl: stubFetch(async () => chatBody("ok")),
		});
		await Effect.runPromise(
			Effect.flatMap(LlmPort, (l) =>
				l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
			).pipe(Effect.provide(layer), Effect.provideService(Tracer.Tracer, tracer)),
		);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe("llm.chat");
		expect(spans[0]?.attributes.get("llm.model")).toBe("tagged-model");
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

	it("defaults to the global fetch when no fetchImpl is given", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify({ choices: [{ message: { content: "global-ok" } }] }), {
					status: 200,
				}),
		);
		try {
			const layer = makeChatLlm({ baseUrl: "http://x/v1", model: "m" });
			const out = await Effect.runPromise(
				Effect.flatMap(LlmPort, (l) =>
					l.generate({ taskId: "t", role: "generator", input: "i", outputSchema: "Text" }),
				).pipe(Effect.provide(layer)),
			);
			expect(out.text).toBe("global-ok");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
