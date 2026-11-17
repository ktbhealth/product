import * as Effect from "effect/Effect";

import {
	createPluginApiRoute,
	getSessionUser,
	getTenantSelector,
	run,
	runAs,
} from "@ktb/server-fns";

import { Api } from "../service.ts";
import {
	API_MAX_BODY_BYTES,
	apiError,
	jsonResponse,
	parseDocumentsPath,
	toErrorResponse,
} from "../http.ts";

/**
 * `/api/documents/*` — the document-store HTTP surface. ONE splat route
 * serves every exposed collection: `/api/documents/<key>` lists or
 * creates, `/api/documents/<key>/<id>` reads, patches or deletes.
 * Which collections answer at all is decided by `api.expose`
 * contributions (default-deny — see ../exposure.ts); this module only
 * does HTTP plumbing: path/query/body parsing, the session lookup and
 * the run/runAs boundary. All authz + store dispatch lives in the `Api`
 * service so it stays unit-testable without Request/Response.
 *
 * Session handling mirrors the page/server-fn contract: a signed-in
 * user runs under `runAs` (Principal + Authz + resolved Tenant bound —
 * DocumentStore row fencing applies); an anonymous request runs under
 * `run` and only reaches exposures marked `public: true` for
 * list/get — the service fails everything else 401/403.
 *
 * The route module lives in this package and is mounted into the host's
 * virtual route tree by `apiRoutesPlugin` (physical("/api",
 * "src/api-routes")); the session/runtime boundary is @ktb/server-fns,
 * so no host imports are needed (P-033).
 */

const notFoundResponse = () => toErrorResponse(apiError(404, "not_found", "not found"));

/** Read + bound the JSON body for create/update. Oversized payloads
 * are rejected on content-length first, then the body is STREAMED and
 * counted in BYTES — a chunked request without the header (or with a
 * lying one) aborts the moment the running total crosses
 * API_MAX_BODY_BYTES instead of buffering the whole payload into
 * memory first. UTF-8 is multi-byte, so bytes — not string length —
 * are the honest unit. */
const readJsonBody = async (request: Request): Promise<unknown> => {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > API_MAX_BODY_BYTES) {
		throw apiError(413, "payload_too_large", "request body too large");
	}
	const stream = request.body;
	if (stream === null) {
		// No body at all — same failure shape as unparseable JSON.
		throw apiError(400, "bad_request", "request body must be valid JSON");
	}
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || value === undefined) break;
			total += value.byteLength;
			if (total > API_MAX_BODY_BYTES) {
				// Stop pulling — the rest of the body is never read.
				await reader.cancel().catch(() => {});
				throw apiError(413, "payload_too_large", "request body too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(bytes);
	try {
		return JSON.parse(text);
	} catch {
		throw apiError(400, "bad_request", "request body must be valid JSON");
	}
};

/** Shared dispatch: parse path → session → run/runAs → Api.handle →
 * Response. Every failure funnels through toErrorResponse so the wire
 * always carries the `{error:{kind,message,issues?}}` envelope. */
const dispatch = async (request: Request): Promise<Response> => {
	try {
		const url = new URL(request.url);
		const path = parseDocumentsPath(url.pathname);
		if (path === null) return notFoundResponse();

		const method = request.method.toUpperCase();
		const needsBody = method === "POST" || method === "PATCH";
		const body = needsBody ? await readJsonBody(request) : undefined;

		const user = await getSessionUser(request.headers);
		const effect = Effect.flatMap(Api, (api) =>
			api.handle({
				key: path.key,
				id: path.id,
				method,
				...(method === "GET" ? { query: url.searchParams } : {}),
				...(body === undefined ? {} : { body }),
			}),
		);
		const tenantSelector = await getTenantSelector(request.headers);
		const result =
			user === null
				? await run(effect)
				: await runAs(user, effect, tenantSelector === null ? null : tenantSelector);
		if (result.body === undefined) {
			return new Response(null, { status: result.status });
		}
		return jsonResponse(result.body, result.status);
	} catch (error) {
		return toErrorResponse(error);
	}
};

export const Route = createPluginApiRoute("api.routes")("/api/documents/$")({
	server: {
		handlers: {
			GET: ({ request }) => dispatch(request),
			POST: ({ request }) => dispatch(request),
			PATCH: ({ request }) => dispatch(request),
			DELETE: ({ request }) => dispatch(request),
		},
	},
});
