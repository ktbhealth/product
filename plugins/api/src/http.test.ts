import { describe, expect, it } from "vitest";

import type { DocumentRecord } from "@ktb/document-store";

import {
	API_DEFAULT_LIMIT,
	API_MAX_BODY_BYTES,
	API_MAX_LIMIT,
	ApiError,
	apiError,
	badRequest,
	errorEnvelope,
	jsonResponse,
	methodFor,
	notFound,
	parseDocumentsPath,
	parseListQuery,
	recordToJson,
	toErrorResponse,
} from "./http.ts";

describe("ApiError helpers", () => {
	it("apiError omits empty issues", () => {
		const e = apiError(400, "bad_request", "nope", []);
		expect(e.status).toBe(400);
		expect(e.kind).toBe("bad_request");
		expect(e.issues).toBeUndefined();
	});

	it("badRequest/notFound build typed errors", () => {
		expect(badRequest("x", ["i"]).issues).toEqual(["i"]);
		expect(notFound().status).toBe(404);
	});

	it("errorEnvelope carries kind/message/issues", () => {
		expect(errorEnvelope(apiError(422, "k", "m", ["a"]))).toEqual({
			error: { kind: "k", message: "m", issues: ["a"] },
		});
		expect(errorEnvelope(apiError(500, "k", "m"))).toEqual({
			error: { kind: "k", message: "m" },
		});
	});

	it("toErrorResponse maps ApiError to its status and unknowns to 500", async () => {
		const api = toErrorResponse(apiError(403, "forbidden", "denied"));
		expect(api.status).toBe(403);
		expect(await api.json()).toEqual({ error: { kind: "forbidden", message: "denied" } });

		const other = toErrorResponse(new Error("boom"));
		expect(other.status).toBe(500);
		expect(await other.json()).toEqual({
			error: { kind: "internal", message: "internal error" },
		});
	});

	it("jsonResponse serializes the body", async () => {
		const res = jsonResponse({ a: 1 }, 201);
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ a: 1 });
	});
});

describe("recordToJson", () => {
	it("serializes dates to ISO strings", () => {
		const record = {
			id: 7,
			collectionId: 2,
			collection: "notes",
			data: { title: "hi" },
			ownerId: "u1",
			tenantId: null,
			createdAt: new Date("2024-01-02T03:04:05.000Z"),
			updatedAt: new Date("2024-02-03T04:05:06.000Z"),
		} as unknown as DocumentRecord;
		expect(recordToJson(record)).toEqual({
			id: 7,
			collection: "notes",
			data: { title: "hi" },
			ownerId: "u1",
			tenantId: null,
			createdAt: "2024-01-02T03:04:05.000Z",
			updatedAt: "2024-02-03T04:05:06.000Z",
		});
	});
});

describe("parseDocumentsPath", () => {
	it("parses collection and record paths", () => {
		expect(parseDocumentsPath("/api/documents/notes")).toEqual({ key: "notes", id: null });
		expect(parseDocumentsPath("/api/documents/notes/42")).toEqual({ key: "notes", id: 42 });
		expect(parseDocumentsPath("/api/documents/test.notes/7")).toEqual({
			key: "test.notes",
			id: 7,
		});
	});

	it("tolerates trailing slashes", () => {
		expect(parseDocumentsPath("/api/documents/notes/")).toEqual({ key: "notes", id: null });
		expect(parseDocumentsPath("/api/documents/notes/42/")).toEqual({ key: "notes", id: 42 });
	});

	it("decodes percent-encoded segments", () => {
		expect(parseDocumentsPath("/api/documents/%6Eotes")).toEqual({ key: "notes", id: null });
	});

	it("rejects paths outside the subtree", () => {
		for (const path of [
			"/api/other/notes",
			"/api/documents",
			"/api/documents/",
			"/documents/notes",
			"",
		]) {
			expect(parseDocumentsPath(path)).toBeNull();
		}
	});

	it("rejects malformed percent-encoding", () => {
		expect(parseDocumentsPath("/api/documents/%zz")).toBeNull();
		expect(parseDocumentsPath("/api/documents/ok/%e0%a4")).toBeNull();
	});

	it("rejects bad keys", () => {
		for (const path of [
			"/api/documents/Notes",
			"/api/documents/_x",
			"/api/documents/a b",
			"/api/documents/a%20b",
		]) {
			expect(parseDocumentsPath(path)).toBeNull();
		}
	});

	it("rejects extra segments", () => {
		expect(parseDocumentsPath("/api/documents/a/b/c")).toBeNull();
	});

	it("rejects bad ids", () => {
		for (const path of [
			"/api/documents/n/abc",
			"/api/documents/n/0",
			"/api/documents/n/-1",
			"/api/documents/n/1.5",
			"/api/documents/n/99999999999999999999",
		]) {
			expect(parseDocumentsPath(path)).toBeNull();
		}
	});
});

