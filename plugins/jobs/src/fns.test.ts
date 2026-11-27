import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	serverFnRequestHeaders,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { makeEventBus } from "@effect-server-utils/cqrs";
import { Auth } from "@ktb/auth";
import { Forbidden } from "@ktb/authz";
import {
	attachAudioRecord,
	ConsultationsLive,
	completeAudioJob,
	createConsultation,
	failAudioJob,
} from "@ktb/consultations";
import { consultations } from "@ktb/db/schema";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { PatientsCommandsLive, PatientsQueriesLive } from "@ktb/patients";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import type { JobsEnqueuer } from "@ktb/server-fns";

import { retryAudioJobFn } from "./fns.ts";

// Same in-plugin harness as api-jobs.test.ts: the fn reaches the app
// runtime through @ktb/server-fns, so the test publishes its own
// ManagedRuntime — stub Auth over an in-memory D1 + the real
// ConsultationsLive. runAs binds the request Principal (userId +
// email) for the duration of the effect.
const DDL = `
INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ('u-admin', 'Admin Ops', 'platform-admin@ktb.test', 0, NULL, 0, 0);
INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ('u-ops', 'Dra Ops', 'ops-user@x.com', 0, NULL, 0, 0);
`;

const USERS = new Map([
	["admin", { id: "u-admin", email: "platform-admin@ktb.test", name: "Admin Ops" }],
	["user", { id: "u-ops", email: "ops-user@x.com", name: "Dra Ops" }],
]);

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

// Wraps the real gate so a test can deny a specific requireAdmin call —
// the retry fn's phase-2 re-check must swallow a Forbidden the same way
// the phase-1 read does.
const baseAdminGate = makePlatformAdminGate(parsePlatformAdminEmails("platform-admin@ktb.test"));
let adminRequireCalls = 0;
let forbidAdminCallAt: number | null = null;
const gatedAdmin: PlatformAdmin["Service"] = {
	isAdmin: baseAdminGate.isAdmin,
	requireAdmin: () => {
		adminRequireCalls += 1;
		return forbidAdminCallAt !== null && adminRequireCalls >= forbidAdminCallAt
			? Effect.fail(new Forbidden({ path: "platform.admin" }))
			: baseAdminGate.requireAdmin();
	},
};

const infra = Layer.mergeAll(
	Layer.succeed(Db, db),
	Layer.succeed(Auth, authStub),
	Layer.succeed(PlatformAdmin, gatedAdmin),
	makeEventBus(),
);

const patientsHandlers = Layer.mergeAll(PatientsQueriesLive, PatientsCommandsLive).pipe(
	Layer.provide(infra),
);

const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		infra,
		patientsHandlers,
		ConsultationsLive.pipe(Layer.provide(Layer.mergeAll(infra, patientsHandlers))),
	) as Layer.Layer<unknown, never, never>,
);

const sent: { kind: string; payload: unknown; options?: unknown }[] = [];
let queueFails = false;
const jobs: JobsEnqueuer = {
	enqueue: (kind, payload, options) => {
		if (queueFails) return Promise.reject(new Error("queue down"));
		sent.push({ kind, payload, options });
		return Promise.resolve({});
	},
};

beforeAll(() => {
	installServerFnRuntime(runtime, authStub, { jobs });
});

afterAll(async () => {
	resetServerFnRuntime();
	await runtime.dispose();
});

const useSession = (key: string | null) => {
	serverFnRequestHeaders.current =
		key === null ? new Headers() : new Headers({ cookie: `session=${key}` });
};

const audioStatusOf = async (id: number) =>
	(
		await db.query.consultations.findFirst({
			where: (t, { eq }) => eq(t.id, id),
		})
	)?.audioStatus;

