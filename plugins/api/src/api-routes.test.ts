import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Auth } from "@ktb/auth";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	defineCollection,
	DOCUMENT_STORE_TEST_DDL,
	DocumentCollections,
	DocumentStoreLive,
	f,
} from "@ktb/document-store";
import { Permissions } from "@ktb/rbac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { installServerFnRuntime } from "@ktb/server-fns/testing";

import { Route as DocumentsRoute } from "./api-routes/documents.ts";
import { Route as SplatRoute } from "./api-routes/documents.$.ts";
import { ApiExposures, type ApiExposure } from "./exposure.ts";
import { ApiLive } from "./service.ts";

/**
 * HTTP-surface tests: the splat route end to end — path parsing, body
 * limits, session lookup, run/runAs boundary and the error envelope —
 * over a real DocumentStoreLive on in-memory D1 (same harness shape as
 * plugins/theme api-routes.test.ts).
 */

const GROUPS_DDL = `
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL DEFAULT ''
);
INSERT INTO groups (id, name) VALUES (1, 'clinic-a');
`;

const notes = defineCollection({
	name: "test.notes",
	fields: {
		title: f.string({ required: true, maxLength: 50 }),
		count: f.number(),
	},
});

const DEFS = [notes];

const ALL_METHODS = ["list", "get", "create", "update", "delete"] as const;

const EXPOSURES: readonly ApiExposure[] = [
	{ collection: "test.notes", methods: ALL_METHODS },
	{ collection: "test.notes", basePath: "/api/documents/public-notes", public: true },
	{
		collection: "test.notes",
		basePath: "/api/documents/perm-notes",
		permission: "notes.all",
		methods: ALL_METHODS,
	},
];

const USERS = new Map([["doc", { id: "u-doc", email: "doc@x.com", name: "Doc" }]]);

/** Cookie "session=<key>" authenticates as USERS[key]; else anonymous. */
const authStub = Auth.of({
	setUserBanned: async () => {},
	getSession: async (h: Headers) => {
		const key = /session=([^;]+)/.exec(h.get("cookie") ?? "")?.[1];
		const user = key ? USERS.get(key) : undefined;
		if (!user) return null;
		return {
			user,
			sessionId: `sess-${key}`,
			expiresAt: new Date(Date.now() + 3_600_000),
		};
	},
} as never);

let grantsAllow = true;
const permissionsStub = Permissions.of({
	can: () => Effect.succeed(grantsAllow),
} as never);

const db = makeDb(makeD1(GROUPS_DDL + DOCUMENT_STORE_TEST_DDL));

const storeDeps = Layer.mergeAll(
	Layer.succeed(Db, db),
	Layer.succeed(DocumentCollections, { collections: DEFS }),
);
const documentStore = DocumentStoreLive.pipe(Layer.provide(storeDeps));
const apiDeps = Layer.mergeAll(
	documentStore,
	Layer.succeed(ApiExposures, { exposures: EXPOSURES }),
	Layer.succeed(Permissions, permissionsStub),
	Layer.succeed(Auth, authStub),
);
const runtime = ManagedRuntime.make(Layer.mergeAll(ApiLive.pipe(Layer.provide(apiDeps)), apiDeps));

const handlersOf = (r: unknown) =>
	(
		r as {
			options: {
				server: { handlers: Record<string, (a: never) => Promise<Response>> };
			};
		}
	).options.server.handlers;

const splatHandlers = handlersOf(SplatRoute);
const rootHandlers = handlersOf(DocumentsRoute);

