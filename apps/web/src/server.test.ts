import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	startFetch: vi.fn(),
	handleAudioQueueBatch: vi.fn(),
	handleThemeQueueBatch: vi.fn(),
	flushTelemetry: vi.fn(),
	runScheduledCron: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({
	createStartHandler: vi.fn(() => mocks.startFetch),
	defaultStreamHandler: {},
	// Identity: the real one only binds the Register type.
	createServerEntry: (entry: unknown) => entry,
}));
vi.mock("#/lib/audio-jobs.ts", () => ({
	handleAudioQueueBatch: mocks.handleAudioQueueBatch,
}));
vi.mock("#/lib/theme-jobs.ts", () => ({
	handleThemeQueueBatch: mocks.handleThemeQueueBatch,
}));
vi.mock("#/lib/platform.ts", () => ({
	flushTelemetry: mocks.flushTelemetry,
	runScheduledCron: mocks.runScheduledCron,
}));

import { AUDIO_QUEUE_NAME, THEME_ASSETS_QUEUE_NAME } from "#/lib/queue-names.ts";

import entry, { createServerEntry } from "./server.ts";

describe("worker entry", () => {
	it("exposes the start fetch pipeline next to the queue consumer", () => {
		expect(typeof entry.fetch).toBe("function");
		expect(typeof entry.queue).toBe("function");
		expect(typeof entry.scheduled).toBe("function");
	});

	it("re-exports the typed createServerEntry binding", () => {
		const e = { fetch: mocks.startFetch };
		expect(createServerEntry(e as never)).toBe(e);
	});

	it("delegates fetch to the start pipeline and schedules a telemetry flush", async () => {
		const request = new Request("https://ktb.test/");
		const response = new Response("ok");
		mocks.startFetch.mockReturnValue(response);
		const waitUntil = vi.fn();
		// The worker entry signature is (request, env, ctx); the public
		// RequestHandler type only exposes the request argument.
		const result = (entry.fetch as (req: Request, env: unknown, ctx: unknown) => Response)(
			request,
			{},
			{ waitUntil },
		);
		expect(result).toBe(response);
		expect(mocks.startFetch).toHaveBeenCalledWith(request);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await waitUntil.mock.calls[0]?.[0];
		expect(mocks.flushTelemetry).toHaveBeenCalled();
	});

	it("hands queue batches to the audio job handler and flushes telemetry", async () => {
		const messages = [{ id: "m1" }, { id: "m2" }];
		mocks.handleAudioQueueBatch.mockResolvedValue("handled");
		const waitUntil = vi.fn();
		await entry.queue({ messages } as never, {}, { waitUntil } as never);
		expect(mocks.handleAudioQueueBatch).toHaveBeenCalledWith(messages);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await waitUntil.mock.calls[0]?.[0];
		expect(mocks.flushTelemetry).toHaveBeenCalled();
	});

	it("dispatches theme-assets queue batches to the theme job handler", async () => {
		mocks.handleAudioQueueBatch.mockClear();
		mocks.handleThemeQueueBatch.mockClear();
		const messages = [{ id: "t1" }];
		mocks.handleThemeQueueBatch.mockResolvedValue("handled");
		const waitUntil = vi.fn();
		await entry.queue({ queue: THEME_ASSETS_QUEUE_NAME, messages } as never, {}, {
			waitUntil,
		} as never);
		expect(mocks.handleThemeQueueBatch).toHaveBeenCalledWith(messages);
		expect(mocks.handleAudioQueueBatch).not.toHaveBeenCalled();
	});

	it("routes the audio queue name to the audio job handler", async () => {
		const messages = [{ id: "a1" }];
		mocks.handleAudioQueueBatch.mockClear();
		mocks.handleThemeQueueBatch.mockClear();
		mocks.handleAudioQueueBatch.mockResolvedValue("handled");
		await entry.queue({ queue: AUDIO_QUEUE_NAME, messages } as never, {}, {
			waitUntil: vi.fn(),
		} as never);
		expect(mocks.handleAudioQueueBatch).toHaveBeenCalledWith(messages);
		expect(mocks.handleThemeQueueBatch).not.toHaveBeenCalled();
	});

	it("dispatches the fired cron expression through the registry", async () => {
		mocks.runScheduledCron.mockResolvedValue([]);
		const waitUntil = vi.fn();
		const controller = { scheduledTime: 0, cron: "17 3 * * *", noRetry: vi.fn() };
		await entry.scheduled(controller as never, {}, { waitUntil } as never);
		expect(mocks.runScheduledCron).toHaveBeenCalledWith("17 3 * * *");
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await waitUntil.mock.calls[0]?.[0];
		expect(mocks.flushTelemetry).toHaveBeenCalled();
	});

	it("forwards the 5-minute expression unchanged", async () => {
		mocks.runScheduledCron.mockClear();
		mocks.runScheduledCron.mockResolvedValue([]);
		const controller = { scheduledTime: 0, cron: "*/5 * * * *", noRetry: vi.fn() };
		await entry.scheduled(controller as never, {}, { waitUntil: vi.fn() } as never);
		expect(mocks.runScheduledCron).toHaveBeenCalledWith("*/5 * * * *");
	});
});

describe("worker entry failure path", () => {
	it("still schedules a telemetry flush when fetch rejects", async () => {
		mocks.startFetch.mockRejectedValueOnce(new Error("boom"));
		const waitUntil = vi.fn();
		const result = (entry.fetch as (req: Request, env: unknown, ctx: unknown) => Promise<Response>)(
			new Request("https://ktb.test/"),
			{},
			{ waitUntil },
		);
		await expect(result).rejects.toThrow("boom");
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await waitUntil.mock.calls[0]?.[0];
		expect(mocks.flushTelemetry).toHaveBeenCalled();
	});
});
