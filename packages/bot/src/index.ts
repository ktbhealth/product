import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { Driver } from "@ktb/driver-framework";

/**
 * BotProvider port — server-side meeting-bot source (ADR-0001).
 *
 * A bot joins the teleconsult, and per-participant audio channels
 * give speaker labels for free — diarization solved by the call
 * platform, not by us. Transcript events arrive via webhook.
 */

export interface BotSession {
	botId: string;
	provider: string;
}

export interface BotProvider {
	readonly name: string;
	join(meetUrl: string, webhookUrl: string): Promise<BotSession>;
}

export class StubBotProvider implements BotProvider {
	readonly name = "stub";

	async join(_meetUrl: string, _webhookUrl: string): Promise<BotSession> {
		return {
			botId: `stub-${Math.random().toString(36).slice(2, 10)}`,
			provider: this.name,
		};
	}
}

/** Bot service tag — impls provide via Layer (stub, recall, ...). */
export class Bot extends Context.Service<Bot, BotProvider>()("@ktb/bot/Bot") {}

/** Local stub layer: simulates a bot without a provider account. */
export const StubBotLive = Layer.succeed(Bot, new StubBotProvider());

/**
 * Always-eligible fallback driver for the Bot port — resolves to the
 * local stub. Ordered after real-provider drivers (e.g. bot-recall) in
 * the host registry so the first enabled driver wins.
 */
export const stubBotDriver: Driver = {
	id: "bot-stub",
	port: Bot.key,
	provides: () => StubBotLive,
};
