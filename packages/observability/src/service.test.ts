import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as References from "effect/References";

import { telemetryConfigFromEnv } from "./config.ts";
import { clientEvents, clientEventsDropped, tagged, telemetryErrors } from "./metrics.ts";
import {
	ingestClientEvents,
	makeLocalTelemetry,
	Telemetry,
	TelemetryLocalLive,
} from "./service.ts";
import type { ClientTelemetryBatch } from "./ingest.ts";

const config = telemetryConfigFromEnv({});

const batch = (events: unknown[]): ClientTelemetryBatch =>
	({ events }) as unknown as ClientTelemetryBatch;

const countOf = <S extends { readonly count: number | bigint }>(metric: Metric.Metric<never, S>) =>
	Effect.map(Metric.value(metric), (state) => Number(state.count));

interface CapturedLog {
	readonly level: string;
	readonly message: unknown;
	readonly annotations: Record<string, unknown>;
}

/** Captures structured log records (level + annotations) emitted inside
 * the effect — the observable surface ingestClientEvents writes to. */
const captureLogs = () => {
	const entries: CapturedLog[] = [];
	const logger = Logger.map(Logger.formatStructured, (record) => {
		entries.push(record);
	});
	return { entries, logger };
};

/** Run `effect` with the capturing logger and Debug level enabled so
 * logDebug records (e.g. client.error.stack) are observable too. */
const runWithLogs = <A, E>(effect: Effect.Effect<A, E, never>) => {
	const { entries, logger } = captureLogs();
	return Effect.runPromise(
		effect.pipe(
			Effect.provide(Logger.layer([logger])),
			Effect.provideService(References.MinimumLogLevel, "Debug"),
		),
	).then((value) => ({ value, entries }));
};

describe("ingestClientEvents", () => {
	it("logs and counts each event by type", async () => {
		const registry = new Map();
		const program = Effect.gen(function* () {
			yield* ingestClientEvents(config)(
				batch([
					{ type: "navigation", name: "web.navigation", path: "/a", durationMs: 10 },
					{ type: "error", name: "client.error", message: "boom", stack: "at x" },
				]),
			);
			return yield* countOf(tagged(clientEvents, { type: "error" }));
		});
		const count = await Effect.runPromise(
			Effect.provideService(program, Metric.MetricRegistry, registry),
		);
		expect(count).toBe(1);
	});

	it("counts dropped batches when client telemetry is disabled", async () => {
		const disabled = telemetryConfigFromEnv({ TELEMETRY_CLIENT: "0" });
		const registry = new Map();
		const program = Effect.gen(function* () {
			yield* ingestClientEvents(disabled)(batch([{ type: "event", name: "x" }]));
			return yield* countOf(tagged(clientEventsDropped, { reason: "disabled" }));
		});
		const count = await Effect.runPromise(
			Effect.provideService(program, Metric.MetricRegistry, registry),
		);
		expect(count).toBe(1);
	});

	it("enforces clientTelemetry.sampleRate per event", async () => {
		const sampled = telemetryConfigFromEnv({ TELEMETRY_CLIENT_SAMPLE_RATE: "0.5" });
		const registry = new Map();
		// random() >= 0.5 drops, < 0.5 keeps — drive it deterministically.
		const rolls = [0.9, 0.1, 0.9, 0.2];
		const program = Effect.gen(function* () {
			yield* ingestClientEvents(
				sampled,
				() => rolls.shift() ?? 0.9,
			)(
				batch([
					{ type: "event", name: "drop-1" },
					{ type: "event", name: "keep-1" },
					{ type: "event", name: "drop-2" },
					{ type: "event", name: "keep-2" },
				]),
			);
			return {
				kept: yield* countOf(tagged(clientEvents, { type: "event" })),
				dropped: yield* countOf(tagged(clientEventsDropped, { reason: "sampled" })),
			};
		});
		const counts = await Effect.runPromise(
			Effect.provideService(program, Metric.MetricRegistry, registry),
		);
		expect(counts).toEqual({ kept: 2, dropped: 2 });
	});

	it("drops every event when the sample rate is 0", async () => {
		const zero = telemetryConfigFromEnv({ TELEMETRY_CLIENT_SAMPLE_RATE: "0" });
		const registry = new Map();
		const program = Effect.gen(function* () {
			yield* ingestClientEvents(zero)(batch([{ type: "event", name: "x" }]));
			return yield* countOf(tagged(clientEventsDropped, { reason: "sampled" }));
		});
		const count = await Effect.runPromise(
			Effect.provideService(program, Metric.MetricRegistry, registry),
		);
		expect(count).toBe(1);
	});

	it("counts ingest defects on telemetryErrors and never fails", async () => {
		const registry = new Map();
		// A throwing attribute getter defects inside sanitizeClientEvent —
		// the batch must still resolve and count once on stage=ingest.
		const evil = {
			attributes: {
				get boom(): string {
					throw new Error("getter exploded");
				},
			},
		};
		const program = Effect.gen(function* () {
			yield* ingestClientEvents(config)(batch([{ type: "event", name: "x", ...evil }]));
			return yield* countOf(tagged(telemetryErrors, { stage: "ingest" }));
		});
		const count = await Effect.runPromise(
			Effect.provideService(program, Metric.MetricRegistry, registry),
		);
		expect(count).toBe(1);
	});
});

