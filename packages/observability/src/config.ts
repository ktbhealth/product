/**
 * Observability configuration — resolved once at the composition root from
 * platform bindings and handed to the telemetry drivers. Ports never read
 * env themselves; `telemetryConfigFromEnv` is the single parser, kept pure
 * so every runtime (workerd, bun, node, tests) shares one code path.
 *
 * Env vars follow the OpenTelemetry SDK convention (`OTEL_*`) so a deploy
 * can point at any OTLP collector (Grafana LGTM, Jaeger, Honeycomb,
 * vendor endpoints) without code changes — cloud-agnostic by contract.
 */

/**
 * Worker var carrying the deployment env-var prefix (e.g. `"APP_"`).
 * Product-neutral name — the composing app binds it; when unset the
 * config reads unprefixed names (`ENVIRONMENT`, `LOG_LEVEL`,
 * `TELEMETRY_*`). `telemetryConfigFromEnv`'s `envPrefix` option wins
 * over this var for direct callers.
 */
export const OBSERVABILITY_ENV_PREFIX_KEY = "OBSERVABILITY_ENV_PREFIX";

/**
 * Suffixes of the deployment-prefixed telemetry vars — the package
 * stays product-blind: the full name is `${envPrefix}${suffix}` with
 * the prefix supplied by composition (see {@link TelemetryEnvOptions}) —
 * e.g. `"APP_"` resolves `APP_ENVIRONMENT` / `APP_LOG_LEVEL` /
 * `APP_TELEMETRY_*`.
 */
export const OBSERVABILITY_ENV_SUFFIXES = [
	"ENVIRONMENT",
	"LOG_LEVEL",
	"TELEMETRY_CLIENT",
	"TELEMETRY_CLIENT_SAMPLE_RATE",
	"TELEMETRY_EXPORT_INTERVAL_MS",
	"TELEMETRY_MAX_BATCH_SIZE",
	"TELEMETRY_RATE_LIMIT_GLOBAL",
	"TELEMETRY_RATE_LIMIT_PER_IP",
	"TELEMETRY_SHUTDOWN_TIMEOUT_MS",
	"TELEMETRY_TRACES_SAMPLE_RATE",
] as const;

/** Env slice the observability drivers inspect (a subset of AppEnv).
 * Only the unprefixed `OTEL_*` contract is declared — the prefixed
 * telemetry vars are read dynamically through the configured
 * {@link TelemetryEnvOptions.envPrefix} (see
 * {@link OBSERVABILITY_ENV_SUFFIXES}). */
export interface ObservabilityEnv {
	readonly OTEL_SDK_DISABLED?: string;
	readonly OTEL_SERVICE_NAME?: string;
	readonly OTEL_RESOURCE_ATTRIBUTES?: string;
	readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string;
	readonly OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?: string;
	readonly OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
	readonly OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?: string;
	readonly OTEL_EXPORTER_OTLP_HEADERS?: string;
	readonly OTEL_EXPORTER_OTLP_COMPRESSION?: string;
}

/** The unprefixed OTEL_* keys — always read verbatim regardless of
 * the configured env-var prefix. */
const OBSERVABILITY_ENV_OTEL_KEYS = [
	"OTEL_EXPORTER_OTLP_COMPRESSION",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_HEADERS",
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_RESOURCE_ATTRIBUTES",
	"OTEL_SDK_DISABLED",
	"OTEL_SERVICE_NAME",
] as const satisfies readonly (keyof ObservabilityEnv)[];

type _EnvKeysMissing = Exclude<
	keyof ObservabilityEnv,
	(typeof OBSERVABILITY_ENV_OTEL_KEYS)[number]
>;
// Stryker disable next-line BooleanLiteral: compile-time-only exhaustiveness assertion — the runtime value is never read (`void` discard below).
const _envKeysExhaustive: [_EnvKeysMissing] extends [never] ? true : never = true;
void _envKeysExhaustive;