const call = (
	handlers: Record<string, (a: never) => Promise<Response>>,
	method: string,
	path: string,
	init: { body?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
) => {
	const headers = new Headers(init.headers ?? {});
	let body: BodyInit | undefined;
	if (init.rawBody !== undefined) body = init.rawBody;
	else if (init.body !== undefined) {
		body = JSON.stringify(init.body);
		headers.set("content-type", "application/json");
	}
	const request = new Request(`http://test.local${path}`, { method, headers, body });
	const handler = handlers[method];
	if (handler === undefined) throw new Error(`no ${method} handler`);
	return handler({ request, params: {} } as never);
};

const authed = { cookie: "session=doc" };

beforeAll(() => {
	// Principal is what DocumentStore fencing + the Api permission gate
	// read — installServerFnRuntime's runAs binds it like app-host's.
	installServerFnRuntime(runtime, authStub, { pluginEnabled: async () => true });
});

afterAll(async () => {
	await runtime.dispose();
});

describe("api documents splat route", () => {
	it("serves anonymous public list/get", async () => {
		const res = await call(splatHandlers, "GET", "/api/documents/public-notes");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { rows: unknown[]; total: number; limit: number };
		expect(body.limit).toBe(50);

		const missing = await call(splatHandlers, "GET", "/api/documents/public-notes/999");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ error: { kind: "not_found" } });
	});

	it("401s anonymous calls on non-public exposures", async () => {
		const res = await call(splatHandlers, "GET", "/api/documents/test.notes");
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: { kind: "unauthenticated" } });
	});

	it("runs authenticated CRUD under the session principal", async () => {
		const created = await call(splatHandlers, "POST", "/api/documents/test.notes", {
			body: { title: "via http", count: 3 },
			headers: authed,
		});
		expect(created.status).toBe(201);
		const record = (await created.json()) as { id: number; data: { title: string } };
		expect(record.data.title).toBe("via http");

		const got = await call(splatHandlers, "GET", `/api/documents/test.notes/${record.id}`, {
			// Tenant selector header exercises the runAs selector branch.
			headers: { ...authed, "x-tenant-id": "1" },
		});
		expect(got.status).toBe(200);

		const patched = await call(splatHandlers, "PATCH", `/api/documents/test.notes/${record.id}`, {
			body: { count: 4 },
			headers: authed,
		});
		expect(patched.status).toBe(200);
		expect(((await patched.json()) as { data: { count: number } }).data.count).toBe(4);

		const deleted = await call(splatHandlers, "DELETE", `/api/documents/test.notes/${record.id}`, {
			headers: authed,
		});
		expect(deleted.status).toBe(204);
		expect(await deleted.text()).toBe("");
	});

	it("404s methods an exposure does not publish (same as unknown keys)", async () => {
		// public-notes is read-only: POST gets the same 404 an unknown
		// key would — no exposure oracle for anonymous callers.
		const res = await call(splatHandlers, "POST", "/api/documents/public-notes", {
			body: { title: "x" },
			headers: authed,
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: { kind: "not_found" } });
	});

	it("404s unknown keys, unexposed collections and malformed paths", async () => {
		for (const path of [
			"/api/documents/nope",
			"/api/documents/Bad-Key",
			"/api/documents/test.secret",
			"/api/documents/a/b/c",
			"/api/documents/test.notes/abc",
			// Malformed percent-encoding → decodeURIComponent throws → 404.
			"/api/documents/%E0%A4%A",
		]) {
			const res = await call(splatHandlers, "GET", path, { headers: authed });
			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({ error: { kind: "not_found" } });
		}
	});

	it("rejects a missing JSON body with 400", async () => {
		const res = await call(splatHandlers, "POST", "/api/documents/test.notes", {
			headers: authed,
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { kind: "bad_request" } });
	});

	it("rejects bad query params with 400", async () => {
		const res = await call(splatHandlers, "GET", "/api/documents/test.notes?bogus=1", {
			headers: authed,
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { kind: "bad_request" } });
	});

	it("applies filter/sort/limit over HTTP", async () => {
		await call(splatHandlers, "POST", "/api/documents/test.notes", {
			body: { title: "one", count: 1 },
			headers: authed,
		});
		await call(splatHandlers, "POST", "/api/documents/test.notes", {
			body: { title: "two", count: 9 },
			headers: authed,
		});
		const res = await call(
			splatHandlers,
			"GET",
			"/api/documents/test.notes?filter=" +
				encodeURIComponent('{"count":{"$gt":5}}') +
				"&sort=-count&limit=5",
			{ headers: authed },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			rows: { data: { title: string } }[];
			total: number;
			limit: number;
		};
		expect(body.total).toBe(1);
		expect(body.rows[0]?.data.title).toBe("two");
	});

	it("400s on invalid JSON bodies and non-object documents", async () => {
		const bad = await call(splatHandlers, "POST", "/api/documents/test.notes", {
			rawBody: "{not json",
			headers: { ...authed, "content-type": "application/json" },
		});
		expect(bad.status).toBe(400);

		const arr = await call(splatHandlers, "POST", "/api/documents/test.notes", {
			body: [1, 2],
			headers: authed,
		});
		expect(arr.status).toBe(400);
		expect(await arr.json()).toMatchObject({ error: { kind: "bad_request" } });
	});

	it("413s on oversized bodies via content-length and actual bytes", async () => {
		const huge = "x".repeat(300 * 1024);
		const declared = await call(splatHandlers, "POST", "/api/documents/test.notes", {
			rawBody: huge,
			headers: {
				...authed,
				"content-type": "application/json",
				// Explicit oversized content-length → rejected before read.
				"content-length": String(huge.length + 10),
			},
		});
		expect(declared.status).toBe(413);
		expect(await declared.json()).toMatchObject({ error: { kind: "payload_too_large" } });

		// Streamed body: no content-length — the byte check catches it.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(huge));
				controller.close();
			},
		});
		const request = new Request("http://test.local/api/documents/test.notes", {
			method: "POST",
			headers: { ...authed, "content-type": "application/json" },
			body: stream,
			// @ts-expect-error -- undici requires duplex for stream bodies
			duplex: "half",
		});
		const res = await splatHandlers.POST({ request, params: {} } as never);
		expect(res.status).toBe(413);
	});

	it("aborts oversized streamed bodies mid-read without buffering them", async () => {
		// A chunked body with no content-length that NEVER closes: the
		// byte counter must trip the cap after the second chunk and
		// cancel the stream — the handler resolves 413 instead of
		// hanging on the open stream.
		const chunk = new Uint8Array(200 * 1024).fill(0x61);
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(chunk);
				// Intentionally never close.
			},
		});
		const request = new Request("http://test.local/api/documents/test.notes", {
			method: "POST",
			headers: { ...authed, "content-type": "application/json" },
			body: stream,
			// @ts-expect-error -- undici requires duplex for stream bodies
			duplex: "half",
		});
		const res = await splatHandlers.POST({ request, params: {} } as never);
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: { kind: "payload_too_large" } });
		// Two 200KiB chunks exceed the 256KiB cap; a third pull would
		// mean the reader kept consuming past the abort.
		expect(pulls).toBeLessThanOrEqual(3);
	});

	it("maps store validation errors to the envelope", async () => {
		const res = await call(splatHandlers, "POST", "/api/documents/test.notes", {
			body: { count: "not a number" },
			headers: authed,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { issues?: string[] } };
		expect(body.error.issues?.length).toBeGreaterThan(0);
	});

	it("enforces declared permissions over HTTP (403 / allow)", async () => {
		grantsAllow = false;
		const denied = await call(splatHandlers, "GET", "/api/documents/perm-notes", {
			headers: authed,
		});
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ error: { kind: "forbidden" } });

		grantsAllow = true;
		const allowed = await call(splatHandlers, "GET", "/api/documents/perm-notes", {
			headers: authed,
		});
		expect(allowed.status).toBe(200);
	});
});

describe("api documents root route", () => {
	it("404s the bare /api/documents path on every method", async () => {
		for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
			const handler = rootHandlers[method];
			const request = new Request("http://test.local/api/documents", { method });
			const res = await handler({ request, params: {} } as never);
			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({ error: { kind: "not_found" } });
		}
	});
});
