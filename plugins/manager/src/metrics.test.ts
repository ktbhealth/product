import { describe, expect, it } from "vitest";

import { parsePrometheusSeries, summarizeMetrics } from "./metrics.ts";

describe("parsePrometheusSeries", () => {
	it("parses names, labels and values; skips comments/blanks/malformed", () => {
		const text = [
			"# HELP ktb_x_total help text",
			"# TYPE ktb_x_total counter",
			"",
			'ktb_x_total{fn="abc",status="200"} 5',
			"ktb_y_total 2.5",
			"not a metric line",
			"bad_metric{unclosed 1",
			"ktb_nan_total NaN",
			"ktb_inf_total +Inf",
			'ktb_esc_total{path="a\\"b\\\\c\\n"} 1',
		].join("\n");
		expect(parsePrometheusSeries(text)).toEqual([
			{ name: "ktb_x_total", labels: { fn: "abc", status: "200" }, value: 5 },
			{ name: "ktb_y_total", labels: {}, value: 2.5 },
			{ name: "ktb_esc_total", labels: { path: 'a"b\\c\n' }, value: 1 },
		]);
	});
});

describe("summarizeMetrics", () => {
	it("returns empty sections for an empty exposition", () => {
		expect(summarizeMetrics("")).toEqual({ serverFns: [], sessionContexts: [] });
	});

	it("aggregates serverFn counters and histogram averages per fn", () => {
		const text = [
			"# TYPE ktb_server_fn_requests_total counter",
			'ktb_server_fn_requests_total{fn="aaa",status="200"} 3',
			'ktb_server_fn_requests_total{fn="aaa",status="500"} 2',
			'ktb_server_fn_requests_total{fn="aaa"} 1', // no Response resolved
			'ktb_server_fn_requests_total{fn="bbb",status="404"} 4',
			'ktb_server_fn_requests_total{fn="bbb",status="not-a-code"} 1',
			'ktb_server_fn_request_duration_ms_sum{fn="aaa"} 300',
			'ktb_server_fn_request_duration_ms_count{fn="aaa"} 6',
			'ktb_server_fn_request_duration_ms_sum{fn="bbb"} 40',
			'ktb_server_fn_request_duration_ms_count{fn="bbb"} 5',
			// Buckets/other series are ignored.
			'ktb_server_fn_request_duration_ms_bucket{fn="aaa",le="100"} 2',
			'ktb_other_total{fn="zzz"} 9',
		].join("\n");
		const { serverFns } = summarizeMetrics(text);
		expect(serverFns).toEqual([
			// Sorted by requests desc: aaa (6) before bbb (5).
			{ fn: "aaa", requests: 6, errors: 2, avgDurationMs: 50 },
			{ fn: "bbb", requests: 5, errors: 0, avgDurationMs: 8 },
		]);
	});

	it("reports null avg when a fn has requests but no histogram samples", () => {
		const { serverFns } = summarizeMetrics('ktb_server_fn_requests_total{fn="ccc",status="200"} 2');
		expect(serverFns).toEqual([{ fn: "ccc", requests: 2, errors: 0, avgDurationMs: null }]);
	});

	it("groups session-context lookups and load durations by context", () => {
		const text = [
			'ktb_session_context_lookups_total{context="session",result="cache"} 7',
			'ktb_session_context_lookups_total{context="session",result="load"} 3',
			'ktb_session_context_lookups_total{context="doctor",result="load"} 2',
			'ktb_session_context_load_duration_ms_sum{context="session"} 90',
			'ktb_session_context_load_duration_ms_count{context="session"} 3',
			'ktb_session_context_load_duration_ms_sum{context="doctor"} 10',
			'ktb_session_context_load_duration_ms_count{context="doctor"} 2',
		].join("\n");
		expect(summarizeMetrics(text).sessionContexts).toEqual([
			{ context: "doctor", lookups: 2, loads: 2, avgLoadDurationMs: 5 },
			{ context: "session", lookups: 10, loads: 3, avgLoadDurationMs: 30 },
		]);
	});

	it("falls back to 'unknown' for series missing their key label", () => {
		const { serverFns, sessionContexts } = summarizeMetrics(
			[
				'ktb_server_fn_requests_total{status="200"} 1',
				"ktb_server_fn_request_duration_ms_sum 8",
				"ktb_server_fn_request_duration_ms_count 2",
				'ktb_session_context_lookups_total{result="load"} 4',
				"ktb_session_context_load_duration_ms_sum 8",
				"ktb_session_context_load_duration_ms_count 2",
			].join("\n"),
		);
		expect(serverFns).toEqual([{ fn: "unknown", requests: 1, errors: 0, avgDurationMs: 4 }]);
		expect(sessionContexts).toEqual([
			{ context: "unknown", lookups: 4, loads: 4, avgLoadDurationMs: 4 },
		]);
	});

	it("sorts serverFns deterministically on tied request counts", () => {
		const { serverFns } = summarizeMetrics(
			[
				'ktb_server_fn_requests_total{fn="zzz",status="200"} 1',
				'ktb_server_fn_requests_total{fn="aaa",status="200"} 1',
			].join("\n"),
		);
		expect(serverFns.map((r) => r.fn)).toEqual(["aaa", "zzz"]);
	});
});