describe("ingestClientEvents log records", () => {
	it("logs error events at Error level and other types at Info", async () => {
		const { entries } = await runWithLogs(
			Effect.gen(function* () {
				yield* ingestClientEvents(config)(
					batch([
						{ type: "navigation", name: "web.navigation", path: "/a" },
						{ type: "error", name: "client.error", message: "boom" },
						{ type: "request", name: "web.request", status: 200 },
					]),
				);
			}),
		);
		const byMessage = new Map(entries.map((e) => [e.message, e.level]));
		expect(byMessage.get("client.navigation")).toBe("INFO");
		expect(byMessage.get("client.error")).toBe("ERROR");
		expect(byMessage.get("client.request")).toBe("INFO");
	});

	it("stamps present event fields as annotations and omits absent ones", async () => {
		const timestamp = Date.now() - 1_000;
		const { entries } = await runWithLogs(
			Effect.gen(function* () {
				yield* ingestClientEvents(config)(
					batch([
						{
							type: "request",
							name: "web.request",
							path: "/patients?tab=1",
							status: 200,
							durationMs: 12,
							message: "ok",
							requestId: "r-1",
							timestamp,
							attributes: { route: "/patients" },
						},
						{ type: "event", name: "" },
					]),
				);
			}),
		);
		const full = entries.find((e) => e.message === "client.request");
		expect(full?.annotations).toMatchObject({
			type: "request",
			name: "web.request",
			path: "/patients",
			status: 200,
			durationMs: 12,
			route: "/patients",
			"event.message": "ok",
			"event.timestamp": timestamp,
			"telemetry.request_id": "r-1",
		});
		const minimal = entries.find((e) => e.message === "client.event");
		expect(minimal?.annotations).toMatchObject({ type: "event" });
		// Absent/empty fields must not appear as annotation keys at all.
		expect(minimal?.annotations).not.toHaveProperty("name");
		expect(minimal?.annotations).not.toHaveProperty("path");
		expect(minimal?.annotations).not.toHaveProperty("status");
		expect(minimal?.annotations).not.toHaveProperty("durationMs");
		expect(minimal?.annotations).not.toHaveProperty("event.message");
		expect(minimal?.annotations).not.toHaveProperty("event.timestamp");
		expect(minimal?.annotations).not.toHaveProperty("telemetry.request_id");
		// No stack on the event → no client.error.stack record at all.
		expect(
			entries.some((e) => Array.isArray(e.message) && e.message[0] === "client.error.stack"),
		).toBe(false);
	});

	it("emits a client.error.stack debug record carrying the stack", async () => {
		const { entries } = await runWithLogs(
			Effect.gen(function* () {
				yield* ingestClientEvents(config)(
					batch([{ type: "error", name: "client.error", stack: "at foo.ts:1" }]),
				);
			}),
		);
		// logDebug("client.error.stack", { stack }) puts the payload in the
		// message args, not annotations.
		const stackEntry = entries.find(
			(e) => Array.isArray(e.message) && e.message[0] === "client.error.stack",
		);
		expect(stackEntry?.level).toBe("DEBUG");
		expect(stackEntry?.message).toEqual(["client.error.stack", { stack: "at foo.ts:1" }]);
	});

	it("drops the event when the roll lands exactly on the sample rate", async () => {
		const sampled = telemetryConfigFromEnv({ TELEMETRY_CLIENT_SAMPLE_RATE: "0.5" });
		const registry = new Map();
		const program = Effect.gen(function* () {
			yield* ingestClientEvents(sampled, () => 0.5)(batch([{ type: "event", name: "x" }]));
			return {
				kept: yield* countOf(tagged(clientEvents, { type: "event" })),
				dropped: yield* countOf(tagged(clientEventsDropped, { reason: "sampled" })),
			};
		});
		const counts = await Effect.runPromise(
			Effect.provideService(program, Metric.MetricRegistry, registry),
		);
		// random() >= sampleRate drops — 0.5 >= 0.5 must drop.
		expect(counts).toEqual({ kept: 0, dropped: 1 });
	});

	it("keeps every event at the default sample rate of 1 regardless of rolls", async () => {
		const registry = new Map();
		const program = Effect.gen(function* () {
			yield* ingestClientEvents(
				config,
				() => 0.999999,
			)(
				batch([
					{ type: "event", name: "a" },
					{ type: "event", name: "b" },
				]),
			);
			return {
				kept: yield* countOf(tagged(clientEvents, { type: "event" })),
				dropped: yield* countOf(tagged(clientEventsDropped, { reason: "sampled" })),
			};
		});
		const counts = await Effect.runPromise(
			Effect.provideService(program, Metric.MetricRegistry, registry),
		);
		expect(counts).toEqual({ kept: 2, dropped: 0 });
	});

	it("logs telemetry.ingest.failed with the cause when ingest defects", async () => {
		const { entries } = await runWithLogs(
			Effect.gen(function* () {
				yield* ingestClientEvents(config)(
					batch([
						{
							type: "event",
							name: "x",
							attributes: {
								get boom(): string {
									throw new Error("getter exploded");
								},
							},
						},
					]),
				);
			}),
		);
		const failure = entries.find((e) => e.message === "telemetry.ingest.failed");
		expect(failure?.level).toBe("ERROR");
		expect(failure?.annotations).toHaveProperty("cause");
	});
});

