import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { Principal } from "@ktb/authz";
import {
	DocumentStore,
	type DocumentStoreError,
	type Fields,
	type InferInsert,
} from "@ktb/document-store";
import { Permissions, splitPermission } from "@ktb/rbac";

import {
	exposureKey,
	exposureMethods,
	ApiExposures,
	type ApiExposure,
	type ApiMethod,
} from "./exposure.ts";
import {
	apiError,
	badRequest,
	methodFor,
	notFound,
	parseListQuery,
	recordToJson,
	ApiError,
} from "./http.ts";

/**
 * Api domain service: the authorization + dispatch layer behind the
 * `/api/documents/*` splat route. Exposures arrive via the
 * `ApiExposures` registry (app-host composition, same injection pattern
 * as `DocumentCollections`/`ViewDefinitions`); records go through
 * `DocumentStore` with NO `ctx` — the bound `Principal` supplies
 * owner/tenant fencing, so an API call can never read or write outside
 * the caller's visible scope (`ownerId`/`unscoped` are system-only
 * escape hatches this service deliberately never sets).
 *
 * Authorization is three-layered like every plugin surface:
 *
 * 1. DEFAULT-DENY exposure: only collections with an `api.expose`
 *    contribution resolve; unknown keys, unexposed collections and
 *    malformed paths collapse to the same 404.
 * 2. Method gate: the exposure's `methods` list (default read-only
 *    `["list","get"]`) must publish the requested verb — anything else
 *    is 405.
 * 3. Session + permission: `public: true` exposures serve anonymous
 *    `list`/`get`; every other call needs a bound Principal (401
 *    without one) and, when `permission` is declared, the rbac
 *    `Permissions` grant (403 on denial — fail closed when the rbac
 *    plugin is absent). A declared permission is checked for
 *    authenticated callers even on a public exposure's write methods.
 */

/** What the route hands the service — already-parsed HTTP concerns
 * (path segments, query string, JSON body). */
export interface ApiRequest {
	/** Exposure URL key (collection name or basePath tail). */
	readonly key: string;
	/** Numeric record id; null on collection-level paths. */
	readonly id: number | null;
	/** HTTP method as received (GET/POST/PATCH/DELETE/…). */
	readonly method: string;
	/** Raw query string params (list endpoint only — ignored elsewhere). */
	readonly query?: URLSearchParams;
	/** Parsed JSON body (create/update only). */
	readonly body?: unknown;
}

/** What the route serializes: an HTTP status plus an optional JSON
 * body (undefined → empty response, e.g. 204 deletes). */
export interface ApiResult {
	readonly status: number;
	readonly body?: unknown;
}

export interface ApiShape {
	/** Resolve exposure → method gate → authz → store call. Every
	 * client-visible failure is an `ApiError`; defects propagate. */
	readonly handle: (request: ApiRequest) => Effect.Effect<ApiResult, ApiError>;
}

export class Api extends Context.Service<Api, ApiShape>()("@ktb/api/Api") {}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Map a DocumentStore typed failure onto the HTTP envelope. The
 * store's errors are already scope-safe (RecordNotFound covers
 * missing AND not-visible), so no existence oracle leaks. */
const mapStoreError = (error: DocumentStoreError): ApiError => {
	switch (error._tag) {
		case "UnknownCollection":
			return notFound(`unknown collection "${error.name}"`);
		case "RecordNotFound":
			return notFound(`record ${error.id} not found in this collection`);
		case "DocumentValidationError":
			return badRequest("invalid document", error.issues);
		case "InvalidDocumentQuery":
			return badRequest("invalid query", error.issues);
		case "DuplicateFieldValue":
			return apiError(409, "conflict", `duplicate value for field "${error.field}" in this scope`);
		case "BrokenReference":
			return badRequest(
				`field "${error.field}" references missing ${error.targetCollection} record ${error.targetId}`,
			);
		case "DocumentInUse":
			return apiError(
				409,
				"conflict",
				`record is still referenced by ${error.referencedBy.join(", ")}`,
			);
		/* v8 ignore next -- the union is exhaustive; a new store error tag must be mapped deliberately */
		default:
			return apiError(500, "internal", "internal error");
	}
};

/** Run a store call, translating its typed failures into ApiError. */
const viaStore = <A>(effect: Effect.Effect<A, DocumentStoreError>): Effect.Effect<A, ApiError> =>
	effect.pipe(Effect.catch((error: DocumentStoreError) => Effect.fail(mapStoreError(error))));

/** create/update bodies must be plain JSON objects — arrays, scalars
 * and null are client bugs, not partial documents. */
