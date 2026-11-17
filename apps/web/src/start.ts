import { createMiddleware, createStart } from "@tanstack/react-start";
import {
	getServerAsyncLocalStorage,
	overwriteServerAsyncLocalStorage,
} from "#/paraglide/runtime.js";
import { requestLocale } from "#/lib/i18n.ts";
import { accessLog } from "#/lib/access-log.ts";
import { unwrapResponse } from "#/lib/response.ts";
import { serverFnIdFromPathname } from "#/lib/server-fn.ts";
import {
	isValidTraceparent,
	newRequestId,
	recordUnsafe,
	sanitizeRequestId,
	tagged,
	httpRequests,
	httpRequestDuration,
	serverFnRequests,
	serverFnRequestDuration,
} from "@ktb/observability";

// Runs every request inside paraglide's AsyncLocalStorage so getLocale()
// resolves the ktb-locale cookie during SSR — the cookie strategy cannot
// read request headers without it (paraglideMiddleware equivalent for
// TanStack Start's request-middleware pipeline).
const localeMiddleware = createMiddleware().server(async ({ request, next }) => {
	const locale = requestLocale(request);
	let als = getServerAsyncLocalStorage();
	if (!als) {
		const { AsyncLocalStorage } = await import("node:async_hooks");
		als = new AsyncLocalStorage();
		overwriteServerAsyncLocalStorage(als);
	}
	return als.run({ locale, origin: new URL(request.url).origin }, () => next());
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
		// Per-server-function breakdown: the createServerFn id rides the
		// `/_serverFn/<id>` path, so serverFn requests get their own
		// counter/histogram series on top of the aggregate http_* ones.
		const serverFnId = handlerType === "serverFn" ? serverFnIdFromPathname(pathname) : undefined;

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
			if (serverFnId !== undefined) {
				recordUnsafe(
					tagged(serverFnRequests, {
						fn: serverFnId,
						...(status !== undefined ? { status } : {}),
					}),
					1,
				);
				recordUnsafe(tagged(serverFnRequestDuration, { fn: serverFnId }), durationMs);
			}
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
