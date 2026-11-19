import { afterEach, describe, expect, it, vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Bot } from "@ktb/bot";
import type { BotProvider } from "@ktb/bot";
import { RecallBotProvider, recallDriver } from "./index.ts";
import type { RecallDriverEnv } from "./index.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("RecallBotProvider", () => {
	it("posts to recall API and returns botId", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ id: "bot-123" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = new RecallBotProvider("test-key");
		const session = await provider.join("https://meet.example/x", "https://hook.example/");
		expect(session).toEqual({ botId: "bot-123", provider: "recall" });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.recall.ai/api/v1/bot",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Token test-key",
				},
				body: JSON.stringify({
					meeting_url: "https://meet.example/x",
					bot_name: "KTB Health",
					transcription_options: { provider: "default" },
					realtime_endpoints: [
						{
							type: "webhook",
							url: "https://hook.example/",
							events: ["transcript.data"],
						},
					],
				}),
			},
		);
	});

	it("throws on non-ok API response", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
		const provider = new RecallBotProvider("test-key");
		await expect(provider.join("https://meet.example/x", "https://hook.example/")).rejects.toThrow(
			"recall api: 401",
		);
	});
});

describe("recallDriver", () => {
	const buildBot = async (env: RecallDriverEnv): Promise<BotProvider> => {
		const ctx = await Effect.runPromise(
			Effect.scoped(Layer.build(recallDriver.provides(env))),
		);
		return Context.get(ctx, Bot);
	};

	it("is eligible only when RECALL_API_KEY is bound", () => {
		expect(recallDriver.id).toBe("bot-recall");
		expect(recallDriver.port).toBe(Bot.key);
		expect(recallDriver.when?.({})).toBe(false);
		expect(recallDriver.when?.({ RECALL_API_KEY: "" })).toBe(false);
		expect(recallDriver.when?.({ RECALL_API_KEY: "k" })).toBe(true);
	});

	it("provides a recall-backed Bot layer", () => {
		expect(recallDriver.provides({ RECALL_API_KEY: "k" })).toBeDefined();
		// `when` gates eligibility, but `provides` still tolerates a missing
		// key (empty-string fallback) if invoked directly.
		expect(recallDriver.provides({})).toBeDefined();
	});

	it("binds the API key into the provided provider", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, json: async () => ({ id: "bot-1" }) });
		vi.stubGlobal("fetch", fetchMock);

		const bot = await buildBot({ RECALL_API_KEY: "k" });
		expect(bot.name).toBe("recall");
		await bot.join("https://meet.example/x", "https://hook.example/");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.recall.ai/api/v1/bot",
			expect.objectContaining({
				headers: expect.objectContaining({ authorization: "Token k" }),
			}),
		);
	});

	it("falls back to an empty key when RECALL_API_KEY is missing", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, json: async () => ({ id: "bot-1" }) });
		vi.stubGlobal("fetch", fetchMock);

		const bot = await buildBot({});
		expect(bot.name).toBe("recall");
		await bot.join("https://meet.example/x", "https://hook.example/");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.recall.ai/api/v1/bot",
			expect.objectContaining({
				headers: expect.objectContaining({ authorization: "Token " }),
			}),
		);
	});
});