const bodyObject = (body: unknown): Effect.Effect<Record<string, unknown>, ApiError> =>
	isPlainObject(body)
		? Effect.succeed(body)
		: Effect.fail(badRequest("request body must be a JSON object"));

export const ApiLive = Layer.effect(
	Api,
	Effect.gen(function* () {
		const store = yield* DocumentStore;
		const registry = yield* ApiExposures;
		// Permissions is an OPTIONAL port (rbac plugin may be disabled):
		// an exposure with a declared `permission` fails closed without
		// it; exposures without one only need a session.
		const permissions = yield* Effect.serviceOption(Permissions);

		const byKey = new Map(registry.exposures.map((def) => [exposureKey(def), def] as const));

		/** Session + permission gate. Public list/get bypasses BOTH
		 * checks — `public: true` IS the anonymous-read decision. */
		const authorize = (exposure: ApiExposure, op: ApiMethod): Effect.Effect<void, ApiError> =>
			Effect.gen(function* () {
				if (exposure.public === true && (op === "list" || op === "get")) return;
				const principal = yield* Principal;
				if (principal === null) {
					return yield* Effect.fail(apiError(401, "unauthenticated", "authentication required"));
				}
				if (exposure.permission === undefined) return;
				if (Option.isNone(permissions)) {
					return yield* Effect.fail(apiError(403, "forbidden", "permission check unavailable"));
				}
				const { resource, action } = splitPermission(exposure.permission);
				const allowed = yield* permissions.value.can(resource, action);
				if (!allowed) {
					return yield* Effect.fail(apiError(403, "forbidden", "permission denied"));
				}
			});

		const list = (
			exposure: ApiExposure,
			query: URLSearchParams | undefined,
		): Effect.Effect<ApiResult, ApiError> =>
			Effect.gen(function* () {
				const parsed = parseListQuery(query ?? new URLSearchParams());
				if (!parsed.ok) return yield* Effect.fail(parsed.error);
				const result = yield* viaStore(store.find(exposure.collection, parsed.value.query));
				return {
					status: 200,
					body: {
						rows: result.rows.map(recordToJson),
						total: result.total,
						limit: parsed.value.limit,
						offset: parsed.value.offset,
					},
				};
			});

		const get = (exposure: ApiExposure, id: number): Effect.Effect<ApiResult, ApiError> =>
			Effect.gen(function* () {
				const record = yield* viaStore(store.get(exposure.collection, id));
				if (record === null) {
					return yield* Effect.fail(notFound(`record ${id} not found`));
				}
				return { status: 200, body: recordToJson(record) };
			});

		const create = (exposure: ApiExposure, body: unknown): Effect.Effect<ApiResult, ApiError> =>
			Effect.gen(function* () {
				const data = yield* bodyObject(body);
				const record = yield* viaStore(
					store.insert(exposure.collection, data as InferInsert<Fields>),
				);
				return { status: 201, body: recordToJson(record) };
			});

		const update = (
			exposure: ApiExposure,
			id: number,
			body: unknown,
		): Effect.Effect<ApiResult, ApiError> =>
			Effect.gen(function* () {
				const data = yield* bodyObject(body);
				const record = yield* viaStore(
					store.update(exposure.collection, id, data as Partial<InferInsert<Fields>>),
				);
				return { status: 200, body: recordToJson(record) };
			});

		const remove = (exposure: ApiExposure, id: number): Effect.Effect<ApiResult, ApiError> =>
			viaStore(store.delete(exposure.collection, id)).pipe(Effect.as({ status: 204 }));

		return Api.of({
			handle: (request) =>
				Effect.gen(function* () {
					const exposure = byKey.get(request.key);
					// Unknown key, unexposed collection and malformed paths
					// all land here — one indistinguishable 404.
					if (exposure === undefined) {
						return yield* Effect.fail(notFound("not found"));
					}
					const resolved = methodFor(request.method, request.id);
					if (resolved === null) {
						return yield* Effect.fail(
							apiError(405, "method_not_allowed", "method not allowed for this path"),
						);
					}
					if (!exposureMethods(exposure).includes(resolved.method)) {
						return yield* Effect.fail(
							apiError(
								405,
								"method_not_allowed",
								`method "${resolved.method}" is not exposed for this collection`,
							),
						);
					}
					yield* authorize(exposure, resolved.method);
					// methodFor only resolves id-methods when request.id is a
					// number — the cast restates that contract for TS.
					const id = request.id as number;
					switch (resolved.method) {
						case "list":
							return yield* list(exposure, request.query);
						case "get":
							return yield* get(exposure, id);
						case "create":
							return yield* create(exposure, request.body);
						case "update":
							return yield* update(exposure, id, request.body);
						case "delete":
							return yield* remove(exposure, id);
					}
				}),
		});
	}),
);
