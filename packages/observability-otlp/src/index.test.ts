import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { OtlpExporter } from "effect/observability";
import * as Tracer from "effect/Tracer";

import { tagged, telemetryConfigFromEnv, telemetryErrors, Telemetry } from "@ktb/observability";

import { makeOtlpLayers, otlpTelemetryDriver, TelemetryOtlpLive } from "./index.ts";

// https — plain http is only allowed for local collectors (see
// guardOtlpEndpoints in @ktb/observability).
const ENDPOINT = "https://otel-collector.test:4318";

/** Env exercising every signal through the base endpoint. */
const fullEnv = {
	OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
	OTEL_SERVICE_NAME: "ktb-test",
	KTB_ENVIRONMENT: "test",
};

describe("otlpTelemetryDriver", () => {
	it("has the telemetry-otlp id and targets the Telemetry port", () => {
		expect(otlpTelemetryDriver.id).toBe("telemetry-otlp");
		expect(otlpTelemetryDriver.port).toBe(Telemetry.key);
	});

	it("is ineligible without any OTLP endpoint", () => {
		expect(otlpTelemetryDriver.when?.({})).toBe(false);
	});

	it("is eligible when the base endpoint resolves all signals", () => {
		expect(otlpTelemetryDriver.when?.(fullEnv)).toBe(true);
	});

	it("is eligible with a single per-signal endpoint", () => {
		expect(
			otlpTelemetryDriver.when?.({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${ENDPOINT}/v1/traces` }),
		).toBe(true);
	});

	it("is eligible with only a metrics endpoint", () => {
		expect(
			otlpTelemetryDriver.when?.({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${ENDPOINT}/v1/metrics` }),
		).toBe(true);
	});

	it("is ineligible when OTEL_SDK_DISABLED is set", () => {
		expect(otlpTelemetryDriver.when?.({ ...fullEnv, OTEL_SDK_DISABLED: "true" })).toBe(false);
		expect(otlpTelemetryDriver.when?.({ ...fullEnv, OTEL_SDK_DISABLED: "1" })).toBe(false);
	});

	it("is ineligible when every endpoint is insecure remote http", () => {
		expect(
			otlpTelemetryDriver.when?.({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.example.com" }),
		).toBe(false);
	});

	it("stays eligible when only some signals were dropped as insecure", () => {
		expect(
			otlpTelemetryDriver.when?.({
				OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces.example.com/v1/traces",
			}),
		).toBe(true);
	});

	it("provides a layer", () => {
		const layer = otlpTelemetryDriver.provides(fullEnv);
		expect(Layer.isLayer(layer)).toBe(true);
	});
});

interface CapturedRequest {
	readonly url: string;
	readonly body: string;
}

/** HttpClient stub that records requests and answers 200 — keeps tests
 * hermetic (no fetch, no collector). */
const makeStubHttp = () => {
	const requests: CapturedRequest[] = [];
	const client = HttpClient.make((request, url) => {
		const body = request.body;
		const text =
			body._tag === "Uint8Array"
				? (body.text ?? new TextDecoder().decode(body.body))
				: body._tag === "Raw"
					? String(body.body)
					: "";
		requests.push({ url: url.toString(), body: text });
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
			),
		);
	});
	return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const testMetric = Metric.counter("ktb_test_otlp_exports_total");

const flushAll = Effect.gen(function* () {
	const flusher = yield* OtlpExporter.Flusher;
	yield* flusher.flush;
});

const countOf = <S extends { readonly count: number | bigint }>(metric: Metric.Metric<never, S>) =>
	Effect.map(Metric.value(metric), (state) => Number(state.count));

const exportErrors = () => countOf(tagged(telemetryErrors, { stage: "export" }));

/** Capture console.log output — the consoleJsonLogger sink used by the
 * fallback logger set and by warnings like telemetry.flush.timeout. */
const captureConsole = () => {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	return { lines, restore: () => spy.mockRestore() };
};

/** Poll a metric until it exceeds `baseline` — export attempts are
 * forked by the exporter, so tests wait for the first failure to land
 * instead of sleeping a fixed amount. */
const waitForIncrease = async (read: () => Promise<number>, baseline: number): Promise<void> => {
	for (let i = 0; i < 200; i++) {
		if ((await read()) > baseline) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("metric did not increase");
};

describe("makeOtlpLayers", () => {
	it("exports logs, traces and metrics to their OTLP endpoints", async () => {
		const config = telemetryConfigFromEnv(fullEnv);
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* Effect.logInfo("otlp smoke");
					yield* Effect.withSpan(Effect.void, "otlp-test-span");
					yield* Metric.update(testMetric, 1);
					yield* flushAll;
				}),
			);
			const urls = stub.requests.map((r) => r.url);
			expect(urls).toContain(`${ENDPOINT}/v1/logs`);
			expect(urls).toContain(`${ENDPOINT}/v1/traces`);
			expect(urls).toContain(`${ENDPOINT}/v1/metrics`);

			const logs = stub.requests.find((r) => r.url.endsWith("/v1/logs"));
			expect(logs?.body).toContain("resourceLogs");
			expect(logs?.body).toContain("ktb-test");
			// Resource identity attributes from signalBase — serviceName,
			// environment and OTEL_RESOURCE_ATTRIBUTES all land here.
			expect(logs?.body).toContain("deployment.environment");

			const traces = stub.requests.find((r) => r.url.endsWith("/v1/traces"));
			expect(traces?.body).toContain("resourceSpans");
			expect(traces?.body).toContain("otlp-test-span");

			const metrics = stub.requests.find((r) => r.url.endsWith("/v1/metrics"));
			expect(metrics?.body).toContain("resourceMetrics");
			expect(metrics?.body).toContain("ktb_test_otlp_exports_total");
		} finally {
			await runtime.dispose();
		}
	});

	it("only exports the signals with configured endpoints", async () => {
		const config = telemetryConfigFromEnv({
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${ENDPOINT}/v1/logs`,
		});
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			const errorsBefore = await runtime.runPromise(exportErrors());
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* Effect.logInfo("logs only");
					yield* Effect.withSpan(Effect.void, "should-not-export");
					yield* Metric.update(testMetric, 1);
					yield* flushAll;
				}),
			);
			const urls = stub.requests.map((r) => r.url);
			expect(urls).toContain(`${ENDPOINT}/v1/logs`);
			expect(urls.some((u) => u.endsWith("/v1/traces"))).toBe(false);
			expect(urls.some((u) => u.endsWith("/v1/metrics"))).toBe(false);
			// No metrics exporter may be composed without a metrics
			// endpoint — a wrongly-wired one would fail its export
			// (undefined URL) and count on telemetryErrors.
			expect(await runtime.runPromise(exportErrors())).toBe(errorsBefore);
		} finally {
			await runtime.dispose();
		}
	});

	it("exports only metrics and keeps console health for the other signals", async () => {
		const config = telemetryConfigFromEnv({
			OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${ENDPOINT}/v1/metrics`,
		});
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		const consoleOut = captureConsole();
		try {
			const errorsBefore = await runtime.runPromise(exportErrors());
			const health = await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					yield* Effect.logInfo("metrics only signal");
					yield* Metric.update(testMetric, 1);
					yield* t.flush;
					return yield* t.health;
				}),
			);
			// Active via metrics only: logs fall back to console, traces
			// stay off, metrics go OTLP.
			expect(health).toEqual({ logs: "console", traces: "off", metrics: "otlp" });

			const urls = stub.requests.map((r) => r.url);
			expect(urls).toContain(`${ENDPOINT}/v1/metrics`);
			expect(urls.some((u) => u.endsWith("/v1/logs"))).toBe(false);
			expect(urls.some((u) => u.endsWith("/v1/traces"))).toBe(false);

			// The fallback logger set still emits to console — an empty
			// logger layer would swallow the record silently.
			expect(consoleOut.lines.some((line) => line.includes("metrics only signal"))).toBe(true);

			// No OTLP logger may be composed without a logs endpoint —
			// its export to an undefined URL would count on
			// telemetryErrors.
			expect(await runtime.runPromise(exportErrors())).toBe(errorsBefore);
		} finally {
			consoleOut.restore();
			await runtime.dispose();
		}
	});

	it("keeps the native tracer when no traces endpoint is set", async () => {
		const config = telemetryConfigFromEnv({
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${ENDPOINT}/v1/logs`,
		});
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			const tracer = await runtime.runPromise(Effect.service(Tracer.Tracer));
			// Reference default is the native in-memory tracer — the OTLP
			// tracer must not replace it without a traces endpoint.
			expect(tracer).toBe(Tracer.nativeTracer);
		} finally {
			await runtime.dispose();
		}
	});

	it("reports per-signal health on the Telemetry service", async () => {
		const config = telemetryConfigFromEnv({
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${ENDPOINT}/v1/logs`,
		});
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			const health = await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					return yield* t.health;
				}),
			);
			// Only logs resolved: traces stay off, metrics stay on the
			// Prometheus pull path.
			expect(health).toEqual({ logs: "otlp", traces: "off", metrics: "prometheus" });
		} finally {
			await runtime.dispose();
		}
	});

	it("drops insecure remote http endpoints while keeping https signals", async () => {
		const config = telemetryConfigFromEnv({
			OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
			OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces.example.com/v1/traces",
		});
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			const health = await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					return yield* t.health;
				}),
			);
			expect(health).toEqual({ logs: "otlp", traces: "off", metrics: "otlp" });

			await runtime.runPromise(
				Effect.gen(function* () {
					yield* Effect.logInfo("partial otlp");
					yield* Metric.update(testMetric, 1);
					yield* flushAll;
				}),
			);
			const urls = stub.requests.map((r) => r.url);
			expect(urls).toContain(`${ENDPOINT}/v1/logs`);
			expect(urls).toContain(`${ENDPOINT}/v1/metrics`);
			expect(urls.some((u) => u.includes("traces.example.com"))).toBe(false);
		} finally {
			await runtime.dispose();
		}
	});

	it("flush drains signals without counting an error on success", async () => {
		const config = telemetryConfigFromEnv(fullEnv);
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			const before = await runtime.runPromise(
				countOf(tagged(telemetryErrors, { stage: "flush", reason: "timeout" })),
			);
			await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					yield* Effect.logInfo("flush succeeds");
					yield* Metric.update(testMetric, 1);
					yield* t.flush;
				}),
			);
			const after = await runtime.runPromise(
				countOf(tagged(telemetryErrors, { stage: "flush", reason: "timeout" })),
			);
			expect(after).toBe(before);
			expect(stub.requests.length).toBeGreaterThan(0);
		} finally {
			await runtime.dispose();
		}
	});

	it("counts flush timeouts on telemetryErrors", async () => {
		const config = telemetryConfigFromEnv({
			...fullEnv,
			KTB_TELEMETRY_SHUTDOWN_TIMEOUT_MS: "100",
		});
		// A transport that never answers makes every export hang — the
		// bounded drain must time out and count stage=flush.
		const hanging = HttpClient.make(() => Effect.never);
		const runtime = ManagedRuntime.make(
			makeOtlpLayers(config, Layer.succeed(HttpClient.HttpClient, hanging)),
		);
		const consoleOut = captureConsole();
		try {
			const read = () =>
				runtime.runPromise(countOf(tagged(telemetryErrors, { stage: "flush", reason: "timeout" })));
			const before = await read();
			await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					yield* Effect.logInfo("flush will time out");
					yield* Metric.update(testMetric, 1);
					yield* t.flush;
				}),
			);
			expect(await read()).toBe(before + 1);
			expect(consoleOut.lines.some((line) => line.includes("telemetry.flush.timeout"))).toBe(true);
		} finally {
			consoleOut.restore();
			await runtime.dispose();
		}
	});

	it("counts failed export attempts (HTTP error status) on telemetryErrors", async () => {
		const config = telemetryConfigFromEnv({
			...fullEnv,
			// One-item batches fork the export immediately on push — the
			// test polls for the first failed attempt instead of waiting
			// out the exporter's retry schedule.
			KTB_TELEMETRY_MAX_BATCH_SIZE: "1",
			KTB_TELEMETRY_SHUTDOWN_TIMEOUT_MS: "200",
		});
		const serverError = HttpClient.make((request) =>
			Effect.succeed(
				HttpClientResponse.fromWeb(request, new Response("collector down", { status: 500 })),
			),
		);
		const runtime = ManagedRuntime.make(
			makeOtlpLayers(config, Layer.succeed(HttpClient.HttpClient, serverError)),
		);
		try {
			const read = () => runtime.runPromise(countOf(tagged(telemetryErrors, { stage: "export" })));
			const before = await read();
			await runtime.runPromise(Effect.logInfo("export will get a 500"));
			await waitForIncrease(read, before);
		} finally {
			await runtime.dispose();
		}
	});

	it("exports log records emitted inside a log span with span attributes", async () => {
		const config = telemetryConfigFromEnv({
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${ENDPOINT}/v1/logs`,
		});
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* Effect.withLogSpan(Effect.logInfo("inside a log span"), "checkout");
					yield* flushAll;
				}),
			);
			const logs = stub.requests.find((r) => r.url.endsWith("/v1/logs"));
			expect(logs?.body).toContain("inside a log span");
			// excludeLogSpans: false keeps the effect.log_span.* attributes
			// that mark which log spans surrounded the record.
			expect(logs?.body).toContain("effect.log_span.checkout");
		} finally {
			await runtime.dispose();
		}
	});

	it("counts failed export attempts (HTTP 400) on telemetryErrors", async () => {
		const config = telemetryConfigFromEnv({
			...fullEnv,
			KTB_TELEMETRY_MAX_BATCH_SIZE: "1",
			KTB_TELEMETRY_SHUTDOWN_TIMEOUT_MS: "200",
		});
		const badRequest = HttpClient.make((request) =>
			Effect.succeed(
				HttpClientResponse.fromWeb(request, new Response("bad request", { status: 400 })),
			),
		);
		const runtime = ManagedRuntime.make(
			makeOtlpLayers(config, Layer.succeed(HttpClient.HttpClient, badRequest)),
		);
		try {
			const read = () => runtime.runPromise(exportErrors());
			const before = await read();
			await runtime.runPromise(Effect.logInfo("export will get a 400"));
			await waitForIncrease(read, before);
		} finally {
			await runtime.dispose();
		}
	});

	it("does not count successful export responses on telemetryErrors", async () => {
		const config = telemetryConfigFromEnv({
			...fullEnv,
			KTB_TELEMETRY_MAX_BATCH_SIZE: "1",
			KTB_TELEMETRY_SHUTDOWN_TIMEOUT_MS: "200",
		});
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			const before = await runtime.runPromise(exportErrors());
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* Effect.logInfo("export will succeed");
					yield* Metric.update(testMetric, 1);
					yield* flushAll;
				}),
			);
			expect(stub.requests.length).toBeGreaterThan(0);
			expect(await runtime.runPromise(exportErrors())).toBe(before);
		} finally {
			await runtime.dispose();
		}
	});

	it("counts transport-level export failures on telemetryErrors", async () => {
		const config = telemetryConfigFromEnv({
			...fullEnv,
			KTB_TELEMETRY_MAX_BATCH_SIZE: "1",
			KTB_TELEMETRY_SHUTDOWN_TIMEOUT_MS: "200",
		});
		const unreachable = HttpClient.make((request) =>
			Effect.fail(
				new HttpClientError.HttpClientError({
					reason: new HttpClientError.TransportError({
						request,
						description: "connection reset",
					}),
				}),
			),
		);
		const runtime = ManagedRuntime.make(
			makeOtlpLayers(config, Layer.succeed(HttpClient.HttpClient, unreachable)),
		);
		try {
			const read = () => runtime.runPromise(countOf(tagged(telemetryErrors, { stage: "export" })));
			const before = await read();
			await runtime.runPromise(Effect.logInfo("export will reset"));
			await waitForIncrease(read, before);
		} finally {
			await runtime.dispose();
		}
	});

	it("degrades flush to a no-op when the SDK is disabled", async () => {
		const config = telemetryConfigFromEnv({ ...fullEnv, OTEL_SDK_DISABLED: "true" });
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* Effect.logInfo("disabled sdk");
					const t = yield* Telemetry;
					yield* t.flush;
				}),
			);
			expect(stub.requests).toHaveLength(0);
		} finally {
			await runtime.dispose();
		}
	});

	it("composes no OTLP exporters when the SDK is disabled", async () => {
		// Endpoints still resolve verbatim when disabled — the layer
		// conditions must gate on `active`, not on endpoint presence.
		// Scope finalizers are an exporter's last drain chance, so the
		// request check runs after dispose to catch a wrongly-composed
		// exporter deterministically.
		const config = telemetryConfigFromEnv({ ...fullEnv, OTEL_SDK_DISABLED: "true" });
		const stub = makeStubHttp();
		const runtime = ManagedRuntime.make(makeOtlpLayers(config, stub.layer));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* Effect.logInfo("disabled sdk exports nothing");
					yield* Metric.update(testMetric, 1);
					const t = yield* Telemetry;
					yield* t.flush;
				}),
			);
		} finally {
			await runtime.dispose();
		}
		expect(stub.requests).toHaveLength(0);
	});
});

describe("TelemetryOtlpLive via driver provides", () => {
	it("composes through the driver's provides() with fetch transport", async () => {
		// Smoke only — never actually fetches because nothing is logged
		// and flush drains an empty registry. The tiny shutdown timeout
		// keeps dispose fast: the metrics exporter still attempts one
		// export of the (empty) registry against the unreachable host.
		const layer = otlpTelemetryDriver.provides({
			...fullEnv,
			KTB_TELEMETRY_SHUTDOWN_TIMEOUT_MS: "100",
		});
		const runtime = ManagedRuntime.make(layer as Layer.Layer<unknown, unknown, never>);
		try {
			const health = await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					return yield* t.health;
				}),
			);
			expect(health).toEqual({ logs: "otlp", traces: "otlp", metrics: "otlp" });
		} finally {
			await runtime.dispose();
		}
	});
});

describe("TelemetryOtlpLive", () => {
	it("provides a working Telemetry service for a disabled config", async () => {
		const config = telemetryConfigFromEnv({ OTEL_SDK_DISABLED: "1" });
		const runtime = ManagedRuntime.make(TelemetryOtlpLive(config));
		try {
			const health = await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					yield* t.flush;
					return yield* t.health;
				}),
			);
			expect(health.metrics).toBeDefined();
		} finally {
			await runtime.dispose();
		}
	});
});
