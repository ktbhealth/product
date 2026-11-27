import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
	installServerFnRuntime,
	reactStartServerMock,
	serverFnRequestHeaders,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { adminAudit, AUDIT_TEST_DDL, AuditLive } from "@ktb/audit";
import { makeEventBus } from "@effect-server-utils/cqrs";
import { Auth } from "@ktb/auth";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { buildPermissions, Permissions } from "@ktb/rbac";
import { fhirR4Exporter } from "@ktb/interop-fhir";
import { openEhrExporter } from "@ktb/interop-openehr";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import {
	PatientsCommandsLive,
	PatientsLive,
	PatientsQueriesLive,
	createPatient,
} from "@ktb/patients";
import { validatePatient } from "@ktb/patients/record";
import { Tenant } from "@ktb/tenant";

import { consultations as consultationsTable } from "@ktb/db/schema";
import { ConsultationsLive, createConsultation } from "./index.ts";
import { Route as AudioRoute } from "./api-routes/consultations.$id.audio.ts";
import { Route as PdfRoute } from "./api-routes/consultations.$id.pdf.ts";
import { Route as ExportRoute } from "./api-routes/patients.$id.export.ts";
import { Route as TranscribeRoute } from "./api-routes/transcribe.ts";

const handlersOf = (r: unknown) =>
	(r as { options: { server: { handlers: Record<string, (a: never) => Promise<Response>> } } })
		.options.server.handlers;

// In-plugin harness (P-033): the routes reach the app runtime through
// @ktb/server-fns, so the test publishes its own ManagedRuntime — a stub
// Auth port (cookie → session) over an in-memory D1 + the real
// PatientsLive/ConsultationsLive. runAs mirrors @ktb/app-host: it binds
// the request Principal for the duration of the effect.
const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO "user" VALUES ('u-owner', 'Dra Export', 'export@x.com', 0, NULL, 0, 0);
INSERT INTO "user" VALUES ('u-other', 'Dra Other', 'other@x.com', 0, NULL, 0, 0);
INSERT INTO "user" VALUES ('u-plain', 'Plain Doc', 'plain@x.com', 0, NULL, 0, 0);
CREATE TABLE patients (synthetic INTEGER NOT NULL DEFAULT 0, id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL REFERENCES "user"(id), name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, social_name TEXT, gender TEXT, birth_date TEXT, phone TEXT, email TEXT, preferred_language TEXT, address_line TEXT, address_number TEXT, address_complement TEXT, district TEXT, city TEXT, state TEXT, postal_code TEXT, country TEXT, mother_name TEXT, marital_status TEXT, race_color TEXT, nationality TEXT, emergency_contact_name TEXT, emergency_contact_relationship TEXT, emergency_contact_phone TEXT, created_at INTEGER, updated_at INTEGER, tenant_id INTEGER);
CREATE TABLE patient_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, type TEXT NOT NULL, country TEXT, number TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, UNIQUE (patient_id, type));
CREATE TABLE consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES "user"(id), patient_id INTEGER REFERENCES patients(id), transcript TEXT NOT NULL, anamnesis TEXT, review TEXT, engine TEXT, source TEXT NOT NULL, status TEXT NOT NULL, bot_id TEXT, consent_at INTEGER, audio_key TEXT, audio_status TEXT NOT NULL DEFAULT 'none', audio_content_type TEXT, audio_size INTEGER, audio_error TEXT, server_transcript TEXT, corrected_transcript TEXT, enhancement_engine TEXT, anamnesis_hash TEXT, anamnesis_version INTEGER, blob_hash TEXT, synthetic INTEGER NOT NULL DEFAULT 0, eval_item_id INTEGER, created_at INTEGER NOT NULL, tenant_id INTEGER, transcript_reviewed_at INTEGER, transcript_reviewed_by TEXT, anamnesis_reviewed_at INTEGER, anamnesis_reviewed_by TEXT, anamnesis_reviewed_version INTEGER, transcript_segments TEXT,
		transcript_edits TEXT,
		transcript_edits_base TEXT,
		transcript_reviewed_edits INTEGER,
		deferred_until INTEGER);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
