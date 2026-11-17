import * as Data from "effect/Data";

import {
	validateFilter,
	validateSort,
	type DocumentFilter,
	type FindQuery,
	type SortTerm,
} from "@ktb/document-store";
import type { DocumentRecord } from "@ktb/document-store";

import { API_BASE_PATH, API_KEY_PATTERN, type ApiMethod } from "./exposure.ts";

/**
 * HTTP edge helpers for the `/api/documents/*` surface — pure functions
 * (no Effect, no I/O) so the wire contract is unit-testable without a
 * runtime. The route module owns Request/Response plumbing; the Api
 * service owns authz + store calls; everything in between lives here.
 */

/** Page-size bounds: default 50, hard max 200 — the store itself
 * clamps to 500, the API surface is stricter on purpose (bounded
 * public queries). */
export const API_DEFAULT_LIMIT = 50;
export const API_MAX_LIMIT = 200;

/** Request body cap — JSON documents are field data, not blob
 * storage; 256 KiB is generous for intake forms/specialty packs and
 * keeps a public endpoint from being a memory amplifier. */
export const API_MAX_BODY_BYTES = 256 * 1024;

/**
 * Typed failure the service raises for every client-visible error.
 * `status`/`kind`/`message`/`issues` map 1:1 onto the wire error
 * envelope `{error: {kind, message, issues?}}`.
 */
export class ApiError extends Data.TaggedError("ApiError")<{
	readonly status: number;
	readonly kind: string;
	readonly message: string;
	readonly issues?: readonly string[];
}> {}

export const apiError = (
	status: number,
	kind: string,
	message: string,
	issues?: readonly string[],
): ApiError =>
	new ApiError({
		status,
		kind,
		message,
		...(issues === undefined || issues.length === 0 ? {} : { issues }),
	});

export const notFound = (message = "not found"): ApiError => apiError(404, "not_found", message);

export const badRequest = (message: string, issues?: readonly string[]): ApiError =>
	apiError(400, "bad_request", message, issues);

/** The consistent error envelope — every failure leaves the API in
 * this shape. */
export const errorEnvelope = (error: ApiError): Record<string, unknown> => ({
	error: {
		kind: error.kind,
		message: error.message,
		...(error.issues === undefined ? {} : { issues: error.issues }),
	},
});

/** Map a caught error to a Response: ApiError keeps its status; every
 * other failure (defects, unexpected throws) collapses to a generic
 * 500 — internals never leak onto the wire. */
export const toErrorResponse = (error: unknown): Response => {
	if (error instanceof ApiError) {
		return Response.json(errorEnvelope(error), { status: error.status });
	}
	return Response.json(errorEnvelope(apiError(500, "internal", "internal error")), {
		status: 500,
	});
};

/** JSON success response with the standard content type. */
export const jsonResponse = (body: unknown, status = 200): Response =>
	Response.json(body, { status });

/** A stored record as plain JSON — Dates become ISO strings. */
export const recordToJson = (record: DocumentRecord): Record<string, unknown> => ({
	id: record.id,
	collection: record.collection,
	data: record.data,
	ownerId: record.ownerId,
	tenantId: record.tenantId,
	createdAt: record.createdAt.toISOString(),
	updatedAt: record.updatedAt.toISOString(),
});

// ---------- path parsing ----------

export interface DocumentsPath {
	/** The exposure URL key (collection name or basePath tail). */
	readonly key: string;
	/** Numeric record id, or null on collection-level paths. */
	readonly id: number | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse a request pathname into `{key, id}` under
 * `/api/documents/`. Returns null for anything outside the subtree,
 * malformed percent-encoding, bad keys, extra segments or non-numeric
 * ids — the route maps null to the same 404 as an unknown exposure,
 * so path shape never distinguishes "not exposed" from "not a
 * collection".
 */
export const parseDocumentsPath = (pathname: string): DocumentsPath | null => {
	if (!pathname.startsWith(`${API_BASE_PATH}/`)) return null;
	const rest = pathname.slice(API_BASE_PATH.length + 1).replace(/\/+$/, "");
	if (rest === "") return null;
	const segments = rest.split("/");
	if (segments.length > 2) return null;
	let key: string;
	let idSegment: string | undefined;
	try {
		// split() always yields ≥1 segment, so segments[0] is defined.
		key = decodeURIComponent(segments[0]);
		idSegment = segments[1] === undefined ? undefined : decodeURIComponent(segments[1]);
	} catch {
		return null;
	}
	if (!API_KEY_PATTERN.test(key)) return null;
	if (idSegment === undefined) return { key, id: null };
	if (!/^\d+$/.test(idSegment)) return null;
	const id = Number(idSegment);
	if (!Number.isSafeInteger(id) || id <= 0) return null;
	return { key, id };
};

// ---------- query parsing ----------

export interface ParsedListQuery {
	readonly query: FindQuery;
	readonly limit: number;
	readonly offset: number;
}

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: ApiError };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(error: ApiError): ParseResult<T> => ({ ok: false, error });