/**
 * Canonical list of every env var name `telemetryConfigFromEnv`
 * resolves, for a given deployment prefix — the single source for
 * "which process.env keys are telemetry config". Composition edges
 * that forward env into the worker binding shape (the dev:node
 * `cloudflare:workers` shim in apps/web, the OPTIONAL list in
 * scripts/dev-secrets.mjs) consume this instead of hand-maintaining
 * parallel lists that silently drift. The returned names always
 * include {@link OBSERVABILITY_ENV_PREFIX_KEY} so an explicit prefix
 * override forwards too.
 */
export const observabilityEnvKeys = (envPrefix = ""): readonly string[] => [
	OBSERVABILITY_ENV_PREFIX_KEY,
	...OBSERVABILITY_ENV_SUFFIXES.map((suffix) => `${envPrefix}${suffix}`),
	...OBSERVABILITY_ENV_OTEL_KEYS,
];

export interface OtlpSignalEndpoints {
	readonly logs?: string;
	readonly traces?: string;
	readonly metrics?: string;
}

export interface TelemetryConfig {
	/** OTEL_SDK_DISABLED — kills every exporter; logs still go to console. */
	readonly disabled: boolean;
	readonly serviceName: string;
	readonly serviceVersion?: string;
	/** deployment.environment.resource attribute or the prefixed
	 * ENVIRONMENT var. */
	readonly environment: string;
	/** Parsed OTEL_RESOURCE_ATTRIBUTES (service.name/version excluded —
	 * they have dedicated fields). */
	readonly resourceAttributes: Record<string, string>;
	readonly otlp: {
		/** Resolved per-signal export URLs (base endpoint already expanded
		 * to `/v1/<signal>` when only the base was configured). Undefined
		 * means that signal is not exported over OTLP. */
		readonly endpoints: OtlpSignalEndpoints;
		readonly headers?: Record<string, string>;
		readonly compression: "gzip" | "none";
		readonly exportIntervalMs: number;
		readonly maxBatchSize: number;
		readonly shutdownTimeoutMs: number;
	};
	/** Head-sampling ratio for spans (0–1). 1 = export everything;
	 * parent-sampled spans are always kept (parent-based precedence). */
	readonly tracesSampleRate: number;
	/** Client (browser) telemetry ingest toggle + sample rate — enforced
	 * server-side at /api/telemetry so a misconfigured client can't flood. */
	readonly clientTelemetry: {
		readonly enabled: boolean;
		readonly sampleRate: number;
		/**
		 * Ingest rate limits (requests/minute, fixed window) enforced at
		 * /api/telemetry before the payload is even parsed — per client
		 * IP and as a global ceiling. <= 0 disables that limit.
		 */
		readonly rateLimit: {
			readonly perIpPerMinute: number;
			readonly globalPerMinute: number;
		};
	};
	/** Prefixed LOG_LEVEL var — minimum severity for emitted logs. */
	readonly logLevel?: string;
	/** Non-fatal resolution problems (e.g. an insecure remote `http://`
	 * OTLP endpoint that was dropped). Drivers surface these via
	 * `Effect.logWarning` at layer build; values never contain header
	 * secrets or full URLs. Optional for backward compatibility with
	 * hand-built configs. */
	readonly warnings?: ReadonlyArray<string>;
}

const truthy = (value: string | undefined): boolean =>
	value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

const falsy = (value: string | undefined): boolean =>
	value !== undefined && /^(0|false|no|off)$/i.test(value.trim());

/** Parse `key=value,key2=value2` — OTEL_RESOURCE_ATTRIBUTES and
 * OTEL_EXPORTER_OTLP_HEADERS share this shape; values are
 * percent-decoded per the OTLP spec (malformed pairs are skipped). */