${AUDIT_TEST_DDL}
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, zk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO groups (id, name, slug, kind, zk) VALUES (9, 'ZK Clinic', 'zk', 'clinic', 1), (10, 'Plain Clinic', 'plain', 'clinic', 0);
`;

/** Mutable enable-state behind the route gate (createPluginApiRoute). */
const pluginGate = { enabled: true };

/** "user" table name column is NOT NULL — unnamed practitioners are
 * modelled by a null SessionUser.name instead (see USERS below). */
const USERS = new Map([
	["owner", { id: "u-owner", email: "export@x.com", name: "Dra Export" }],
	["other", { id: "u-other", email: "other@x.com", name: "Dra Other" }],
	// "plain" has name: null on the session — the practitioner falls back
	// to email in exports (the user row itself keeps a display name).
	["plain", { id: "u-plain", email: "plain@x.com", name: null }],
]);

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

const db = makeDb(makeD1(DDL));

const infra = Layer.mergeAll(
	Layer.succeed(Db, db),
	Layer.succeed(Auth, authStub),
	Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
	Layer.succeed(Permissions, buildPermissions(db)),
	makeEventBus(),
);

// ConsultationsLive dispatches `patients.ownerOf` / `patients.delete` and
// PatientsLive needs PlatformAdmin — same wiring as the app composition.
const patientsHandlers = Layer.mergeAll(PatientsQueriesLive, PatientsCommandsLive).pipe(
	Layer.provide(infra),
);
const services = Layer.mergeAll(
	infra,
	patientsHandlers,
	PatientsLive.pipe(Layer.provide(infra)),
	ConsultationsLive.pipe(Layer.provide(Layer.mergeAll(infra, patientsHandlers))),
	// Real audit service so the sensitive-read emissions (P-086) write
	// admin_audit rows the tests can assert on.
	AuditLive.pipe(Layer.provide(infra)),
);

// Host-published capabilities the routes reach through the registry:
// in-memory R2/Queue/AI doubles (same shapes as apps/web test env) plus
// the real interop exporters the host wires in platform.ts.
const audioBucketStore = new Map<string, { data: Uint8Array; contentType?: string }>();
const jobsSent: { kind: string; payload: unknown; options?: unknown }[] = [];

const fakeBucket = {
	put: async (
		key: string,
		value: ArrayBuffer | Uint8Array | ReadableStream,
		options?: { httpMetadata?: { contentType?: string } },
	) => {
		const data =
			value instanceof Uint8Array
				? value
				: value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(await new Response(value).arrayBuffer());
		audioBucketStore.set(key, { data, contentType: options?.httpMetadata?.contentType });
		return {};
	},
	head: async (key: string) => {
		const object = audioBucketStore.get(key);
		if (!object) return null;
		return {
			size: object.data.byteLength,
			httpMetadata: { contentType: object.contentType },
		};
	},
	get: async (
		key: string,
		options?: { range?: { offset?: number; length?: number; suffix?: number } },
	) => {
		const object = audioBucketStore.get(key);
		if (!object) return null;
		const { contentType } = object;
		let data = object.data;
		const range = options?.range;
		if (range) {
			const offset =
				range.suffix != null ? Math.max(0, data.byteLength - range.suffix) : (range.offset ?? 0);
			data = data.subarray(offset, range.length != null ? offset + range.length : data.byteLength);
		}
		const bytes = data.slice();
		return {
			key,
			size: bytes.byteLength,
			httpMetadata: { contentType },
			body: new Response(bytes).body!,
		};
	},
	delete: async (keys: string | string[]) => {
		for (const key of Array.isArray(keys) ? keys : [keys]) audioBucketStore.delete(key);
	},
};

const runtime = ManagedRuntime.make(services as Layer.Layer<unknown, never, never>);

/** Host-runtime overrides shared by every published runtime variant —
 * a tenant-bound variant (zk gate tests) swaps the ManagedRuntime in
 * temporarily via `publishRuntime`. */
const runtimeOverrides = {
	audio: fakeBucket,
	jobs: {
		enqueue: async (kind: string, payload: unknown, options?: unknown) => {
			jobsSent.push({ kind, payload, options });
		},
	},
	ai: {
		run: async () => ({ text: "transcrição do servidor" }),
	},
	recordExporters: { "fhir-r4": fhirR4Exporter, openehr: openEhrExporter },
	pluginEnabled: async () => pluginGate.enabled,
};

/** Publish a ManagedRuntime as the host runtime — a tenant-bound
 * variant (zk gate tests) swaps this in temporarily. */
const publishRuntime = (rt: ManagedRuntime.ManagedRuntime<unknown, never>) =>
	installServerFnRuntime(rt, authStub, runtimeOverrides);

beforeAll(() => {
	publishRuntime(runtime);
});

const useSession = (key: string) => {
	serverFnRequestHeaders.current = new Headers({ cookie: `session=${key}` });
};

describe("plugin enable gate (createPluginApiRoute)", () => {
	it("answers 404 on every api route when consultations.routes is disabled", async () => {
		pluginGate.enabled = false;
		try {
			useSession("owner");
			const form = new FormData();
			form.set("audio", new File([new Uint8Array([1])], "a.wav"));
			const calls = [
				handlersOf(TranscribeRoute).POST!({
					request: new Request("http://x/api/transcribe", { method: "POST", body: form }),
				} as never),
				handlersOf(PdfRoute).GET!({ params: { id: "1" } } as never),
				handlersOf(AudioRoute).POST!({
					request: new Request("http://x/api/consultations/1/audio", {
						method: "POST",
						body: new Uint8Array([1]),
					}),
					params: { id: "1" },
				} as never),
				handlersOf(AudioRoute).GET!({ params: { id: "1" } } as never),
				handlersOf(ExportRoute).GET!({
					params: { id: "1" },
					request: new Request("http://x/api/patients/1/export?format=fhir-r4"),
				} as never),
			];
			for (const res of await Promise.all(calls)) {
				expect(res.status).toBe(404);
				expect(await res.json()).toEqual({ error: "not found" });
			}
		} finally {
			pluginGate.enabled = true;
		}
	});
});

const sec = (content: string) => ({ content, confidence: "alta", evidence: [] });

describe("GET /api/transcribe", () => {
	const post = (body: BodyInit) =>
		handlersOf(TranscribeRoute).POST!({
			request: new Request("http://x/api/transcribe", { method: "POST", body }),
		} as never);

	it("rejects unauthenticated requests and missing audio", async () => {
		const saved = serverFnRequestHeaders.current;
		serverFnRequestHeaders.current = new Headers();
		try {
			const form = new FormData();
			form.set("audio", new File([new Uint8Array([1, 2, 3])], "a.wav"));
			expect((await post(form)).status).toBe(401);
		} finally {
			serverFnRequestHeaders.current = saved;
		}

		useSession("owner");
		const empty = await post(new FormData());
		expect(empty.status).toBe(400);
	});

	it("returns the transcription text", async () => {
		useSession("owner");
		const form = new FormData();
		form.set("audio", new File([new Uint8Array([1, 2, 3])], "a.wav"));
		const res = await post(form);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ text: "transcrição do servidor" });
	});

	it("403s inside a zero-knowledge tenant — browser transcription only (T-146)", async () => {
		useSession("owner");
		const zkRuntime = ManagedRuntime.make(
			Layer.mergeAll(
				services,
				Layer.succeed(Tenant, { id: 9, kind: "clinic", slug: "zk", role: "admin" }),
			) as Layer.Layer<unknown, never, never>,
		);
		publishRuntime(zkRuntime);
		try {
			const form = new FormData();
			form.set("audio", new File([new Uint8Array([1, 2, 3])], "a.wav"));
			const res = await post(form);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: "server transcription unavailable for zero-knowledge tenants",
			});
		} finally {
			publishRuntime(runtime);
			await zkRuntime.dispose();
		}
	});
});

describe("GET /api/consultations/:id/pdf", () => {
	const get = (id: string) => handlersOf(PdfRoute).GET!({ params: { id } } as never);

	it("rejects bad ids, anonymous callers and foreign consultations", async () => {
		useSession("owner");
		expect((await get("99999")).status).toBe(404);
		expect((await get("abc")).status).toBe(404);

		const saved = serverFnRequestHeaders.current;
		serverFnRequestHeaders.current = new Headers();
		expect((await get("1")).status).toBe(404);
		serverFnRequestHeaders.current = saved;

		// Another user's consultation → service Forbidden → 404.
		const foreign = (await createConsultation(db, { userId: "u-owner", source: "mic" }))!;
		useSession("other");
		expect((await get(String(foreign))).status).toBe(404);
		useSession("owner");
		// Owner but no anamnesis yet → 409.
		expect((await get(String(foreign))).status).toBe(409);
	});

	it("serves the owner PDF and 409s without anamnesis", async () => {
		useSession("owner");
		const id = (await createConsultation(db, { userId: "u-owner", source: "mic" }))!;
		const noAnamnesis = await get(String(id));
		expect(noAnamnesis.status).toBe(409);

		const anamnesisSec = { content: "x", confidence: "alta", evidence: [] };
		await db
			.update(consultationsTable)
			.set({
				anamnesis: JSON.stringify({
					queixa_principal: anamnesisSec,
					hda: anamnesisSec,
					antecedentes: anamnesisSec,
					alergias: anamnesisSec,
					medicamentos_em_uso: anamnesisSec,
					exame_fisico: anamnesisSec,
					hipoteses: anamnesisSec,
					conduta: anamnesisSec,
				}),
			})
			.where(eq(consultationsTable.id, id));
		const pdf = await get(String(id));
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get("content-type")).toBe("application/pdf");
		expect((await pdf.arrayBuffer()).byteLength).toBeGreaterThan(100);
	});

	it("refuses to render a PDF for a ciphered anamnesis envelope (T-146)", async () => {
		useSession("owner");
		const id = (await createConsultation(db, { userId: "u-owner", source: "mic" }))!;
		await db
			.update(consultationsTable)
			.set({ anamnesis: "v1.aXY.Y2lwaGVy" })
			.where(eq(consultationsTable.id, id));
		const res = await get(String(id));
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: "zero-knowledge record — render the PDF on an approved device",
		});
	});
});

describe("POST/GET /api/consultations/:id/audio", () => {
	const post = (id: number | string, body: BodyInit, contentType?: string) =>
		handlersOf(AudioRoute).POST!({
			request: new Request(`http://x/api/consultations/${id}/audio`, {
				method: "POST",
				headers: contentType ? { "content-type": contentType } : {},
				body,
			}),
			params: { id: String(id) },
		} as never);
	const get = (id: number | string, headers?: Record<string, string>) =>
		handlersOf(AudioRoute).GET!({
			request: new Request(`http://x/api/consultations/${id}/audio`, { headers }),
			params: { id: String(id) },
		} as never);

	it("rejects unauthenticated upload and download", async () => {
		useSession("owner");
		const saved = serverFnRequestHeaders.current;
		serverFnRequestHeaders.current = new Headers();
		try {
			const up = await post(1, new Uint8Array([1]), "audio/webm");
			expect(up.status).toBe(401);
			expect((await get(1)).status).toBe(401);
		} finally {
			serverFnRequestHeaders.current = saved;
		}
	});

	it("stores ciphertext but never enqueues Whisper under a ZK tenant (T-147)", async () => {
		useSession("owner");
		const zkRuntime = ManagedRuntime.make(
			Layer.mergeAll(
				services,
				Layer.succeed(Tenant, { id: 9, kind: "clinic", slug: "zk", role: "admin" }),
			) as Layer.Layer<unknown, never, never>,
		);
		publishRuntime(zkRuntime);
		try {
			const id = (await createConsultation(db, { userId: "u-owner", source: "mic" }, 9))!;
			const before = jobsSent.length;
			const res = await post(
				id,
				new Uint8Array([75, 84, 66, 49, 1, 2, 3]),
				"application/octet-stream",
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { audioStatus: string };
			expect(body.audioStatus).toBe("zk");
			expect(jobsSent.length).toBe(before); // ciphertext never reaches the queue
			const row = await db.query.consultations.findFirst({
				where: eq(consultationsTable.id, id),
			});
			expect(row?.audioStatus).toBe("zk");
			expect(row?.audioKey).toMatch(/^audio\/u-owner\//);
			// The stored object is opaque — GET streams the ciphertext back.
			const got = await get(id);
			expect(got.status).toBe(200);
			expect(new Uint8Array(await got.arrayBuffer())).toEqual(
				new Uint8Array([75, 84, 66, 49, 1, 2, 3]),
			);
		} finally {
			publishRuntime(runtime);
			await zkRuntime.dispose();
		}
	});

	it("enqueues Whisper normally for a non-ZK clinic tenant", async () => {
		useSession("owner");
		const plainRuntime = ManagedRuntime.make(
			Layer.mergeAll(
				services,
				Layer.succeed(Tenant, { id: 10, kind: "clinic", slug: "plain", role: "admin" }),
			) as Layer.Layer<unknown, never, never>,
		);
		publishRuntime(plainRuntime);
		try {
			const id = (await createConsultation(db, { userId: "u-owner", source: "mic" }, 10))!;
			const before = jobsSent.length;
			const res = await post(id, new Uint8Array([1, 2, 3]), "audio/webm");
			expect(res.status).toBe(200);
			expect(((await res.json()) as { audioStatus: string }).audioStatus).toBe("queued");
			expect(jobsSent.length).toBe(before + 1);
		} finally {
			publishRuntime(runtime);
			await plainRuntime.dispose();
		}
	});

	it("enqueues Whisper for a personal-scope row (tenant_id null short-circuits ZK)", async () => {
		useSession("owner");
		const id = (await createConsultation(db, { userId: "u-owner", source: "mic" }))!;
		const before = jobsSent.length;
		const res = await post(id, new Uint8Array([1, 2, 3]), "audio/webm");
		expect(res.status).toBe(200);
		expect(((await res.json()) as { audioStatus: string }).audioStatus).toBe("queued");
		expect(jobsSent.length).toBe(before + 1);
	});

	it("uploads raw audio to R2, links the row and enqueues the job", async () => {
		useSession("owner");
		const id = (await createConsultation(db, { userId: "u-owner", source: "browser" }))!;
		const bytes = new Uint8Array([9, 8, 7, 6]);
		const res = await post(id, bytes, "audio/webm");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, audioStatus: "queued", audioSize: 4 });

		const rows = await db.select().from(consultationsTable).where(eq(consultationsTable.id, id));
		const row = rows[0]!;
		expect(row.audioStatus).toBe("queued");
		expect(row.audioKey).toMatch(new RegExp(`^audio/u-owner/${id}/.*\\.webm$`));
		expect(row.audioContentType).toBe("audio/webm");
		expect(row.audioSize).toBe(4);
		expect(audioBucketStore.has(row.audioKey!)).toBe(true);
		expect(jobsSent.at(-1)).toMatchObject({
			kind: "transcription.audio",
			payload: {
				consultationId: id,
				audioKey: row.audioKey,
				userId: "u-owner",
				// Personal-scope row → explicit null tenant on the message.
				tenantId: null,
			},
			options: { tenantId: null, payloadRef: `consultation:${id}` },
		});
	});

	it("accepts multipart audio file uploads", async () => {
		useSession("owner");
		const id = (await createConsultation(db, { userId: "u-owner", source: "browser" }))!;
		const form = new FormData();
		form.set("audio", new File([new Uint8Array([1, 2])], "rec.ogg", { type: "audio/ogg" }));
		const res = await handlersOf(AudioRoute).POST!({
			request: new Request(`http://x/api/consultations/${id}/audio`, {
				method: "POST",
				body: form,
			}),
			params: { id: String(id) },
		} as never);
		expect(res.status).toBe(200);
	});

	it("rejects bad ids, empty bodies and foreign consultations", async () => {
		useSession("owner");
		expect((await post("abc", new Uint8Array([1]), "audio/webm")).status).toBe(404);

		const id = (await createConsultation(db, { userId: "u-owner", source: "browser" }))!;
		expect((await post(id, new Uint8Array(0), "audio/webm")).status).toBe(400);

		const foreign = (await createConsultation(db, {
			userId: "u-other",
			source: "browser",
		}))!;
		expect((await post(foreign, new Uint8Array([1]), "audio/webm")).status).toBe(404);
	});

	it("streams stored audio back to the owner only", async () => {
		useSession("owner");
		const id = (await createConsultation(db, { userId: "u-owner", source: "browser" }))!;
		const bytes = new Uint8Array([5, 4, 3, 2, 1]);
		await post(id, bytes, "audio/webm");

		const res = await get(id);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("audio/webm");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

		const foreign = (await createConsultation(db, {
			userId: "u-other",
			source: "browser",
		}))!;
		expect((await get(foreign)).status).toBe(404);

		const noAudio = (await createConsultation(db, { userId: "u-owner", source: "browser" }))!;
		expect((await get(noAudio)).status).toBe(404);
	});

	it("honors Range requests — 206 slices, accept-ranges on every response (seekable media)", async () => {
		useSession("owner");
		const id = (await createConsultation(db, { userId: "u-owner", source: "browser" }))!;
		const bytes = new Uint8Array([10, 20, 30, 40, 50]);
		await post(id, bytes, "audio/wav");

		const full = await get(id);
		expect(full.status).toBe(200);
		expect(full.headers.get("accept-ranges")).toBe("bytes");
		expect(full.headers.get("content-length")).toBe("5");
		await full.arrayBuffer();

		const slice = await get(id, { range: "bytes=1-3" });
		expect(slice.status).toBe(206);
		expect(slice.headers.get("content-range")).toBe("bytes 1-3/5");
		expect(slice.headers.get("content-length")).toBe("3");
		expect(new Uint8Array(await slice.arrayBuffer())).toEqual(new Uint8Array([20, 30, 40]));

		const open = await get(id, { range: "bytes=3-" });
		expect(open.status).toBe(206);
		expect(open.headers.get("content-range")).toBe("bytes 3-4/5");
		expect(new Uint8Array(await open.arrayBuffer())).toEqual(new Uint8Array([40, 50]));

		const suffix = await get(id, { range: "bytes=-2" });
		expect(suffix.status).toBe(206);
		expect(suffix.headers.get("content-range")).toBe("bytes 3-4/5");

		const over = await get(id, { range: "bytes=99-" });
		expect(over.status).toBe(416);
		expect(over.headers.get("content-range")).toBe("bytes */5");
	});

	it("ignores malformed and inverted Range headers — full-body 200", async () => {
		useSession("owner");
		const id = (await createConsultation(db, { userId: "u-owner", source: "browser" }))!;
		const bytes = new Uint8Array([10, 20, 30, 40, 50]);
		await post(id, bytes, "audio/wav");

		for (const range of [
			"items=0-1", // not a bytes unit
			"bytes=1-2,4-5", // multi-range — spec allows ignoring
			"bytes=-", // empty suffix
			"bytes=-0", // zero-length suffix
			"bytes=3-1", // inverted: end before offset
		]) {
			const res = await get(id, { range });
			expect(res.status).toBe(200);
			expect(res.headers.get("content-length")).toBe("5");
			expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
		}
	});
});