describe("retryAudioJobFn", () => {
	it("rejects anonymous callers", async () => {
		useSession(null);
		await expect(retryAudioJobFn({ data: { consultationId: 1 } })).rejects.toThrow(
			"unauthenticated",
		);
	});

	it("denies non-admin principals", async () => {
		useSession("user");
		const res = await retryAudioJobFn({ data: { consultationId: 1 } });
		expect(res).toEqual({ ok: false, reason: "not-found" });
	});

	it("reports not-found for a missing consultation and a row without audio", async () => {
		useSession("admin");
		expect(await retryAudioJobFn({ data: { consultationId: 424242 } })).toEqual({
			ok: false,
			reason: "not-found",
		});
		const noAudio = (await createConsultation(db, {
			userId: "u-ops",
			source: "browser",
		}))!;
		expect(await retryAudioJobFn({ data: { consultationId: noAudio } })).toEqual({
			ok: false,
			reason: "not-found",
		});
	});

	it("refuses non-retryable statuses", async () => {
		useSession("admin");
		const id = (await createConsultation(db, {
			userId: "u-ops",
			source: "browser",
		}))!;
		await attachAudioRecord(db, id, { audioKey: "k-done", size: 1 });
		await completeAudioJob(db, id, "done transcript");
		expect(await retryAudioJobFn({ data: { consultationId: id } })).toEqual({
			ok: false,
			reason: "not-retryable",
		});
	});

	it("re-enqueues a failed job with tenant propagation and flips it to queued", async () => {
		useSession("admin");
		const id = (await createConsultation(db, { userId: "u-ops", source: "browser" }, 7))!;
		await attachAudioRecord(db, id, { audioKey: "k-retry", size: 10 });
		await failAudioJob(db, id, "transcription failed: boom");
		const before = sent.length;
		const res = await retryAudioJobFn({ data: { consultationId: id } });
		expect(res).toEqual({ ok: true });
		expect(sent.length).toBe(before + 1);
		expect(sent.at(-1)).toEqual({
			kind: "transcription.audio",
			payload: {
				consultationId: id,
				audioKey: "k-retry",
				userId: "u-ops",
				tenantId: 7,
			},
			options: { tenantId: 7, payloadRef: `consultation:${id}` },
		});
		expect(await audioStatusOf(id)).toBe("queued");
	});

	it("re-enqueues a stored job (upload landed, enqueue previously failed)", async () => {
		useSession("admin");
		const id = (await createConsultation(db, {
			userId: "u-ops",
			source: "browser",
		}))!;
		await attachAudioRecord(db, id, { audioKey: "k-stored", size: 5 });
		const res = await retryAudioJobFn({ data: { consultationId: id } });
		expect(res).toEqual({ ok: true });
		expect(sent.at(-1)).toMatchObject({
			kind: "transcription.audio",
			payload: { consultationId: id, audioKey: "k-stored" },
		});
		expect(await audioStatusOf(id)).toBe("queued");
	});

	it("reports unavailable when the queue binding is missing", async () => {
		useSession("admin");
		const id = (await createConsultation(db, {
			userId: "u-ops",
			source: "browser",
		}))!;
		await attachAudioRecord(db, id, { audioKey: "k-noqueue", size: 1 });
		await failAudioJob(db, id, "boom");
		// Swap the registry entry for a runtime without the jobs port.
		installServerFnRuntime(runtime, authStub);
		try {
			expect(await retryAudioJobFn({ data: { consultationId: id } })).toEqual({
				ok: false,
				reason: "unavailable",
			});
			expect(await audioStatusOf(id)).toBe("failed");
		} finally {
			installServerFnRuntime(runtime, authStub, { jobs });
		}
	});

	it("sends an empty userId fallback for legacy rows without an owner", async () => {
		useSession("admin");
		const [row] = await db
			.insert(consultations)
			.values({
				userId: null,
				transcript: "",
				source: "browser",
				status: "done",
				createdAt: new Date(),
			})
			.returning({ id: consultations.id });
		const id = row!.id;
		await attachAudioRecord(db, id, { audioKey: "k-legacy", size: 1 });
		await failAudioJob(db, id, "boom");
		const res = await retryAudioJobFn({ data: { consultationId: id } });
		expect(res).toEqual({ ok: true });
		expect(sent.at(-1)).toMatchObject({
			kind: "transcription.audio",
			payload: { consultationId: id, userId: "" },
		});
	});

	it("still reports ok when the phase-2 admin re-check is denied", async () => {
		useSession("admin");
		const id = (await createConsultation(db, {
			userId: "u-ops",
			source: "browser",
		}))!;
		await attachAudioRecord(db, id, { audioKey: "k-phase2", size: 1 });
		await failAudioJob(db, id, "boom");
		// adminAudioJob's requireAdmin is call 1 (passes); adminRequeueAudio's
		// is call 2 (denied) — the fn swallows it like the phase-1 read.
		adminRequireCalls = 0;
		forbidAdminCallAt = 2;
		try {
			expect(await retryAudioJobFn({ data: { consultationId: id } })).toEqual({
				ok: true,
			});
			// The requeue never ran — the row keeps its failed status.
			expect(await audioStatusOf(id)).toBe("failed");
		} finally {
			forbidAdminCallAt = null;
		}
	});

	it("reports enqueue-failed and keeps the failed status when send() rejects", async () => {
		useSession("admin");
		const id = (await createConsultation(db, {
			userId: "u-ops",
			source: "browser",
		}))!;
		await attachAudioRecord(db, id, { audioKey: "k-queuefail", size: 1 });
		await failAudioJob(db, id, "boom");
		queueFails = true;
		try {
			expect(await retryAudioJobFn({ data: { consultationId: id } })).toEqual({
				ok: false,
				reason: "enqueue-failed",
			});
			expect(await audioStatusOf(id)).toBe("failed");
		} finally {
			queueFails = false;
		}
	});
});
