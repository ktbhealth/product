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

		const provider = new RecallBotProvider("test-key", "Test Clinic");
		const session = await provider.join("https://meet.example/x", "https://hook.example/");
		expect(session).toEqual({ botId: "bot-123", provider: "recall" });
		expect(fetchMock).toHaveBeenCalledWith("https://api.recall.ai/api/v1/bot", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Token test-key",
			},
			body: JSON.stringify({
				meeting_url: "https://meet.example/x",
				bot_name: "Test Clinic",
				transcription_options: { provider: "default" },
				realtime_endpoints: [
					{
						type: "webhook",
						url: "https://hook.example/",
						events: ["transcript.data"],
					},
				],
			}),
		});
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
			Effect.scoped(Layer.build(recallDriver.provides(env) as Layer.Layer<Bot>)),
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
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "bot-1" }) });
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
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "bot-1" }) });
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

	it("defaults bot_name to a neutral name and honors RECALL_BOT_NAME", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "b" }) });
		vi.stubGlobal("fetch", fetchMock);

		await new RecallBotProvider("k").join("https://m/", "https://h/");
		expect(JSON.parse(fetchMock.mock.calls[0]![1].body).bot_name).toBe("bot");

		const named = await buildBot({ RECALL_API_KEY: "k", RECALL_BOT_NAME: "Clinic Bot" });
		await named.join("https://m/", "https://h/");
		expect(JSON.parse(fetchMock.mock.calls[1]![1].body).bot_name).toBe("Clinic Bot");
	});
});