describe("GET /api/patients/:id/export", () => {
	let patientId = 0;

	const call = (id: string, format: string | null) =>
		handlersOf(ExportRoute).GET!({
			params: { id },
			request: new Request(
				`http://localhost:3000/api/patients/${id}/export${format ? `?format=${format}` : ""}`,
			),
		} as never);

	beforeAll(async () => {
		useSession("owner");
		const fields = validatePatient({ name: "Ana Souza", birthDate: "1984", gender: "female" });
		if (!fields.ok) throw new Error("fixture");
		patientId = (await createPatient(db, "u-owner", fields.fields))!.id;
		// Two consultations, inserted newest-first: the export orders them oldest-first.
		for (const [at, complaint] of [
			["2026-11-06T10:00:00Z", "Retorno"],
			["2026-11-05T10:00:00Z", "Cefaleia"],
		] as const) {
			const id = await createConsultation(db, { userId: "u-owner", source: "browser" });
			await db
				.update(consultationsTable)
				.set({
					patientId,
					createdAt: new Date(at),
					transcript: `Transcrição: ${complaint}`,
					engine: "heuristic",
					anamnesis: JSON.stringify({
						queixa_principal: sec(complaint),
						hda: sec("x"),
						antecedentes: sec(""),
						alergias: sec(""),
						medicamentos_em_uso: sec(""),
						exame_fisico: sec(""),
						hipoteses: sec(""),
						conduta: sec(""),
					}),
				})
				.where(eq(consultationsTable.id, id!));
		}
	});

	it("rejects a missing or unknown format", async () => {
		useSession("owner");
		expect((await call(String(patientId), null)).status).toBe(400);
		expect((await call(String(patientId), "hl7v2")).status).toBe(400);
	});

	it("answers 404 for anonymous callers, bad ids, missing and foreign patients", async () => {
		const saved = serverFnRequestHeaders.current;
		serverFnRequestHeaders.current = new Headers();
		expect((await call(String(patientId), "fhir-r4")).status).toBe(404);
		serverFnRequestHeaders.current = saved;

		useSession("owner");
		expect((await call("abc", "fhir-r4")).status).toBe(404);
		expect((await call("99999", "fhir-r4")).status).toBe(404);

		useSession("other");
		expect((await call(String(patientId), "openehr")).status).toBe(404);
		useSession("owner");
	});

	it("downloads the record as a FHIR R4 Bundle", async () => {
		useSession("owner");
		const res = await call(String(patientId), "fhir-r4");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/fhir+json; charset=utf-8");
		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="patient-${patientId}.fhir-r4.json"`,
		);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		const bundle: any = await res.json();
		expect(bundle.resourceType).toBe("Bundle");
		const types = bundle.entry.map((e: any) => e.resource.resourceType);
		expect(types.filter((t: string) => t === "Composition")).toHaveLength(2);
		const complaints = bundle.entry
			.filter((e: any) => e.resource.resourceType === "Composition")
			.map((e: any) => e.resource.section[0].text.div);
		expect(complaints[0]).toContain("Cefaleia");
		expect(complaints[1]).toContain("Retorno");
		const practitioner = bundle.entry.find((e: any) => e.resource.resourceType === "Practitioner");
		expect(practitioner.resource.name).toEqual([{ text: "Dra Export" }]);
	});

	it("names an unnamed practitioner by email", async () => {
		useSession("plain");
		const fields = validatePatient({ name: "Sem Nome", birthDate: "1990" });
		if (!fields.ok) throw new Error("fixture");
		const pid = (await createPatient(db, "u-plain", fields.fields))!.id;
		const res = await call(String(pid), "fhir-r4");
		expect(res.status).toBe(200);
		const bundle: any = await res.json();
		const practitioner = bundle.entry.find((e: any) => e.resource.resourceType === "Practitioner");
		expect(practitioner.resource.name).toEqual([{ text: "plain@x.com" }]);
		useSession("owner");
	});

	it("downloads the record as an openEHR EXTRACT", async () => {
		useSession("owner");
		const res = await call(String(patientId), "openehr");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="patient-${patientId}.openehr.json"`,
		);
		const extract: any = await res.json();
		expect(extract._type).toBe("EXTRACT");
		const kinds = extract.chapters[0].items.map((i: any) => i.item._type);
		expect(kinds).toEqual([
			"X_VERSIONED_PARTY",
			"X_VERSIONED_EHR_STATUS",
			"X_VERSIONED_COMPOSITION",
			"X_VERSIONED_COMPOSITION",
		]);
	});
});

