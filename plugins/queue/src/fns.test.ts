import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	serverFnRequestHeaders,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden } from "@ktb/authz";

import { QueueAdmin, type EnqueueJobResult } from "./admin.ts";
import { enqueueJobFn } from "./fns.ts";

let currentEmail: string | null = "admin@x.com";
let enqueueResult: EnqueueJobResult = { ok: true };
let denyEnqueue = false;
const enqueued: { kind: string; payload: unknown }[] = [];

const adminStub = QueueAdmin.of({
	queues: () => Effect.succeed(null),
	jobRuns: () => Effect.succeed([]),
	kinds: () => Effect.succeed(["jobs.ping"]),
	enqueue: (kind, payload) => {
		enqueued.push({ kind, payload });
		return denyEnqueue
			? Effect.fail(new Forbidden({ path: "queue.enqueue" }))
			: Effect.succeed(enqueueResult);
	},
});

const runtime = ManagedRuntime.make(Layer.succeed(QueueAdmin, adminStub));

beforeAll(() => {
	installServerFnRuntime(
		runtime,
		stubAuth(() => sessionUser(currentEmail)),
	);
});

afterAll(async () => {
	resetServerFnRuntime();
	await runtime.dispose();
});

const useSession = (email: string | null) => {
	currentEmail = email;
	serverFnRequestHeaders.current =
		email === null ? new Headers() : new Headers({ cookie: `session=id-${email}` });
};

describe("enqueueJobFn", () => {
	it("enqueues a kind with its payload for admins", async () => {
		useSession("admin@x.com");
		enqueueResult = { ok: true };
		const res = await enqueueJobFn({ data: { kind: "jobs.ping", payload: { a: 1 } } });
		expect(res).toEqual({ ok: true });
		expect(enqueued.at(-1)).toEqual({ kind: "jobs.ping", payload: { a: 1 } });
	});

	it("defaults the payload to undefined passthrough", async () => {
		useSession("admin@x.com");
		const res = await enqueueJobFn({ data: { kind: "jobs.ping" } });
		expect(res).toEqual({ ok: true });
	});

	it("collapses a Forbidden service failure into a forbidden result", async () => {
		useSession("admin@x.com");
		denyEnqueue = true;
		try {
			const res = await enqueueJobFn({ data: { kind: "jobs.ping" } });
			expect(res).toEqual({ ok: false, reason: "forbidden" });
		} finally {
			denyEnqueue = false;
		}
	});

	it("rejects anonymous sessions", async () => {
		useSession(null);
		await expect(enqueueJobFn({ data: { kind: "jobs.ping" } })).rejects.toThrow();
	});

	it("rejects an empty kind at the schema boundary", async () => {
		useSession("admin@x.com");
		await expect(enqueueJobFn({ data: { kind: "" } })).rejects.toThrow();
	});
});
