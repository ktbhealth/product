import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartServerMock,
	serverFnRequestHeaders,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { makeEventBus } from "@effect-server-utils/cqrs";
import { Auth } from "@ktb/auth";
import { attachAudioRecord, ConsultationsLive, createConsultation } from "@ktb/consultations";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { PatientsCommandsLive, PatientsQueriesLive } from "@ktb/patients";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";

import { Route as JobsRoute } from "./api-routes/jobs.ts";

const handlersOf = (r: unknown) =>
	(
		r as {
			options: {
				server: { handlers: Record<string, (a: never) => Promise<Response>> };
			};
		}
	).options.server.handlers;

const get = () =>
	handlersOf(JobsRoute).GET!({
		request: new Request("http://x/api/jobs"),
	} as never);

// In-plugin harness (P-033): the route reaches the app runtime through
// @ktb/server-fns, so the test publishes its own ManagedRuntime — a
// stub Auth port (cookie → session, no better-auth) over an in-memory
// D1 + the real ConsultationsLive (with the patients CQRS handlers it
// dispatches, same wiring as plugins/consultations tests). runAs
// mirrors @ktb/app-host: it binds the request Principal (userId +
// email — PlatformAdmin.requireAdmin reads the email) for the
// duration of the effect.
const DDL = `
INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ('u-admin', 'Admin Jobs', 'platform-admin@ktb.test', 0, NULL, 0, 0);
INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ('u-jobs', 'Dra Jobs', 'jobs-user@x.com', 0, NULL, 0, 0);
`;

const USERS = new Map([
	["admin", { id: "u-admin", email: "platform-admin@ktb.test", name: "Admin Jobs" }],
	["user", { id: "u-jobs", email: "jobs-user@x.com", name: "Dra Jobs" }],
]);

/** Mutable enable-state behind the route gate (createPluginApiRoute). */
const pluginGate = { enabled: true };

/** Cookie "session=<key>" authenticates as USERS[key]; anything else is anonymous. */
const authStub = Auth.of({
	setUserBanned: async () => {},
	updateUser: async () => ({ ok: true as const }),
	deleteUser: async () => {},
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
});

const db = makeDb(makeTestD1(DDL));

const infra = Layer.mergeAll(
	Layer.succeed(Db, db),
	Layer.succeed(Auth, authStub),
	Layer.succeed(
		PlatformAdmin,
		makePlatformAdminGate(parsePlatformAdminEmails("platform-admin@ktb.test")),
	),
	makeEventBus(),
);

// ConsultationsLive dispatches `patients.ownerOf` / `patients.delete` —
// register the real handlers against the test db (same impls the
// patients plugin ships).
const patientsHandlers = Layer.mergeAll(PatientsQueriesLive, PatientsCommandsLive).pipe(
	Layer.provide(infra),
);

// The runtime must re-export the infra services too: getSessionUser
// resolves Auth through `run`, and runAs effects reach PlatformAdmin /
// Consultations — not just the top-level service layer's output.
const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		infra,
		patientsHandlers,
		ConsultationsLive.pipe(Layer.provide(Layer.mergeAll(infra, patientsHandlers))),
	) as Layer.Layer<unknown, never, never>,
);

beforeAll(() => {
	installServerFnRuntime(runtime, authStub, {
		pluginEnabled: async () => pluginGate.enabled,
	});
});

interface Session {
	readonly cookie: string;
	readonly userId: string;
}

const sessions = new Map<string, Session>();

/** "Sign in" — resolves the stub session for an email's cookie key. */
function signIn(key: string): Session {
	const cached = sessions.get(key);
	if (cached) return cached;
	const user = USERS.get(key)!;
	const session = { cookie: `session=${key}`, userId: user.id };
	sessions.set(key, session);
	return session;
}

const useSession = (session: Session) => {
	serverFnRequestHeaders.current = new Headers({ cookie: session.cookie });
};

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

describe("GET /api/jobs", () => {
	it("answers 404 when the jobs.routes plugin is disabled", async () => {
		pluginGate.enabled = false;
		try {
			useSession(signIn("admin"));
			const res = await get();
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
			const res = await get();
			expect(res.status).toBe(401);
		} finally {
			serverFnRequestHeaders.current = saved;
		}
	});

	it("rejects non-admin sessions", async () => {
		const saved = serverFnRequestHeaders.current;
		useSession(signIn("user"));
		try {
			const res = await get();
			expect(res.status).toBe(403);
		} finally {
			serverFnRequestHeaders.current = saved;
		}
	});

	it("streams the audio-job projection as SSE frames for admins", async () => {
		const { userId } = signIn("admin");
		useSession(signIn("admin"));
		const id = (await createConsultation(db, { userId, source: "browser" }))!;
		await attachAudioRecord(db, id, {
			audioKey: `audio/${userId}/${id}/a.webm`,
			size: 3,
		});

		const res = await get();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.body).toBeTruthy();

		const buf = await readUntil(res.body!, `"id":${id},"audioStatus"`);
		expect(buf).toContain("data: ");
		expect(buf).toContain(`"audioStatus":"stored"`);
		expect(buf).toContain(": hb");
	});
});
