/**
 * Prometheus text-exposition parsing + aggregation for the manager's
 * runtime-metrics panel. The server fn scrapes `Telemetry.scrape()`
 * (same source as GET /api/metrics) and reduces the exposition to the
 * rows the UI renders — the wire payload stays small and the parsing
 * stays pure/unit-testable.
 *
 * Series consumed (emitted by #100 in packages/observability):
 * - `ktb_server_fn_requests_total{fn,status}` — counter; `status` is
 *   absent when no Response resolved.
 * - `ktb_server_fn_request_duration_ms_{sum,count}{fn}` — histogram
 *   totals (buckets are ignored: cumulative avg only, no rates).
 * - `ktb_session_context_lookups_total{context,result}` — counter.
 * - `ktb_session_context_load_duration_ms_{sum,count}{context}`.
 *
 * fn→plugin attribution is NOT derivable: the `fn` label is a sha256
 * of `file--export` (see apps/web/src/lib/server-fn.ts), so rows are
 * keyed by the raw fn id. If plugin-labeled `ktb_plugin_*` series ever
 * land they can be folded in here without changing the wire shape.
 */

/** One parsed exposition line: metric name, label set, sample value. */
export interface PrometheusSeries {
	readonly name: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly value: number;
}

const SERIES_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)\s*$/;
const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** Prometheus label escaping is limited to \\ \" \n. */
const unescapeLabel = (raw: string): string =>
	raw.replace(/\\(["\\n])/g, (_m, ch: string) => (ch === "n" ? "\n" : ch));

/**
 * Parse Prometheus text exposition into flat series. Comments (`#`),
 * blank lines, malformed lines and non-finite samples (`NaN`, `+Inf`)
 * are skipped — exposition is best-effort input, never trusted shape.
 */
export const parsePrometheusSeries = (text: string): readonly PrometheusSeries[] => {
	const series: PrometheusSeries[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const match = SERIES_RE.exec(trimmed);
		if (match === null) continue;
		const value = Number.parseFloat(match[3]!);
		if (!Number.isFinite(value)) continue;
		const labels: Record<string, string> = {};
		const labelText = match[2];
		if (labelText !== undefined) {
			for (const lm of labelText.matchAll(LABEL_RE)) {
				labels[lm[1]!] = unescapeLabel(lm[2]!);
			}
		}
		series.push({ name: match[1]!, labels, value });
	}
	return series;
};

/** Per-serverFn rollup: totals plus histogram sum/count for the avg. */
interface ServerFnMetricRow {
	/** createServerFn id (sha256 of file--export) — not plugin-attributable. */
	readonly fn: string;
	readonly requests: number;
	/** Requests whose resolved status was >= 500. */
	readonly errors: number;
	/** Mean request wall time; null when the histogram saw no samples. */
	readonly avgDurationMs: number | null;
}

/** Per session-context rollup (session | doctor | patient). */
interface SessionContextMetricRow {
	readonly context: string;
	/** All lookups (cache hits + loads). */
	readonly lookups: number;
	/** Lookups that actually hit the backing store (`result: load`). */
	readonly loads: number;
	/** Mean uncached-load wall time; null when no loads recorded. */
	readonly avgLoadDurationMs: number | null;
}

/** Aggregated snapshot returned by the manager metrics server fn. */
export interface ManagerMetrics {
	readonly serverFns: readonly ServerFnMetricRow[];
	readonly sessionContexts: readonly SessionContextMetricRow[];
}

const UNKNOWN = "unknown";

interface FnAccumulator {
	requests: number;
	errors: number;
	durationSum: number;
	durationCount: number;
}

interface ContextAccumulator {
	lookups: number;
	loads: number;
	durationSum: number;
	durationCount: number;
}

const emptyFn = (): FnAccumulator => ({
	requests: 0,
	errors: 0,
	durationSum: 0,
	durationCount: 0,
});

const emptyContext = (): ContextAccumulator => ({
	lookups: 0,
	loads: 0,
	durationSum: 0,
	durationCount: 0,
});

/** `status` is a resolved HTTP code; anything non-numeric or <500 is
 * not an error. Absent status (no Response) counts as neither. */
const isErrorStatus = (status: string | undefined): boolean => {
	if (status === undefined) return false;
	const code = Number(status);
	return Number.isFinite(code) && code >= 500;
};

const avg = (sum: number, count: number): number | null => (count > 0 ? sum / count : null);

/**
 * Reduce a Prometheus exposition to the manager metrics wire shape.
 * Counters are cumulative since process start — no rate windows.
 */
export const summarizeMetrics = (text: string): ManagerMetrics => {
	const fns = new Map<string, FnAccumulator>();
	const contexts = new Map<string, ContextAccumulator>();
	const fnRow = (key: string): FnAccumulator => {
		let row = fns.get(key);
		if (row === undefined) {
			row = emptyFn();
			fns.set(key, row);
		}
		return row;
	};
	const ctxRow = (key: string): ContextAccumulator => {
		let row = contexts.get(key);
		if (row === undefined) {
			row = emptyContext();
			contexts.set(key, row);
		}
		return row;
	};

	for (const s of parsePrometheusSeries(text)) {
		switch (s.name) {
			case "ktb_server_fn_requests_total": {
				const row = fnRow(s.labels["fn"] ?? UNKNOWN);
				row.requests += s.value;
				if (isErrorStatus(s.labels["status"])) row.errors += s.value;
				break;
			}
			case "ktb_server_fn_request_duration_ms_sum":
				fnRow(s.labels["fn"] ?? UNKNOWN).durationSum += s.value;
				break;
			case "ktb_server_fn_request_duration_ms_count":
				fnRow(s.labels["fn"] ?? UNKNOWN).durationCount += s.value;
				break;
			case "ktb_session_context_lookups_total": {
				const row = ctxRow(s.labels["context"] ?? UNKNOWN);
				row.lookups += s.value;
				if (s.labels["result"] === "load") row.loads += s.value;
				break;
			}
			case "ktb_session_context_load_duration_ms_sum":
				ctxRow(s.labels["context"] ?? UNKNOWN).durationSum += s.value;
				break;
			case "ktb_session_context_load_duration_ms_count":
				ctxRow(s.labels["context"] ?? UNKNOWN).durationCount += s.value;
				break;
			default:
				break;
		}
	}

	const serverFns = [...fns.entries()]
		.map(([fn, r]) => ({
			fn,
			requests: r.requests,
			errors: r.errors,
			avgDurationMs: avg(r.durationSum, r.durationCount),
		}))
		.sort((a, b) => b.requests - a.requests || a.fn.localeCompare(b.fn));

	const sessionContexts = [...contexts.entries()]
		.map(([context, r]) => ({
			context,
			lookups: r.lookups,
			loads: r.loads,
			avgLoadDurationMs: avg(r.durationSum, r.durationCount),
		}))
		.sort((a, b) => a.context.localeCompare(b.context));

	return { serverFns, sessionContexts };
};
