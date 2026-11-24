import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import {
	appInvocationDuration,
	appInvocations,
	clientEvents,
	clientEventsDropped,
	cqrsDispatchDuration,
	cqrsDispatchFailures,
	cqrsDispatches,
	documentStoreOpDuration,
	documentStoreOps,
	documentStoreRows,
	httpRequestDuration,
	httpRequests,
	kvOpDuration,
	kvOps,
	kvRows,
	pluginDuration,
	pluginInvocations,
	record,
	recordSafe,
	recordUnsafe,
	serverFnRequestDuration,
	serverFnRequests,
	sessionContextLoadDuration,
	sessionContextLookups,
	tagged,
	telemetryErrors,
} from "./metrics.ts";

const valueOf = <A, S>(metric: Metric.Metric<A, S>) => Effect.runPromise(Metric.value(metric));

describe("record", () => {
	it("increments counters with attributes", async () => {
		await Effect.runPromise(
			record(tagged(clientEvents, { type: "error" }), 1).pipe(
				Effect.provideService(Metric.MetricRegistry, new Map()),
			),
		);
	});
});

describe("recordUnsafe", () => {
	it("updates metrics outside Effect and never throws", () => {
		expect(() => recordUnsafe(httpRequests, 1)).not.toThrow();
		expect(() => recordUnsafe(cqrsDispatches, 1)).not.toThrow();
	});

	it("actually records the update in the ambient registry", async () => {
		// recordUnsafe swallows errors, so a no-op implementation would
		// pass the not.toThrow assertions above — assert the counter moves.
		const before = await Effect.runPromise(Metric.value(clientEventsDropped));
		recordUnsafe(clientEventsDropped, 1);
		const after = await Effect.runPromise(Metric.value(clientEventsDropped));
		expect(Number(after.count)).toBe(Number(before.count) + 1);
	});
});

describe("recordSafe", () => {
	it("updates metrics inside Effect", async () => {
		const registry = new Map();
		await Effect.runPromise(
			Effect.provideService(recordSafe(clientEvents, 1), Metric.MetricRegistry, registry),
		);
	});

	it("swallows defects so error-reporting paths never fail", async () => {
		// A registry without Map methods defects inside Metric.update —
		// recordSafe must still resolve.
		await expect(
			Effect.runPromise(
				Effect.provideService(recordSafe(clientEvents, 1), Metric.MetricRegistry, {} as never),
			),
		).resolves.toBeUndefined();
	});
});

describe("metric definitions", () => {
	it("all counters/histograms are valid Metric instances", () => {
		for (const m of [
			appInvocations,
			cqrsDispatches,
			pluginInvocations,
			httpRequests,
			serverFnRequests,
			sessionContextLookups,
			clientEvents,
			telemetryErrors,
		]) {
			expect(Metric.isMetric(m)).toBe(true);
		}
		expect(Metric.isMetric(pluginDuration)).toBe(true);
	});

	it("counters are incremental so OTLP exports them as monotonic sums", async () => {
		// OtlpMetrics maps `isMonotonic` from the counter's `incremental`
		// flag — dropping `incremental: true` silently exports counters
		// as non-monotonic sums.
		for (const m of [
			appInvocations,
			cqrsDispatches,
			httpRequests,
			serverFnRequests,
			sessionContextLookups,
			pluginInvocations,
			clientEvents,
			clientEventsDropped,
			telemetryErrors,
		]) {
			const state = await Effect.runPromise(Metric.value(m));
			expect(state).toHaveProperty("incremental", true);
		}
	});
});

describe("tagged", () => {
	it("stringifies attribute values for the OTLP attribute convention", async () => {
		const registry = new Map();
		await Effect.runPromise(
			record(tagged(clientEvents, { type: "error", count: 3, ok: true }), 1).pipe(
				Effect.provideService(Metric.MetricRegistry, registry),
			),
		);
		const snapshots = await Effect.runPromise(
			Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)),
		);
		const snapshot = snapshots.find((s) => s.id === "ktb_client_events_total");
		expect(snapshot?.attributes).toEqual({ type: "error", count: "3", ok: "true" });
	});
});

/** Metric contract — names, descriptions, kinds, monotonicity and
 * histogram bucket boundaries are all exporter-visible surface: a
 * renamed metric or dropped `incremental` flag silently breaks
 * dashboards and OTLP monotonic sums. */
type CounterMetric = Metric.Metric<number, { count: number }>;
type HistogramMetric = Metric.Metric<number, { buckets: ReadonlyArray<readonly [number, number]> }>;

describe("metric contract", () => {
	const counters: ReadonlyArray<readonly [string, CounterMetric]> = [
		["ktb_app_invocations_total", appInvocations],
		["ktb_cqrs_dispatches_total", cqrsDispatches],
		["ktb_cqrs_dispatch_failures_total", cqrsDispatchFailures],
		["ktb_plugin_invocations_total", pluginInvocations],
		["ktb_http_requests_total", httpRequests],
		["ktb_server_fn_requests_total", serverFnRequests],
		["ktb_session_context_lookups_total", sessionContextLookups],
		["ktb_client_events_total", clientEvents],
		["ktb_client_events_dropped_total", clientEventsDropped],
		["ktb_telemetry_errors_total", telemetryErrors],
		["ktb_document_store_ops_total", documentStoreOps],
		["ktb_document_store_rows_total", documentStoreRows],
		["ktb_kv_ops_total", kvOps],
		["ktb_kv_rows_total", kvRows],
	];

	it.each(counters)("%s is an incremental counter", async (id, metric) => {
		expect(metric.id).toBe(id);
		expect(metric.type).toBe("Counter");
		expect(metric.description).toBeTruthy();
		const state = await Effect.runPromise(Metric.value(metric));
		expect(state).toHaveProperty("incremental", true);
	});

	const histograms: ReadonlyArray<readonly [string, HistogramMetric, readonly number[]]> = [
		[
			"ktb_app_invocation_duration_ms",
			appInvocationDuration,
			[5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
		],
		[
			"ktb_cqrs_dispatch_duration_ms",
			cqrsDispatchDuration,
			[1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
		],
		[
			"ktb_plugin_duration_ms",
			pluginDuration,
			[5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
		],
		[
			"ktb_http_request_duration_ms",
			httpRequestDuration,
			[5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
		],
		[
			"ktb_server_fn_request_duration_ms",
			serverFnRequestDuration,
			[5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
		],
		[
			"ktb_session_context_load_duration_ms",
			sessionContextLoadDuration,
			[1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
		],
		[
			"ktb_document_store_op_duration_ms",
			documentStoreOpDuration,
			[1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000],
		],
		["ktb_kv_op_duration_ms", kvOpDuration, [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000]],
	];

	it.each(histograms)("%s buckets at the documented boundaries", async (id, metric, boundaries) => {
		expect(metric.id).toBe(id);
		expect(metric.type).toBe("Histogram");
		expect(metric.description).toBeTruthy();
		const state = await Effect.runPromise(Metric.value(metric));
		expect(state.buckets.map(([boundary]) => boundary)).toEqual(boundaries);
	});
});