describe("sensitive-read audit emissions (P-086)", () => {
	const auditRows = () => db.select().from(adminAudit);
	const entriesFor = (action: string, targetId: number | string) =>
		auditRows().then((rows) =>
			rows.filter((r) => r.action === action && r.targetId === String(targetId)),
		);

	const anamnesisDoc = () => {
		const s = { content: "x", confidence: "alta", evidence: [] };
		return JSON.stringify({
			queixa_principal: s,
			hda: s,
			antecedentes: s,
			alergias: s,
			medicamentos_em_uso: s,
			exame_fisico: s,
			hipoteses: s,
			conduta: s,
		});
	};

	const newPatientWithConsultation = async (name: string) => {
		const fields = validatePatient({ name, birthDate: "1990" });
		if (!fields.ok) throw new Error("fixture");
		const pid = (await createPatient(db, "u-owner", fields.fields))!.id;
		const id = (await createConsultation(db, {
			userId: "u-owner",
			patientId: pid,
			source: "browser",
		}))!;
		return { pid, id };
	};

	it("pdf export emits consultations.export (via pdf) plus the detail read", async () => {
		useSession("owner");
		const { pid, id } = await newPatientWithConsultation("Audit Pdf");
		await db
			.update(consultationsTable)
			.set({ anamnesis: anamnesisDoc() })
			.where(eq(consultationsTable.id, id));
		const res = await handlersOf(PdfRoute).GET!({ params: { id: String(id) } } as never);
		expect(res.status).toBe(200);

		const [exp] = await entriesFor("consultations.export", id);
		expect(exp).toMatchObject({ targetType: "consultation", tenantId: null });
		expect(exp?.detail).toContain(`"patientId":${pid}`);
		expect(exp?.detail).toContain('"via":"pdf"');
		// Consultations.get inside the route emits the detail read too.
		const [read] = await entriesFor("consultations.read", id);
		expect(read?.detail).toContain('"via":"detail"');
		expect(read?.detail).toContain(`"patientId":${pid}`);
	});

	it("audio download emits consultations.audio.read (via audio-download)", async () => {
		useSession("owner");
		const { pid, id } = await newPatientWithConsultation("Audit Audio");
		// Store audio first so GET has an object to stream.
		const up = await handlersOf(AudioRoute).POST!({
			request: new Request(`http://x/api/consultations/${id}/audio`, {
				method: "POST",
				headers: { "content-type": "audio/webm" },
				body: new Uint8Array([1, 2, 3]),
			}),
			params: { id: String(id) },
		} as never);
		expect(up.status).toBe(200);

		const res = await handlersOf(AudioRoute).GET!({ params: { id: String(id) } } as never);
		expect(res.status).toBe(200);
		await res.arrayBuffer();

		const [audio] = await entriesFor("consultations.audio.read", id);
		expect(audio).toMatchObject({ targetType: "consultation", tenantId: null });
		expect(audio?.detail).toContain(`"patientId":${pid}`);
		expect(audio?.detail).toContain('"via":"audio-download"');
	});

	it("patient export emits patients.export with the requested format", async () => {
		useSession("owner");
		const { pid } = await newPatientWithConsultation("Audit Export");
		const res = await handlersOf(ExportRoute).GET!({
			params: { id: String(pid) },
			request: new Request(`http://x/api/patients/${pid}/export?format=fhir-r4`),
		} as never);
		expect(res.status).toBe(200);
		await res.arrayBuffer();

		const [exp] = await entriesFor("patients.export", pid);
		expect(exp).toMatchObject({ targetType: "patient", tenantId: null });
		expect(exp?.detail).toContain('"format":"fhir-r4"');
		expect(exp?.detail).not.toContain("Audit Export");
	});
});