const parseInteger = (raw: string, name: string): number | ApiError => {
	if (!/^-?\d+$/.test(raw.trim())) {
		return badRequest(`${name} must be an integer`);
	}
	const value = Number(raw.trim());
	if (!Number.isSafeInteger(value)) {
		return badRequest(`${name} must be a safe integer`);
	}
	return value;
};

/**
 * Parse `sort` — a comma-separated list where a leading `-` marks
 * descending (`sort=-createdAt,title`). Each term becomes a
 * `{field, dir}` SortTerm and the whole list is re-validated through
 * the store's `validateSort`.
 */
const parseSort = (raw: string): ParseResult<readonly SortTerm[]> => {
	const terms: SortTerm[] = [];
	for (const piece of raw.split(",")) {
		const trimmed = piece.trim();
		if (trimmed === "") continue;
		const desc = trimmed.startsWith("-");
		const field = desc ? trimmed.slice(1) : trimmed;
		if (field === "") {
			return fail(badRequest("sort terms must name a field"));
		}
		terms.push({ field, dir: desc ? "desc" : "asc" });
	}
	const issues = validateSort(terms);
	/* v8 ignore next -- terms are built with validated shape above;
	 * validateSort is belt-and-braces against a future builder bug */
	if (issues.length > 0) return fail(badRequest("invalid sort", issues));
	return ok(terms);
};

/**
 * Parse the list endpoint's query string into a `FindQuery` plus the
 * effective pagination. Accepted params (anything else → 400):
 *
 * - `filter` — a JSON-encoded document-store filter object
 *   (`{"status":{"$eq":"active"},"$or":[...]}`), validated by the
 *   store's `validateFilter`.
 * - `sort` — comma-separated fields, `-` prefix = desc.
 * - `limit` — integer in [1, API_MAX_LIMIT]; default API_DEFAULT_LIMIT.
 * - `offset` — integer ≥ 0; default 0.
 *
 * Duplicate params are rejected — ambiguous input is a client bug.
 */
export const parseListQuery = (params: URLSearchParams): ParseResult<ParsedListQuery> => {
	const allowed = new Set(["filter", "sort", "limit", "offset"]);
	const seen = new Map<string, string>();
	for (const [name, value] of params) {
		if (!allowed.has(name)) {
			return fail(badRequest(`unknown query parameter "${name}"`));
		}
		if (seen.has(name)) {
			return fail(badRequest(`duplicate query parameter "${name}"`));
		}
		seen.set(name, value);
	}

	let filter: DocumentFilter | undefined;
	const rawFilter = seen.get("filter");
	if (rawFilter !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawFilter);
		} catch {
			return fail(badRequest("filter must be a JSON object"));
		}
		if (!isPlainObject(parsed)) {
			return fail(badRequest("filter must be a JSON object"));
		}
		const issues = validateFilter(parsed);
		if (issues.length > 0) {
			return fail(badRequest("invalid filter", issues));
		}
		filter = parsed as DocumentFilter;
	}

	let sort: readonly SortTerm[] | undefined;
	const rawSort = seen.get("sort");
	if (rawSort !== undefined) {
		const parsedSort = parseSort(rawSort);
		if (!parsedSort.ok) return parsedSort;
		if (parsedSort.value.length > 0) sort = parsedSort.value;
	}

	let limit = API_DEFAULT_LIMIT;
	const rawLimit = seen.get("limit");
	if (rawLimit !== undefined) {
		const parsedLimit = parseInteger(rawLimit, "limit");
		if (parsedLimit instanceof ApiError) return fail(parsedLimit);
		if (parsedLimit < 1 || parsedLimit > API_MAX_LIMIT) {
			return fail(badRequest(`limit must be an integer in [1, ${API_MAX_LIMIT}]`));
		}
		limit = parsedLimit;
	}

	let offset = 0;
	const rawOffset = seen.get("offset");
	if (rawOffset !== undefined) {
		const parsedOffset = parseInteger(rawOffset, "offset");
		if (parsedOffset instanceof ApiError) return fail(parsedOffset);
		if (parsedOffset < 0) {
			return fail(badRequest("offset must be an integer ≥ 0"));
		}
		offset = parsedOffset;
	}

	return ok({
		query: {
			...(filter === undefined ? {} : { filter }),
			...(sort === undefined ? {} : { sort }),
			limit,
			offset,
		},
		limit,
		offset,
	});
};

// ---------- method mapping ----------

/** HTTP method + path shape → the exposure `methods` entry it needs.
 * Returns null for method/path combos that are never valid (POST or
 * PATCH/DELETE on the wrong path shape). */
export const methodFor = (
	method: string,
	id: number | null,
): { readonly method: ApiMethod; readonly needsId: boolean } | null => {
	switch (method) {
		case "GET":
			return id === null ? { method: "list", needsId: false } : { method: "get", needsId: true };
		case "POST":
			return id === null ? { method: "create", needsId: false } : null;
		case "PATCH":
			return id === null ? null : { method: "update", needsId: true };
		case "DELETE":
			return id === null ? null : { method: "delete", needsId: true };
		default:
			return null;
	}
};
