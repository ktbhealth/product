import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";

import { Bot, StubBotLive, StubBotProvider, stubBotDriver } from "./index.ts";

describe("StubBotProvider", () => {
	it("joins a call and returns a session", async () => {
		const p = new StubBotProvider();
		const s = await p.join("https://meet.example/x", "https://api.example/hook");
		expect(s.provider).toBe("stub");
		expect(s.botId).toMatch(/^stub-/);
	});

	it("returns a provider-tagged bot id with an 8-char base36 suffix", async () => {
		const p = new StubBotProvider();
		const ids = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const s = await p.join("https://meet.example/x", "https://api.example/hook");
			expect(s.botId).toMatch(/^stub-[a-z0-9]{8}$/);
			ids.add(s.botId);
		}
		expect(ids.size).toBeGreaterThan(1);
	});

	it("uses the provider name as session provider", async () => {
		const p = new StubBotProvider();
		expect(p.name).toBe("stub");
		const s = await p.join("https://meet.example/x", "https://api.example/hook");
		expect(s.provider).toBe(p.name);
	});
});

describe("Bot service", () => {
	it("is tagged @ktb/bot/Bot", () => {
		expect(Bot.key).toBe("@ktb/bot/Bot");
	});

	it("StubBotLive resolves a working Bot provider", async () => {
		const session = await Effect.runPromise(
			Effect.gen(function* () {
				const bot = yield* Bot;
				return yield* Effect.promise(() =>
					bot.join("https://meet.example/x", "https://api.example/hook"),
				);
			}).pipe(Effect.provide(StubBotLive as Layer.Layer<Bot, never, never>)),
		);
		expect(session.provider).toBe("stub");
		expect(session.botId).toMatch(/^stub-[a-z0-9]{8}$/);
	});
});

describe("stubBotDriver", () => {
	it("is an always-eligible driver for the Bot port", () => {
		expect(stubBotDriver.id).toBe("bot-stub");
		expect(stubBotDriver.port).toBe(Bot.key);
		expect(stubBotDriver).not.toHaveProperty("when");
	});

	it("provides the StubBotLive layer", () => {
		expect(stubBotDriver.provides({})).toBe(StubBotLive);
	});
});