describe("Telemetry service key", () => {
	it("keeps the stable Context.Service identifier", () => {
		expect(Telemetry.key).toBe("@ktb/observability/Telemetry");
	});
});

describe("makeLocalTelemetry", () => {
	it("flush is a no-op, scrape returns prometheus text, health reports local exporters", async () => {
		const t = makeLocalTelemetry(config);
		await Effect.runPromise(t.flush);
		const text = await Effect.runPromise(t.scrape);
		expect(typeof text).toBe("string");
		expect(await Effect.runPromise(t.health)).toEqual({
			logs: "console",
			traces: "off",
			metrics: "prometheus",
		});
	});

	it("accepts custom health", async () => {
		const t = makeLocalTelemetry(config, { logs: "otlp", traces: "otlp", metrics: "otlp" });
		expect(await Effect.runPromise(t.health)).toEqual({
			logs: "otlp",
			traces: "otlp",
			metrics: "otlp",
		});
	});
});

describe("TelemetryLocalLive", () => {
	it("provides the Telemetry service through a layer", async () => {
		const runtime = ManagedRuntime.make(TelemetryLocalLive(config));
		try {
			const health = await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					return yield* t.health;
				}),
			);
			expect(health.logs).toBe("console");
		} finally {
			await runtime.dispose();
		}
	});
});

describe("ingestClientEvents field coverage", () => {
	it("handles minimal, fully-annotated and error events", async () => {
		const registry = new Map();
		const program = Effect.gen(function* () {
			yield* ingestClientEvents(config)(
				batch([
					{ type: "event", name: "" },
					{
						type: "request",
						name: "web.request",
						path: "/patients",
						status: 200,
						durationMs: 12,
						message: "ok",
						requestId: "r-1",
						timestamp: Date.now(),
						attributes: { route: "/patients" },
					},
					{
						type: "error",
						name: "client.error",
						message: "boom",
						stack: "at x",
					},
				]),
			);
			return yield* countOf(tagged(clientEvents, { type: "error" }));
		});
		const count = await Effect.runPromise(
			Effect.provideService(program, Metric.MetricRegistry, registry),
		);
		expect(count).toBe(1);
	});
});