export const parseKeyValueList = (raw: string | undefined): Record<string, string> => {
	const out: Record<string, string> = {};
	if (raw === undefined) return out;
	for (const pair of raw.split(",")) {
		const eq = pair.indexOf("=");
		// Stryker disable next-line EqualityOperator: eq === 0 yields an empty key that the `key === ""` guard below skips anyway.
		if (eq <= 0) continue;
		const key = pair.slice(0, eq).trim();
		if (key === "") continue;
		const rawValue = pair.slice(eq + 1).trim();
		let value = rawValue;
		try {
			value = decodeURIComponent(rawValue);
		} catch {
			// Keep the raw value when it isn't valid percent-encoding.
		}
		out[key] = value;
	}
	return out;
};

const parseFloatClamped = (
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number => {
	// Stryker disable next-line ConditionalExpression: parseFloat(undefined) is NaN → !isFinite → same fallback.
	if (raw === undefined) return fallback;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
};

const parseIntClamped = (
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number => {
	// Stryker disable next-line ConditionalExpression: parseInt(undefined) is NaN → isNaN → same fallback.
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isNaN(parsed)) return Math.min(max, Math.max(min, parsed));
	return fallback;
};

/** Resolve the OTLP export URL for one signal: the per-signal endpoint
 * wins verbatim; otherwise the base endpoint gets the signal's
 * `/v1/<signal>` path appended (OTLP/HTTP convention). */
const signalEndpoint = (
	signal: "logs" | "traces" | "metrics",
	perSignal: string | undefined,
	base: string | undefined,
): string | undefined => {
	if (perSignal !== undefined && perSignal.trim() !== "") return perSignal.trim();
	if (base === undefined || base.trim() === "") return undefined;
	const trimmed = base.trim().replace(/\/+$/, "");
	return `${trimmed}/v1/${signal}`;
};

/** Env var that won resolution for each signal — named in warnings so
 * the operator fixes the right knob. */
const SIGNAL_ENDPOINT_VARS = {
	logs: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	traces: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	metrics: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
} as const satisfies Record<keyof OtlpSignalEndpoints, keyof ObservabilityEnv>;

/**
 * True when an OTLP hostname is local/dev-only, where plain HTTP is
 * acceptable (otelcol, jaeger, docker-compose collectors). Covers
 * localhost names, loopback, unspecified and RFC1918/link-local IPv4 —
 * private ranges stay allowed because compose networks hand out
 * 172.x/192.168.x addresses that never leave the LAN. IPv6 is limited
 * to ::/::1; unique-local (fc00::/7) is intentionally not matched.
 */
const isLocalHostname = (hostname: string): boolean => {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	// Stryker disable next-line Regex: URL.hostname only carries brackets as the IPv6 literal wrapper (`[::1]`) — no stray `[` or `]` can appear, so anchor/char-class mutations strip identically.
	const host = normalized.replace(/^\[|\]$/g, "");
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host === "0.0.0.0" ||
		host === "::" ||
		host === "::1"
	) {
		return true;
	}
	const parts = host.split(".");
	// Stryker disable next-line ConditionalExpression: hosts with ≠4 dot-parts either normalize to 4 (WHATWG IPv4) or contain non-numeric parts → the octet check below fails → same false.
	if (parts.length !== 4) return false;
	const octets = parts.map((part) => Number(part));
	if (!octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false;
	const [a, b] = octets;
	return (
		a === 10 ||
		a === 127 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254)
	);
};

/**
 * Transport guard for OTLP endpoints: telemetry can carry sensitive
 * operational data, so plain HTTP is only allowed to local collectors.
 * Returns the offending `host[:port]` when `raw` is a parseable
 * `http://` URL with a non-local host; undefined otherwise — https,
 * non-http schemes and unparseable URLs pass through unchanged
 * (exporters surface those errors as before).
 */
const insecureRemoteHost = (raw: string): string | undefined => {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:") return undefined;
	return isLocalHostname(url.hostname) ? undefined : url.host;
};

