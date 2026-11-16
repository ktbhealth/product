import { createMiddleware, createStart } from "@tanstack/react-start";
import { requestLocale } from "#/lib/i18n.ts";
import { localeStorage } from "#/lib/locale-context.ts";
import { accessLog } from "#/lib/access-log.ts";
import { unwrapResponse } from "#/lib/response.ts";
import {
	isValidTraceparent,
	newRequestId,
	recordUnsafe,
	sanitizeRequestId,
	tagged,
	httpRequests,
	httpRequestDuration,
} from "@ktb/observability";

// Runs every request inside the locale AsyncLocalStorage so
// currentLocale() resolves the ktb-locale cookie during SSR and in
// server fns — deep server code (email copy, plugin services) reads the
// active locale without threading it through every signature.
// One-time ALS failure warning: when node:async_hooks can't be
// imported (runtime regression — the compat date implies
// nodejs_compat_v2, see alchemy.run.ts) every request silently serves
// the base locale. Log once per isolate so the degradation is visible
// instead of looking like "everyone uses en".
let alsUnavailableWarned = false;

const localeMiddleware = createMiddleware().server(async ({ request, next }) => {
	const locale = requestLocale(request);
	// Singleton ALS (see locale-context.ts) — a per-request instance
	// would race under concurrent requests on one isolate. When the ALS
	// can't be created (non-Node runtime, failed import) the request
	// still proceeds without locale context — currentLocale() falls
	// back to the base locale outside a store.
	const als = await localeStorage().catch((error: unknown) => {
		if (!alsUnavailableWarned) {
			alsUnavailableWarned = true;
			console.warn(
				`[i18n] locale AsyncLocalStorage unavailable; requests serve the base locale: ${String(error)}`,
			);
		}
		return undefined;
	});
	if (als === undefined) return next();
	return als.run({ locale }, () => next());
});

/**
 * Edge observability middleware: request id + trace correlation, RED
 * metrics (rate/errors/duration) and a structured access log for EVERY
 * request — including non-Effect routes (auth, api, static) that never
 * reach `run`/`runAs`. Effect-level telemetry (spans, domain logs) is
 * seeded separately inside platform.ts from the same headers.
 */
const telemetryMiddleware = createMiddleware().server(
	async ({ request, next, handlerType, pathname }) => {
		// Correlation headers are client-controlled — validate before
		// propagating into logs, response headers and trace context.
		// Malformed values are replaced by a fresh id / dropped parent.
		const requestId = sanitizeRequestId(request.headers.get("x-request-id")) ?? newRequestId();
		const rawTraceparent = request.headers.get("traceparent");
		const traceparent = isValidTraceparent(rawTraceparent) ? rawTraceparent : undefined;
		const started = Date.now();

		// RED metrics + structured access log — shared by the success and
		// the thrown-request paths so errors can't go unobserved.
		const emit = async (status: number | undefined): Promise<void> => {
			const durationMs = Date.now() - started;
			// `status` stays off the metric when no Response resolved —
			// a literal 0 would be a bogus status series polluting the
			// label set (dashboards regex-match real codes like "5..").
			recordUnsafe(
				tagged(httpRequests, {
					handlerType,
					...(status !== undefined ? { status } : {}),
				}),
				1,
			);
			recordUnsafe(tagged(httpRequestDuration, { handlerType }), durationMs);
			// Emitted through the app runtime's logger set (console JSON +
			// OTLP) via the sink platform.ts registers, so the record
			// reaches exporters, not just Workers Logs. Falls back to a
			// raw console line before composition (see access-log.ts).
			await accessLog({
				method: request.method,
				path: pathname,
				// Access-log `status` is a required number; 0 means "no
				// Response resolved" (same convention as before — Loki
				// queries filter on real codes like `status >= 500`).
				status: status ?? 0,
				handlerType,
				durationMs,
				requestId,
				traceId: traceparent?.split("-")[1],
				traceparent,
			});
		};

		let result: Awaited<ReturnType<typeof next>>;
		try {
			result = await next();
		} catch (error) {
			// A throwing handler still produces metrics + an access record
			// (status 500) — then the error propagates to the framework's
			// error handling unchanged.
			await emit(500);
			throw error;
		}

		// `next()` resolves to the shared pipeline result; `response` is
		// typed `Response` but SSR may hand back a wrapper carrying one.
		const response = unwrapResponse(result);

		await emit(response?.status);

		// Echo correlation ids back so clients/support can quote them.
		// Response headers on a constructed Response are mutable pre-send.
		if (response) {
			response.headers.set("x-request-id", requestId);
			if (traceparent !== undefined) response.headers.set("x-traceparent", traceparent);
		}
		return result;
	},
);

export const startInstance = createStart(() => ({
	requestMiddleware: [localeMiddleware, telemetryMiddleware],
}));
