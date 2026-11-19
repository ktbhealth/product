import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartServerMock,
	serverFnRequestHeaders,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());

import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { makeEventBus } from "@effect-server-utils/cqrs";
import { Auth } from "@ktb/auth";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import { insertNotification, NotificationsLive } from "./Notifications.ts";
import { Route as NotificationsRoute } from "./api-routes/notifications.ts";

const handlersOf = (r: unknown) =>
	(
		r as {
			options: {
				server: { handlers: Record<string, (a: never) => Promise<Response>> };
			};
		}
	).options.server.handlers;

// In-plugin harness (P-033): the route reaches the app runtime through
// @ktb/server-fns, so the test publishes its own ManagedRuntime — a
// stub Auth port (cookie → session, no better-auth) over an in-memory
// D1 + the real NotificationsLive. runAs mirrors @ktb/app-host: it
// binds the request Principal for the duration of the effect.
const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO "user" VALUES ('u-sse', 'Dra SSE', 'sse@x.com', 0, NULL, 0, 0);
CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES "user"(id), kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, payload TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
`;

const SESSION_USER = { id: "u-sse", email: "sse@x.com", name: "Dra SSE" };

/** Mutable enable-state behind the route gate (createPluginApiRoute). */
const pluginGate = { enabled: true };

/** Cookie "session=sse" authenticates as SESSION_USER; anything else is anonymous. */
const authStub = Auth.of({
	setUserBanned: async () => {},
	updateUser: async () => ({ ok: true as const }),
	deleteUser: async () => {},
	getSession: async (h: Headers) => {
		const cookie = h.get("cookie") ?? "";
		if (!cookie.includes("session=sse")) return null;
		return {
			user: SESSION_USER,
			sessionId: "sess-sse",
			expiresAt: new Date(Date.now() + 3_600_000),
		};
	},
});

const db = makeDb(makeD1(DDL));

const infra = Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(Auth, authStub), makeEventBus());

// The runtime must re-export the infra services too: getSessionUser
// resolves Auth through `run`, not just the Notifications service.
const runtime = ManagedRuntime.make(
	Layer.mergeAll(infra, NotificationsLive.pipe(Layer.provide(infra))) as Layer.Layer<
		unknown,
		never,
		never
	>,
);

beforeAll(() => {
	installServerFnRuntime(runtime, authStub, {
		pluginEnabled: async () => pluginGate.enabled,
	});
});

/** Read SSE frames until `needle` shows up or the deadline passes. */
async function readUntil(body: ReadableStream<Uint8Array>, needle: string, ms = 8000) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const deadline = Date.now() + ms;
	try {
		while (!buf.includes(needle) && Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return buf;
}

describe("GET /api/notifications", () => {
	it("answers 404 when the notifications.routes plugin is disabled", async () => {
		pluginGate.enabled = false;
		try {
			serverFnRequestHeaders.current = new Headers({ cookie: "session=sse" });
			const h = handlersOf(NotificationsRoute);
			const res = await h.GET!({
				request: new Request("http://x/api/notifications", {
					headers: { cookie: "session=sse" },
				}),
			} as never);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ error: "not found" });
		} finally {
			pluginGate.enabled = true;
		}
	});

	it("rejects unauthenticated requests", async () => {
		const saved = serverFnRequestHeaders.current;
		serverFnRequestHeaders.current = new Headers();
		try {
			const h = handlersOf(NotificationsRoute);
			const res = await h.GET!({
				request: new Request("http://x/api/notifications"),
			} as never);
			expect(res.status).toBe(401);
		} finally {
			serverFnRequestHeaders.current = saved;
		}
	});

	it("streams the persisted backlog as SSE frames plus heartbeats", async () => {
		await insertNotification(db, {
			userId: SESSION_USER.id,
			kind: "test.ping",
			title: "SSE backlog ping",
		});
		serverFnRequestHeaders.current = new Headers({ cookie: "session=sse" });
		const h = handlersOf(NotificationsRoute);
		const res = await h.GET!({
			request: new Request("http://x/api/notifications", {
				headers: { cookie: "session=sse" },
			}),
		} as never);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.body).toBeTruthy();

		const buf = await readUntil(res.body!, "SSE backlog ping");
		expect(buf).toContain("data: ");
		expect(buf).toContain('"title":"SSE backlog ping"');
		expect(buf).toContain('"read":false');
		// Stream.tick emits a heartbeat immediately, then every 25s — the
		// first `: hb` comment should already be in the buffer.
		expect(buf).toContain(": hb");
	});
});