/**
 * Drop insecure remote `http://` endpoints, recording one warning per
 * affected signal. An insecure per-signal override rejects that signal
 * outright — it does NOT fall back to the base endpoint, since the
 * operator explicitly aimed that signal elsewhere. Warnings carry only
 * scheme + host (never the full URL, which could embed userinfo
 * credentials, and never OTEL_EXPORTER_OTLP_HEADERS values).
 */
const guardOtlpEndpoints = (
	endpoints: OtlpSignalEndpoints,
	env: ObservabilityEnv,
	warnings: string[],
): OtlpSignalEndpoints => {
	const guard = (signal: keyof OtlpSignalEndpoints): string | undefined => {
		const url = endpoints[signal];
		// Stryker disable next-line ConditionalExpression: url === undefined makes insecureRemoteHost throw inside new URL → catch → undefined host → returns url (undefined) either way.
		if (url === undefined) return undefined;
		const host = insecureRemoteHost(url);
		if (host === undefined) return url;
		const perSignalVar = SIGNAL_ENDPOINT_VARS[signal];
		const source =
			(env[perSignalVar]?.trim() ?? "") === "" ? "OTEL_EXPORTER_OTLP_ENDPOINT" : perSignalVar;
		warnings.push(
			`${source} resolved an insecure http:// endpoint for signal "${signal}" ` +
				`(host "${host}") — endpoint ignored to avoid leaking telemetry in cleartext; ` +
				`use https:// or a local collector`,
		);
		return undefined;
	};
	return { logs: guard("logs"), traces: guard("traces"), metrics: guard("metrics") };
};

export interface TelemetryEnvOptions {
	/**
	 * Deployment env-var prefix applied to the telemetry vars
	 * (`${envPrefix}ENVIRONMENT`, `${envPrefix}TELEMETRY_*`, …). Wins
	 * over the {@link OBSERVABILITY_ENV_PREFIX_KEY} worker var; when
	 * neither is set the unprefixed names are read. The composing app
	 * supplies the product prefix — this package stays product-blind.
	 */
	readonly envPrefix?: string;
}

/** Dynamic env read for the prefixed vars — ObservabilityEnv only
 * declares the OTEL_* slice, so prefixed names resolve through a
 * string index. Non-string bindings (queues, DO namespaces) read as
 * undefined. */
const envString = (env: object, name: string): string | undefined => {
	const value = (env as Readonly<Record<string, unknown>>)[name];
	return typeof value === "string" ? value : undefined;
};

/**
 * Env object {@link telemetryConfigFromEnv} accepts: the declared
 * `ObservabilityEnv` slice, or any record carrying the deployment's
 * prefixed vars (`ACME_ENVIRONMENT`, `ACME_TELEMETRY_*`, …) — worker
 * envs are heterogeneous binding bags, so the record half stays loose.
 */
export type TelemetryEnvInput = ObservabilityEnv | Readonly<Record<string, unknown>>;

/**
 * Resolve telemetry configuration from platform bindings. Pure — no env
 * reads, no I/O — so tests and every runtime share the exact semantics.
 * Defaults are DX-first: no OTLP endpoint → console JSON logs only,
 * everything else off until configured.
 */