describe("parseListQuery", () => {
	const parse = (qs: string) => parseListQuery(new URLSearchParams(qs));

	it("defaults limit/offset with no params", () => {
		const res = parse("");
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.value.limit).toBe(API_DEFAULT_LIMIT);
			expect(res.value.offset).toBe(0);
			expect(res.value.query).toEqual({ limit: API_DEFAULT_LIMIT, offset: 0 });
		}
	});

	it("parses filter JSON with operators", () => {
		const res = parse(
			`filter=${encodeURIComponent('{"status":{"$eq":"active"},"$or":[{"a":1}]}')}`,
		);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.value.query.filter).toEqual({
				status: { $eq: "active" },
				$or: [{ a: 1 }],
			});
		}
	});

	it("parses sort with -desc shorthand", () => {
		const res = parse("sort=-createdAt,title");
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.value.query.sort).toEqual([
				{ field: "createdAt", dir: "desc" },
				{ field: "title", dir: "asc" },
			]);
		}
	});

	it("skips empty sort pieces and bare sort yields no sort", () => {
		const res = parse("sort=a,,b");
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.value.query.sort).toEqual([
				{ field: "a", dir: "asc" },
				{ field: "b", dir: "asc" },
			]);
		}
		const empty = parse("sort=,,");
		expect(empty.ok).toBe(true);
		if (empty.ok) expect(empty.value.query.sort).toBeUndefined();
	});

	it("parses limit and offset", () => {
		const res = parse(`limit=${API_MAX_LIMIT}&offset=40`);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.value.limit).toBe(API_MAX_LIMIT);
			expect(res.value.offset).toBe(40);
		}
	});

	it("rejects unknown and duplicate params", () => {
		const unknown = parse("bogus=1");
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.status).toBe(400);

		const params = new URLSearchParams();
		params.append("limit", "1");
		params.append("limit", "2");
		const res = parseListQuery(params);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.message).toContain("duplicate");
	});

	it("rejects malformed filter JSON and non-objects", () => {
		for (const raw of ["{bad", "[1,2]", '"str"', "5", "null"]) {
			const res = parse(`filter=${encodeURIComponent(raw)}`);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error.status).toBe(400);
		}
	});

	it("rejects filters failing validateFilter", () => {
		const res = parse(`filter=${encodeURIComponent('{"f":{"$bogus":1}}')}`);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.status).toBe(400);
			expect(res.error.issues?.[0]).toContain("unknown operator");
		}
	});

	it("rejects a bare '-' sort term", () => {
		const res = parse("sort=-");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.message).toContain("sort");
	});

	it("rejects malformed limit/offset", () => {
		for (const qs of [
			"limit=abc",
			"limit=1.5",
			"limit=0",
			`limit=${API_MAX_LIMIT + 1}`,
			"limit=-3",
			"limit=99999999999999999999",
			"offset=-1",
			"offset=xyz",
			"offset=1.2",
		]) {
			const res = parse(qs);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error.status).toBe(400);
		}
	});
});

describe("methodFor", () => {
	it("maps method+path shape to exposure methods", () => {
		expect(methodFor("GET", null)).toEqual({ method: "list", needsId: false });
		expect(methodFor("GET", 3)).toEqual({ method: "get", needsId: true });
		expect(methodFor("POST", null)).toEqual({ method: "create", needsId: false });
		expect(methodFor("PATCH", 3)).toEqual({ method: "update", needsId: true });
		expect(methodFor("DELETE", 3)).toEqual({ method: "delete", needsId: true });
	});

	it("rejects invalid method/path combos", () => {
		for (const [m, id] of [
			["POST", 3],
			["PATCH", null],
			["DELETE", null],
			["PUT", null],
			["HEAD", 3],
		] as const) {
			expect(methodFor(m, id)).toBeNull();
		}
	});
});

describe("constants", () => {
	it("exposes the documented bounds", () => {
		expect(API_MAX_LIMIT).toBe(200);
		expect(API_DEFAULT_LIMIT).toBe(50);
		expect(API_MAX_BODY_BYTES).toBe(256 * 1024);
	});

	it("ApiError is a Data.TaggedError", () => {
		const e = new ApiError({ status: 1, kind: "k", message: "m" });
		expect(e._tag).toBe("ApiError");
		expect(e).toBeInstanceOf(Error);
	});
});
