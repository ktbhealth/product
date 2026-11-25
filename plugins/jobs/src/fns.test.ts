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
import { makeD1 } from "@ktb/db/testing";
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
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO "user" VALUES ('u-admin', 'Admin Ops', 'platform-admin@ktb.test', 0, NULL, 0, 0);
INSERT INTO "user" VALUES ('u-ops', 'Dra Ops', 'ops-user@x.com', 0, NULL, 0, 0);
CREATE TABLE patients (synthetic INTEGER NOT NULL DEFAULT 0, id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL REFERENCES "user"(id), name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, social_name TEXT, gender TEXT, birth_date TEXT, phone TEXT, email TEXT, preferred_language TEXT, address_line TEXT, address_number TEXT, address_complement TEXT, district TEXT, city TEXT, state TEXT, postal_code TEXT, country TEXT, mother_name TEXT, marital_status TEXT, race_color TEXT, nationality TEXT, emergency_contact_name TEXT, emergency_contact_relationship TEXT, emergency_contact_phone TEXT, created_at INTEGER, updated_at INTEGER, tenant_id INTEGER);
CREATE TABLE patient_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, type TEXT NOT NULL, country TEXT, number TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, UNIQUE (patient_id, type));
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
CREATE INDEX relation_tuples_object_idx ON relation_tuples (object_type, object_id, relation);
CREATE INDEX relation_tuples_subject_idx ON relation_tuples (subject_kind, subject_id);
CREATE INDEX relation_tuples_natural_idx ON relation_tuples (object_type, object_id, relation, subject_kind, subject_id);
CREATE TABLE consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES "user"(id), patient_id INTEGER REFERENCES patients(id), transcript TEXT NOT NULL, anamnesis TEXT, review TEXT, engine TEXT, source TEXT NOT NULL, status TEXT NOT NULL, bot_id TEXT, consent_at INTEGER, audio_key TEXT, audio_status TEXT NOT NULL DEFAULT 'none', audio_content_type TEXT, audio_size INTEGER, audio_error TEXT, server_transcript TEXT, corrected_transcript TEXT, enhancement_engine TEXT, anamnesis_hash TEXT, anamnesis_version INTEGER, blob_hash TEXT, synthetic INTEGER NOT NULL DEFAULT 0, eval_item_id INTEGER, created_at INTEGER NOT NULL, tenant_id INTEGER, transcript_reviewed_at INTEGER, transcript_reviewed_by TEXT, anamnesis_reviewed_at INTEGER, anamnesis_reviewed_by TEXT, anamnesis_reviewed_version INTEGER, transcript_segments TEXT,
		transcript_edits TEXT,
		transcript_edits_base TEXT,
		transcript_reviewed_edits INTEGER,
		deferred_until INTEGER);
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

const db = makeDb(makeD1(DDL));

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