export const telemetryConfigFromEnv = (
	env: TelemetryEnvInput,
	options?: TelemetryEnvOptions,
): TelemetryConfig => {
	const otel = env as ObservabilityEnv;
	const prefix = options?.envPrefix ?? envString(env, OBSERVABILITY_ENV_PREFIX_KEY) ?? "";
	/** `${prefix}${suffix}` lookup — the prefixed telemetry vars. */
	const prefixed = (suffix: (typeof OBSERVABILITY_ENV_SUFFIXES)[number]): string | undefined =>
		envString(env, `${prefix}${suffix}`);
	const disabled = truthy(otel.OTEL_SDK_DISABLED);
	const resourceAttributes = parseKeyValueList(otel.OTEL_RESOURCE_ATTRIBUTES);
	const serviceName = otel.OTEL_SERVICE_NAME?.trim() || resourceAttributes["service.name"] || "ktb";
	const serviceVersion = resourceAttributes["service.version"];
	const environment =
		prefixed("ENVIRONMENT")?.trim() ||
		resourceAttributes["deployment.environment"] ||
		"development";
	const headersRaw = parseKeyValueList(otel.OTEL_EXPORTER_OTLP_HEADERS);
	const resolvedEndpoints: OtlpSignalEndpoints = {
		logs: signalEndpoint(
			"logs",
			otel.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
			otel.OTEL_EXPORTER_OTLP_ENDPOINT,
		),
		traces: signalEndpoint(
			"traces",
			otel.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
			otel.OTEL_EXPORTER_OTLP_ENDPOINT,
		),
		metrics: signalEndpoint(
			"metrics",
			otel.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
			otel.OTEL_EXPORTER_OTLP_ENDPOINT,
		),
	};
	// TLS enforcement: remote http:// endpoints are dropped with a
	// warning. Skipped entirely when the SDK is disabled — nothing
	// exports, so the resolved config stays verbatim.
	const warnings: string[] = [];
	const endpoints = disabled
		? resolvedEndpoints
		: guardOtlpEndpoints(resolvedEndpoints, otel, warnings);
	const compression =
		otel.OTEL_EXPORTER_OTLP_COMPRESSION?.trim().toLowerCase() === "gzip" ? "gzip" : "none";
	return {
		disabled,
		serviceName,
		serviceVersion,
		environment,
		resourceAttributes,
		otlp: {
			endpoints,
			headers: Object.keys(headersRaw).length > 0 ? headersRaw : undefined,
			compression,
			exportIntervalMs: parseIntClamped(
				prefixed("TELEMETRY_EXPORT_INTERVAL_MS"),
				10_000,
				100,
				300_000,
			),
			maxBatchSize: parseIntClamped(prefixed("TELEMETRY_MAX_BATCH_SIZE"), 512, 1, 4096),
			shutdownTimeoutMs: parseIntClamped(
				prefixed("TELEMETRY_SHUTDOWN_TIMEOUT_MS"),
				3_000,
				100,
				60_000,
			),
		},
		tracesSampleRate: parseFloatClamped(prefixed("TELEMETRY_TRACES_SAMPLE_RATE"), 1, 0, 1),
		clientTelemetry: {
			enabled: !falsy(prefixed("TELEMETRY_CLIENT")),
			sampleRate: parseFloatClamped(prefixed("TELEMETRY_CLIENT_SAMPLE_RATE"), 1, 0, 1),
			rateLimit: {
				// Generous vs. real browser bursts (a page view emits a
				// handful of batched events); the cap exists to stop log
				// spam, not to shape legitimate traffic.
				perIpPerMinute: parseIntClamped(prefixed("TELEMETRY_RATE_LIMIT_PER_IP"), 120, 0, 1_000_000),
				globalPerMinute: parseIntClamped(
					prefixed("TELEMETRY_RATE_LIMIT_GLOBAL"),
					6_000,
					0,
					10_000_000,
				),
			},
		},
		logLevel: parseLogLevel(prefixed("LOG_LEVEL")),
		warnings,
	};
};

const LOG_LEVELS = new Set(["All", "Trace", "Debug", "Info", "Warning", "Error", "Fatal", "None"]);

/** Prefixed LOG_LEVEL var → effect LogLevel, or undefined when unset/invalid. */
export const parseLogLevel = (raw: string | undefined): string | undefined => {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	const lower = trimmed.toLowerCase();
	const aliases: Record<string, string> = { warn: "Warning", err: "Error", dbg: "Debug" };
	const canonical = aliases[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1);
	return LOG_LEVELS.has(canonical) ? canonical : undefined;
};
