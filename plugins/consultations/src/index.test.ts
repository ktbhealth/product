import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { adminAudit, AUDIT_TEST_DDL, AuditLive } from "@ktb/audit";
import { Integrity, IntegrityLive, RECORD_VERSIONS_TEST_DDL, recordVersions } from "@ktb/integrity";
import { VAULT_TEST_DDL } from "@ktb/vault";
import { Db, makeDb } from "@ktb/db";
import {
	consultations as consultationsTable,
	patients as patientsTable,
	relationTuples as relationTuplesTable,
	user as userTable,
} from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { Forbidden, Principal } from "@ktb/authz";
import { buildPermissions, deleteRelationTuples, Permissions, writeRelationTuple } from "@ktb/rbac";
import {
	Patients,
	patientsServicesPlugin,
	PatientsCommandsLive,
	PatientsQueriesLive,
} from "@ktb/patients";
import { EventBus, type EventBusShape, makeEventBus, Query } from "@effect-server-utils/cqrs";
import { Tenant, type Tenant as TenantScope } from "@ktb/tenant";
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformAdminPlugin,
	platformPanelPlugin,
} from "@ktb/platform";
import { PortalAccess } from "@ktb/patient-access";
import { ConsultationAudioUpdated, ConsultationsQueries } from "./api.ts";
import { patientHistory, patientHistoryRows } from "./anamnesis.ts";
import { deletePatientConsultations } from "./queries.ts";
import {
	Consultations,
	ConsultationsLive,
	ConsultationsQueriesLive,
	appendTranscript,
	attachAudioRecord,
	audioJobRecord,
	beginAudioJob,
	completeAudioJob,
	consultationsChromePlugin,
	consultationsPanelPlugin,
	consultationsRoutesPlugin,
	consultationsServicesPlugin,
	consultationsTablesPlugin,
	createConsultation,
	deleteConsultationRow,
	failAudioJob,
	finishConsultation,
	listAllConsultations,
	markAudioQueued,
	ownsBot,
	plugins,
	saveCorrectedTranscript,
	type SaveConsultationInput,
} from "./index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";

const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL, image TEXT, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO "user" (id, name, email, email_verified, image, banned, created_at, updated_at) VALUES ('u1', 'Dra', 'd@x.com', 0, NULL, 0, 0, 0);
CREATE TABLE patients (synthetic INTEGER NOT NULL DEFAULT 0, id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL REFERENCES "user"(id), name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, social_name TEXT, gender TEXT, birth_date TEXT, phone TEXT, email TEXT, preferred_language TEXT, address_line TEXT, address_number TEXT, address_complement TEXT, district TEXT, city TEXT, state TEXT, postal_code TEXT, country TEXT, mother_name TEXT, marital_status TEXT, race_color TEXT, nationality TEXT, emergency_contact_name TEXT, emergency_contact_relationship TEXT, emergency_contact_phone TEXT, created_at INTEGER, updated_at INTEGER, tenant_id INTEGER);
CREATE TABLE patient_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, type TEXT NOT NULL, country TEXT, number TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, UNIQUE (patient_id, type));
CREATE TABLE consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES "user"(id), patient_id INTEGER REFERENCES patients(id), transcript TEXT NOT NULL, anamnesis TEXT, review TEXT, engine TEXT, source TEXT NOT NULL, status TEXT NOT NULL, bot_id TEXT, consent_at INTEGER, audio_key TEXT, audio_status TEXT NOT NULL DEFAULT 'none', audio_content_type TEXT, audio_size INTEGER, audio_error TEXT, server_transcript TEXT, corrected_transcript TEXT, enhancement_engine TEXT, anamnesis_hash TEXT, anamnesis_version INTEGER, blob_hash TEXT, synthetic INTEGER NOT NULL DEFAULT 0, eval_item_id INTEGER, created_at INTEGER NOT NULL, tenant_id INTEGER);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
${AUDIT_TEST_DDL}
${RECORD_VERSIONS_TEST_DDL}
${VAULT_TEST_DDL}
-- A ZK-flagged tenant for the cipher-gate tests; 7/8 stay plaintext.
INSERT INTO groups (id, name, slug, kind, zk, created_at, updated_at) VALUES (9, 'Clínica ZK', 'clinica-zk', 'clinic', 1, 0, 0);
`;

// ConsultationsLive requires PlatformAdmin (adminList) — every runtime
// below provides the same allowlisted gate.
const liveDeps = (
	db: ReturnType<typeof makeDb>,
	eventBus: Layer.Layer<EventBus> = makeEventBus(),
	withIntegrity = true,
) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		// T-182: record authz resolves owner tuples through the real
		// Permissions port over the test db (relation_tuples +
		// permission_epoch are in the DDL).
		Layer.succeed(Permissions, buildPermissions(db)),
		eventBus,
	);
	return Layer.mergeAll(
		infra,
		// Provide the real audit service so admin mutations write
		// admin_audit rows (T-037); fake-db tests degrade to a no-op
		// insert and the absent-service path stays covered elsewhere.
		AuditLive.pipe(Layer.provide(infra)),
		// Real integrity service: save/attach mint record_versions rows
		// (T-138); a runtime without it exercises the absent-plugin path.
		...(withIntegrity ? [IntegrityLive.pipe(Layer.provide(infra))] : []),
		// ConsultationsLive dispatches `patients.ownerOf` / `patients.delete`
		// — register the real handlers against the test db (same impls the
		// patients plugin ships).
		Layer.mergeAll(PatientsQueriesLive, PatientsCommandsLive).pipe(Layer.provide(infra)),
	);
};

/** T-182: raw patient inserts bypass createPatient's tuple write —
 * mirror the `patient:<id>#owner@user:<ownerId>` grant so record
 * authz (requireObject/canObject) sees the same ownership the
 * owner_id column claims. */
const grantPatientOwner = (db: ReturnType<typeof makeDb>, id: number, ownerId: string) =>
	writeRelationTuple(db, {
		objectType: "patient",
		objectId: String(id),
		relation: "owner",
		subjectKind: "user",
		subjectId: ownerId,
	});

describe("consultations repo", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(DDL));
	});

	it("creates with defaults", async () => {
		const id = await createConsultation(db, { userId: "u1", source: "browser" });
		expect(id).toBeTypeOf("number");
	});

	it("appendTranscript concatenates chunks", async () => {
		const id = await createConsultation(db, {
			userId: "u1",
			transcript: "one",
			source: "bot",
		});
		await appendTranscript(db, id!, "two");
		await appendTranscript(db, id!, "three");
		const { consultations } = await import("@ktb/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await db
			.select({ t: consultations.transcript })
			.from(consultations)
			.where(eq(consultations.id, id!));
		expect(rows[0]!.t).toBe("one\ntwo\nthree");
	});

	it("finishConsultation marks done", async () => {
		const id = await createConsultation(db, {
			userId: "u1",
			source: "live",
			status: "live",
		});
		await finishConsultation(db, id!);
		const { consultations } = await import("@ktb/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await db
			.select({ s: consultations.status })
			.from(consultations)
			.where(eq(consultations.id, id!));
		expect(rows[0]!.s).toBe("done");
	});

	it("appendTranscript on missing row uses empty base", async () => {
		await appendTranscript(db, 9999, "orphan");
	});

	it("ownsBot matches consultation by botId", async () => {
		const id = await createConsultation(db, {
			userId: "u1",
			source: "bot",
			status: "live",
			botId: "bot-1",
		});
		expect(await ownsBot(db, id!, "bot-1")).toBe(true);
		expect(await ownsBot(db, id!, "other-bot")).toBe(false);
		expect(await ownsBot(db, 9999, "bot-1")).toBe(false);
	});

	it("createConsultation returns null when insert yields no row", async () => {
		const stub = {
			insert: () => ({
				values: () => ({ returning: async () => [] }),
			}),
		} as unknown as typeof db;
		expect(await createConsultation(stub, { userId: "u1", source: "browser" })).toBeNull();
	});

	it("listAllConsultations returns cross-owner rows with owner and patient fields", async () => {
		const [p] = await db
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Repo Paciente", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		const id = await createConsultation(db, { userId: "u1", source: "browser" });
		await db
			.update(consultationsTable)
			.set({ patientId: p!.id })
			.where(eq(consultationsTable.id, id!));
		const rows = await listAllConsultations(db);
		const row = rows.find((r) => r.id === id);
		expect(row?.ownerEmail).toBe("d@x.com");
		expect(row?.ownerName).toBe("Dra");
		expect(row?.patientName).toBe("Repo Paciente");
		// Newest first.
		expect(rows[0]?.id).toBeGreaterThanOrEqual(rows.at(-1)?.id ?? 0);
	});

	describe("relation tuples (P-101)", () => {
		const ownerTuples = (consultationId: number) =>
			db
				.select()
				.from(relationTuplesTable)
				.where(
					and(
						eq(relationTuplesTable.objectType, "consultation"),
						eq(relationTuplesTable.objectId, String(consultationId)),
						eq(relationTuplesTable.relation, "owner"),
					),
				);

		it("writes an owner tuple on createConsultation", async () => {
			const id = await createConsultation(db, { userId: "u1", source: "browser" }, null, "u1");
			const tuples = await ownerTuples(id!);
			expect(tuples).toHaveLength(1);
			expect(tuples[0]).toMatchObject({
				subjectKind: "user",
				subjectId: "u1",
				effect: "allow",
				grantedBy: "u1",
			});
		});

		it("drops the owner tuple on deleteConsultationRow", async () => {
			const id = await createConsultation(db, { userId: "u1", source: "browser" });
			expect(await ownerTuples(id!)).toHaveLength(1);
			await deleteConsultationRow(db, id!);
			expect(await ownerTuples(id!)).toEqual([]);
		});
	});
});

describe("ConsultationsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Consultations, never>;
	let testDb: ReturnType<typeof makeDb>;

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Consultations>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Consultations, f);

	const saveInput = (over: Partial<SaveConsultationInput> = {}): SaveConsultationInput => ({
		transcript: "t",
		anamnesis: {} as SaveConsultationInput["anamnesis"],
		engine: "e",
		...over,
	});

	beforeAll(() => {
		testDb = makeDb(makeD1(DDL));
		runtime = ManagedRuntime.make(ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb))));
	});

	afterAll(() => runtime.dispose());

	it("bot-channel methods run without a principal (system path)", async () => {
		const id = await createConsultation(testDb, {
			userId: "u1",
			source: "bot",
			botId: "svc-bot",
		});
		await runtime.runPromise(
			Effect.gen(function* () {
				const c = yield* Consultations;
				yield* c.appendTranscript(id!, "svc chunk");
				yield* c.finish(id!);
				expect(yield* c.ownedByBot(id!, "svc-bot")).toBe(true);
				expect(yield* c.ownedByBot(id!, "nope")).toBe(false);
			}),
		);
	});

	it("create/save enforce the bound principal", async () => {
		const id = await asUser(
			"u1",
			call((c) => c.create({ userId: "u1", source: "browser", botId: "b1" })),
		);
		expect(id).toBeTypeOf("number");

		const saved = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput())),
		);
		expect(saved.id).toBeGreaterThan(0);

		await expect(
			asUser(
				"u1",
				call((c) => c.create({ userId: "u2", source: "browser" })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "consultation.create" });
		await expect(
			asUser(
				"u1",
				call((c) => c.save("u2", saveInput())),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				null,
				call((c) => c.create({ userId: "u1", source: "browser" })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				null,
				call((c) => c.save("u1", saveInput())),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("list/get/getLive are owner-scoped via permix", async () => {
		const id = await asUser(
			"u1",
			call((c) => c.create({ userId: "u1", transcript: "live text", source: "mic" })),
		);

		const list = await asUser(
			"u1",
			call((c) => c.list("u1")),
		);
		expect(list.some((c) => c.id === id)).toBe(true);
		await expect(
			asUser(
				"u1",
				call((c) => c.list("u2")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				null,
				call((c) => c.list("u1")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});

		const detail = await asUser(
			"u1",
			call((c) => c.get(id!, "u1")),
		);
		expect(detail?.userId).toBe("u1");
		expect(
			await asUser(
				"u1",
				call((c) => c.get(9999, "u1")),
			),
		).toBeNull();
		await expect(
			asUser(
				"u2",
				call((c) => c.get(id!, "u2")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				null,
				call((c) => c.get(id!, "u1")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});

		const live = await asUser(
			"u1",
			call((c) => c.getLive(id!, "u1")),
		);
		expect(live).toEqual({ transcript: "live text", status: "done" });
		expect(
			await asUser(
				"u1",
				call((c) => c.getLive(9999, "u1")),
			),
		).toBeNull();
		await expect(
			asUser(
				"u2",
				call((c) => c.getLive(id!, "u2")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("adminList returns cross-owner rows for an allowlisted principal", async () => {
		const rows = await asUser(
			"u1",
			call((c) => c.adminList()),
			"admin@x.com",
		);
		expect(rows.length).toBeGreaterThan(0);
		// Fixture consultations are u1-owned; the join resolves the
		// owner's email — proof adminList is not owner-scoped.
		expect(rows.every((r) => r.ownerEmail === "d@x.com")).toBe(true);
	});

	it("adminList fails Forbidden for non-admin email, missing email and null principal", async () => {
		await expect(
			asUser(
				"u1",
				call((c) => c.adminList()),
				"other@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "platform.admin" });
		await expect(
			asUser(
				"u1",
				call((c) => c.adminList()),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				null,
				call((c) => c.adminList()),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("adminCreate inserts a consultation for another owner", async () => {
		await testDb.insert(userTable).values({
			id: "u2",
			name: "Dr B",
			email: "b@x.com",
			emailVerified: false,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		const id = await asUser(
			"u1",
			call((c) => c.adminCreate({ userId: "u2", transcript: "admin note", source: "manual" })),
			"admin@x.com",
		);
		expect(id).not.toBeNull();
		const rows = await testDb
			.select()
			.from(consultationsTable)
			.where(eq(consultationsTable.id, id!));
		expect(rows[0]).toMatchObject({ userId: "u2", transcript: "admin note", source: "manual" });
		// T-037: the audit row carries ids/source only — never the transcript.
		const auditRows = await testDb.select().from(adminAudit);
		const entry = auditRows.find(
			(r) => r.action === "consultations.create" && r.targetId === String(id),
		);
		expect(entry).toMatchObject({
			actorUserId: "u1",
			actorEmail: "admin@x.com",
			targetType: "consultation",
		});
		expect(entry?.detail).not.toContain("admin note");
	});

	it("adminCreate links an existing patient and rejects unknown ones", async () => {
		const [patient] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Pat", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		const id = await asUser(
			"u1",
			call((c) => c.adminCreate({ userId: "u2", patientId: patient!.id, source: "manual" })),
			"admin@x.com",
		);
		const rows = await testDb
			.select({ patientId: consultationsTable.patientId })
			.from(consultationsTable)
			.where(eq(consultationsTable.id, id!));
		expect(rows[0]?.patientId).toBe(patient!.id);

		await expect(
			asUser(
				"u1",
				call((c) => c.adminCreate({ userId: "u2", patientId: 999999, source: "manual" })),
				"admin@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patientId" });
	});

	it("adminCreate fails Forbidden for non-admin and null principal", async () => {
		await expect(
			asUser(
				"u1",
				call((c) => c.adminCreate({ userId: "u2", source: "manual" })),
				"other@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "platform.admin" });
		await expect(
			asUser(
				null,
				call((c) => c.adminCreate({ userId: "u2", source: "manual" })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("adminDelete removes the row and returns its audio key", async () => {
		const [p] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Del Paciente", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		const id = await createConsultation(testDb, {
			userId: "u1",
			source: "mic",
			patientId: p!.id,
		});
		await testDb
			.update(consultationsTable)
			.set({ audioKey: "audios/x.webm" })
			.where(eq(consultationsTable.id, id!));
		const result = await asUser(
			"u1",
			call((c) => c.adminDelete(id!)),
			"admin@x.com",
		);
		expect(result).toEqual({ audioKey: "audios/x.webm" });
		const rows = await testDb
			.select({ id: consultationsTable.id })
			.from(consultationsTable)
			.where(eq(consultationsTable.id, id!));
		expect(rows).toEqual([]);
		// T-037/P-086: delete is audited with hadAudio + patientId —
		// never the audio key or record fields.
		const auditRows = await testDb.select().from(adminAudit);
		const entry = auditRows.find(
			(r) => r.action === "consultations.delete" && r.targetId === String(id),
		);
		expect(entry).toMatchObject({
			actorUserId: "u1",
			actorEmail: "admin@x.com",
			targetType: "consultation",
		});
		expect(entry?.detail).toContain('"hadAudio":true');
		expect(entry?.detail).toContain(`"patientId":${p!.id}`);
		expect(entry?.detail).not.toContain("audios/x.webm");
	});

	it("adminCreate returns null when the insert yields no row", async () => {
		const stub = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as ReturnType<typeof makeDb>;
		const runtime = ManagedRuntime.make(ConsultationsLive.pipe(Layer.provideMerge(liveDeps(stub))));
		try {
			const id = await runtime.runPromise(
				Effect.provideService(
					Effect.flatMap(Consultations, (c) => c.adminCreate({ userId: "u2", source: "manual" })),
					Principal,
					{ userId: "u1", email: "admin@x.com" },
				),
			);
			expect(id).toBeNull();
		} finally {
			await runtime.dispose();
		}
	});

	it("adminDelete reports null for a missing row and denies non-admins", async () => {
		expect(
			await asUser(
				"u1",
				call((c) => c.adminDelete(424242)),
				"admin@x.com",
			),
		).toBeNull();
		const id = await createConsultation(testDb, { userId: "u1", source: "mic" });
		await expect(
			asUser(
				"u1",
				call((c) => c.adminDelete(id!)),
				"other@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("get and getLive let an admin read another owner's consultation", async () => {
		const id = await createConsultation(testDb, {
			userId: "u1",
			transcript: "secret",
			source: "mic",
		});
		const detail = await asUser(
			"u2",
			call((c) => c.get(id!, "u2")),
			"admin@x.com",
		);
		expect(detail?.transcript).toBe("secret");
		const live = await asUser(
			"u2",
			call((c) => c.getLive(id!, "u2")),
			"admin@x.com",
		);
		expect(live).toEqual({ transcript: "secret", status: "done" });
		// Non-admin still Forbidden.
		await expect(
			asUser(
				"u2",
				call((c) => c.get(id!, "u2")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("denies reads on ownerless rows (null userId)", async () => {
		const id = await createConsultation(testDb, { userId: "u1", source: "mic" });
		await testDb
			.update(consultationsTable)
			.set({ userId: null })
			.where(eq(consultationsTable.id, id!));
		// T-182: ownership is the relation tuple, not the user_id column —
		// revoke it so the row is genuinely unowned (a stale tuple would
		// still admit u1, which is the intended ReBAC semantic).
		await deleteRelationTuples(testDb, {
			objectType: "consultation",
			objectId: String(id),
			relation: "owner",
		});
		await expect(
			asUser(
				"u1",
				call((c) => c.get(id!, "u1")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				"u1",
				call((c) => c.getLive(id!, "u1")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("attachAnamnesis/recordConsent check entity ownership", async () => {
		const id = await asUser(
			"u1",
			call((c) => c.create({ userId: "u1", transcript: "t", source: "mic" })),
		);

		await asUser(
			"u1",
			call((c) =>
				c.attachAnamnesis("u1", {
					consultationId: id!,
					anamnesis: {} as SaveConsultationInput["anamnesis"],
					engine: "e",
				}),
			),
		);
		await asUser(
			"u1",
			call((c) => c.recordConsent(id!, "u1")),
		);

		// Cross-user mutation → Forbidden (owner lookup + permix update rule).
		await expect(
			asUser(
				"u2",
				call((c) =>
					c.attachAnamnesis("u2", {
						consultationId: id!,
						anamnesis: {} as SaveConsultationInput["anamnesis"],
						engine: "e",
					}),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u2",
				call((c) => c.recordConsent(id!, "u2")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});

		// Missing row → owner lookup is null → update no-ops (no authz needed).
		await asUser(
			"u1",
			call((c) =>
				c.attachAnamnesis("u1", {
					consultationId: 9999,
					anamnesis: {} as SaveConsultationInput["anamnesis"],
					engine: "e",
				}),
			),
		);
		await asUser(
			"u1",
			call((c) => c.recordConsent(9999, "u1")),
		);
	});

	it("audits owner mutations with ids/flags only (P-080)", async () => {
		const id = await asUser(
			"u1",
			call((c) => c.create({ userId: "u1", transcript: "secret", source: "mic" })),
		);
		const saved = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput())),
		);
		await asUser(
			"u1",
			call((c) =>
				c.attachAnamnesis("u1", {
					consultationId: saved.id,
					anamnesis: {} as SaveConsultationInput["anamnesis"],
					engine: "e2",
				}),
			),
		);
		await asUser(
			"u1",
			call((c) => c.recordConsent(saved.id, "u1")),
		);
		await asUser(
			"u1",
			call((c) =>
				c.attachAudio("u1", {
					consultationId: saved.id,
					audioKey: "k-audit",
					contentType: "audio/webm",
					size: 5,
				}),
			),
		);
		await asUser(
			"u1",
			call((c) => c.updateAudioStatus("u1", saved.id, "queued")),
		);
		// finish is a system path — no principal bound, actor columns NULL.
		await runtime.runPromise(Effect.flatMap(Consultations, (c) => c.finish(saved.id)));

		const rows = await testDb.select().from(adminAudit);
		const find = (action: string, targetId: number) =>
			rows.find((r) => r.action === action && r.targetId === String(targetId));

		const created = find("consultations.create", id!);
		expect(created).toMatchObject({
			actorUserId: "u1",
			targetType: "consultation",
		});
		expect(created?.detail).toContain('"source":"mic"');
		expect(created?.detail).not.toContain("secret");

		expect(find("consultations.save", saved.id)?.detail).toContain('"engine":"e"');
		expect(find("consultations.anamnesis.attach", saved.id)?.detail).toContain('"engine":"e2"');
		expect(find("consultations.consent.record", saved.id)).toMatchObject({
			targetType: "consultation",
		});
		// P-087 D1 sanitizer drops `contentType` ("content" substring) by
		// design — `size` survives as the remaining non-sensitive flag.
		expect(find("consultations.audio.attach", saved.id)?.detail).toContain('"size":5');
		expect(find("consultations.audio.status", saved.id)?.detail).toContain('"status":"queued"');
		const finished = find("consultations.finish", saved.id);
		expect(finished).toMatchObject({
			actorUserId: null,
			targetType: "consultation",
		});
		expect(finished?.detail).toContain('"status":"done"');
	});

	it("get audits consultations.read with patientId and the row's tenant", async () => {
		const [p] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Read Audit", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		// Tenant-owned row (group 9 exists in the fixture DDL).
		const tenantId = await createConsultation(
			testDb,
			{ userId: "u1", patientId: p!.id, source: "browser" },
			9,
		);
		// Personal (tenantless) row read by its owner.
		const personalId = await createConsultation(testDb, {
			userId: "u1",
			patientId: p!.id,
			source: "browser",
		});
		await asUser(
			"u1",
			call((c) => c.get(personalId!, "u1")),
		);
		// Cross-owner admin read of the tenant row — tenant_id is
		// row-authoritative, not the ambient scope.
		await asUser(
			"u1",
			call((c) => c.get(tenantId!, "u1")),
			"admin@x.com",
		);

		const rows = await testDb.select().from(adminAudit);
		const find = (targetId: number) =>
			rows.find((r) => r.action === "consultations.read" && r.targetId === String(targetId));
		const personal = find(personalId!);
		expect(personal).toMatchObject({
			actorUserId: "u1",
			targetType: "consultation",
			tenantId: null,
		});
		expect(personal?.detail).toContain(`"patientId":${p!.id}`);
		expect(personal?.detail).toContain('"via":"detail"');
		expect(personal?.detail).not.toContain("Read Audit");
		expect(find(tenantId!)).toMatchObject({ targetType: "consultation", tenantId: 9 });

		// Missing rows and denied reads write nothing; getLive is not audited.
		const before = rows.length;
		expect(
			await asUser(
				"u1",
				call((c) => c.get(999999, "u1")),
			),
		).toBeNull();
		await expect(
			asUser(
				"u2",
				call((c) => c.get(personalId!, "u2")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await asUser(
			"u1",
			call((c) => c.getLive(personalId!, "u1")),
		);
		expect(await testDb.select().from(adminAudit)).toHaveLength(before);
	});
});

describe("anamnesis integrity versioning (T-138)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Consultations | Integrity, never>;
	let testDb: ReturnType<typeof makeDb>;

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Consultations | Integrity>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Consultations, f);

	const versionsOf = (consultationId: number) =>
		runtime.runPromise(
			Effect.flatMap(Integrity, (i) => i.versions("consultation.anamnesis", consultationId)),
		);

	const integrityColumns = async (consultationId: number) => {
		const rows = await testDb
			.select({
				hash: consultationsTable.anamnesisHash,
				version: consultationsTable.anamnesisVersion,
				blob: consultationsTable.blobHash,
			})
			.from(consultationsTable)
			.where(eq(consultationsTable.id, consultationId));
		return rows[0]!;
	};

	beforeAll(() => {
		testDb = makeDb(makeD1(DDL));
		runtime = ManagedRuntime.make(ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb))));
	});

	afterAll(() => runtime.dispose());

	const saveInput = (over: Partial<SaveConsultationInput> = {}): SaveConsultationInput => ({
		transcript: "t",
		anamnesis: { marker: Math.random() } as unknown as SaveConsultationInput["anamnesis"],
		engine: "e",
		...over,
	});

	it("save mints version 1 and stamps the integrity columns", async () => {
		const saved = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput())),
		);
		const versions = await versionsOf(saved.id);
		expect(versions).toHaveLength(1);
		expect(versions[0]!.version).toBe(1);
		expect(versions[0]!.prevHash).toBeNull();
		expect(versions[0]!.signature).toBeNull();
		expect(versions[0]!.actorUserId).toBe("u1");
		const cols = await integrityColumns(saved.id);
		expect(cols.version).toBe(1);
		expect(cols.hash).toBe(versions[0]!.contentHash);
		expect(cols.blob).toBe(versions[0]!.blobHash);
	});

	it("attachAnamnesis appends a chained version per write", async () => {
		const saved = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput())),
		);
		await asUser(
			"u1",
			call((c) =>
				c.attachAnamnesis("u1", {
					consultationId: saved.id,
					anamnesis: {} as SaveConsultationInput["anamnesis"],
					engine: "e2",
				}),
			),
		);
		const versions = await versionsOf(saved.id);
		expect(versions.map((v) => v.version)).toEqual([1, 2]);
		expect(versions[1]!.prevHash).toBe(versions[0]!.contentHash);
		expect(versions[1]!.engine).toBe("e2");
		const cols = await integrityColumns(saved.id);
		expect(cols.version).toBe(2);
		expect(cols.hash).toBe(versions[1]!.contentHash);
	});

	it("attach on a pre-versioning row seeds the stored anamnesis as v1 first", async () => {
		// Simulate a row written before integrity columns existed.
		const id = await createConsultation(testDb, { userId: "u1", source: "browser" });
		const legacyPayload = JSON.stringify({ legacy: true });
		await testDb
			.update(consultationsTable)
			.set({ anamnesis: legacyPayload })
			.where(eq(consultationsTable.id, id!));

		await asUser(
			"u1",
			call((c) =>
				c.attachAnamnesis("u1", {
					consultationId: id!,
					anamnesis: {} as SaveConsultationInput["anamnesis"],
					engine: "e",
				}),
			),
		);
		const versions = await versionsOf(id!);
		expect(versions.map((v) => v.version)).toEqual([1, 2]);
		expect(versions[0]!.payload).toBe(legacyPayload);
		expect(versions[0]!.prevHash).toBeNull();
		expect(versions[1]!.prevHash).toBe(versions[0]!.contentHash);
		const cols = await integrityColumns(id!);
		expect(cols.version).toBe(2);
	});

	it("attach on a missing row mints no version", async () => {
		await asUser(
			"u1",
			call((c) =>
				c.attachAnamnesis("u1", {
					consultationId: 9999,
					anamnesis: {} as SaveConsultationInput["anamnesis"],
					engine: "e",
				}),
			),
		);
		expect(await versionsOf(9999)).toHaveLength(0);
	});

	it("adminBackfillVersions materializes v1 for legacy anamneses (admin only)", async () => {
		// Two legacy rows: one gets versioned by backfill, one already
		// has a version column set and is skipped.
		const legacyId = await createConsultation(testDb, { userId: "u1", source: "browser" });
		await testDb
			.update(consultationsTable)
			.set({ anamnesis: JSON.stringify({ old: "doc" }), engine: "old-engine" })
			.where(eq(consultationsTable.id, legacyId!));
		// A row with no anamnesis must never be backfilled.
		const emptyId = await createConsultation(testDb, { userId: "u1", source: "browser" });

		await expect(
			asUser(
				"u1",
				call((c) => c.adminBackfillVersions()),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});

		const result = await asUser(
			"u1",
			call((c) => c.adminBackfillVersions()),
			"admin@x.com",
		);
		expect(result.backfilled).toBeGreaterThanOrEqual(1);
		const versions = await versionsOf(legacyId!);
		expect(versions).toHaveLength(1);
		expect(versions[0]!.engine).toBe("old-engine");
		expect(versions[0]!.actorUserId).toBe("u1");
		expect(await versionsOf(emptyId!)).toHaveLength(0);
		const cols = await integrityColumns(legacyId!);
		expect(cols.version).toBe(1);

		// Second pass is a no-op — idempotent.
		const again = await asUser(
			"u1",
			call((c) => c.adminBackfillVersions()),
			"admin@x.com",
		);
		expect(again.backfilled).toBe(0);
		expect(again.remaining).toBe(0);
	});

	it("save still works with the integrity plugin absent", async () => {
		// The recordVersion helper resolves via serviceOption and must
		// degrade to null — the save itself is never blocked.
		const withoutIntegrity = ManagedRuntime.make(
			ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb, makeEventBus(), false))),
		);
		const saved = await withoutIntegrity.runPromise(
			Effect.provideService(
				call((c) => c.save("u1", saveInput())),
				Principal,
				{ userId: "u1" },
			),
		);
		expect(saved.id).toBeGreaterThan(0);
		const cols = await integrityColumns(saved.id);
		expect(cols.version).toBeNull();
		expect(cols.hash).toBeNull();
		await withoutIntegrity.dispose();
	});

	it("attachAnamnesis on a legacy row still succeeds without integrity", async () => {
		// Pre-versioning row: the seed path calls recordVersion, which
		// degrades to null when the integrity plugin is absent.
		const withoutIntegrity = ManagedRuntime.make(
			ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb, makeEventBus(), false))),
		);
		const id = await createConsultation(testDb, { userId: "u1", source: "browser" });
		await testDb
			.update(consultationsTable)
			.set({ anamnesis: JSON.stringify({ legacy: true }) })
			.where(eq(consultationsTable.id, id!));
		await withoutIntegrity.runPromise(
			Effect.provideService(
				call((c) =>
					c.attachAnamnesis("u1", {
						consultationId: id!,
						anamnesis: {} as SaveConsultationInput["anamnesis"],
						engine: "e",
					}),
				),
				Principal,
				{ userId: "u1" },
			),
		);
		expect(await versionsOf(id!)).toHaveLength(0);
		const cols = await integrityColumns(id!);
		expect(cols.version).toBeNull();
		await withoutIntegrity.dispose();
	});

	it("adminBackfillVersions is a no-op without integrity", async () => {
		// Legacy rows are scanned but recordVersion degrades to null —
		// nothing is materialized and remaining stays non-zero.
		const withoutIntegrity = ManagedRuntime.make(
			ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb, makeEventBus(), false))),
		);
		const legacyId = await createConsultation(testDb, { userId: "u1", source: "browser" });
		await testDb
			.update(consultationsTable)
			.set({ anamnesis: JSON.stringify({ old: "doc" }) })
			.where(eq(consultationsTable.id, legacyId!));
		const result = await withoutIntegrity.runPromise(
			Effect.provideService(
				call((c) => c.adminBackfillVersions()),
				Principal,
				{ userId: "u1", email: "admin@x.com" },
			),
		);
		expect(result.backfilled).toBe(0);
		expect(result.remaining).toBeGreaterThanOrEqual(1);
		expect(await versionsOf(legacyId!)).toHaveLength(0);
		await withoutIntegrity.dispose();
	});
});

describe("verifyIntegrity (T-139)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Consultations | Integrity, never>;
	let testDb: ReturnType<typeof makeDb>;

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Consultations | Integrity>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Consultations, f);

	beforeAll(() => {
		testDb = makeDb(makeD1(DDL));
		runtime = ManagedRuntime.make(ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb))));
	});

	afterAll(() => runtime.dispose());

	const saveInput = (): SaveConsultationInput => ({
		transcript: "t",
		anamnesis: { marker: Math.random() } as unknown as SaveConsultationInput["anamnesis"],
		engine: "e",
	});

	it("verifies a saved anamnesis (head matches the row columns)", async () => {
		const saved = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput())),
		);
		const report = await asUser(
			"u1",
			call((c) => c.verifyIntegrity(saved.id, "u1")),
		);
		expect(report).not.toBeNull();
		expect(report!.status).toBe("verified");
		expect(report!.versions).toBe(1);
		expect(report!.storedVersion).toBe(1);
		expect(report!.head!.version).toBe(1);
	});

	it("flags a tampered stored version payload", async () => {
		const saved = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput())),
		);
		const versions = await runtime.runPromise(
			Effect.flatMap(Integrity, (i) => i.versions("consultation.anamnesis", saved.id)),
		);
		await testDb
			.update(recordVersions)
			.set({ payload: JSON.stringify({ forged: true }) })
			.where(eq(recordVersions.id, versions[0]!.id));
		const report = await asUser(
			"u1",
			call((c) => c.verifyIntegrity(saved.id, "u1")),
		);
		expect(report!.status).toBe("tampered");
		expect(report!.issues.map((i) => i.code)).toEqual(
			expect.arrayContaining(["blob-mismatch", "content-mismatch"]),
		);
	});

	it("flags a rewritten head pointer on the consultation row", async () => {
		const saved = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput())),
		);
		// An attacker rewrites the materialized columns — the chain head
		// no longer matches what the row claims.
		await testDb
			.update(consultationsTable)
			.set({ anamnesisHash: "ff".repeat(32) })
			.where(eq(consultationsTable.id, saved.id));
		const report = await asUser(
			"u1",
			call((c) => c.verifyIntegrity(saved.id, "u1")),
		);
		expect(report!.status).toBe("tampered");
		expect(report!.issues).toEqual([{ version: 1, code: "head-diverged" }]);
	});

	it("reports unversioned when no chain exists and null for a missing row", async () => {
		const id = await createConsultation(testDb, { userId: "u1", source: "browser" });
		const report = await asUser(
			"u1",
			call((c) => c.verifyIntegrity(id!, "u1")),
		);
		expect(report!.status).toBe("unversioned");
		expect(report!.storedVersion).toBeNull();
		expect(
			await asUser(
				"u1",
				call((c) => c.verifyIntegrity(424242, "u1")),
			),
		).toBeNull();
	});

	it("is Forbidden for a foreign owner and degrades without the plugin", async () => {
		const saved = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput())),
		);
		await expect(
			asUser(
				"u2",
				call((c) => c.verifyIntegrity(saved.id, "u2")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });

		const withoutIntegrity = ManagedRuntime.make(
			ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb, makeEventBus(), false))),
		);
		const report = await withoutIntegrity.runPromise(
			Effect.provideService(
				call((c) => c.verifyIntegrity(saved.id, "u1")),
				Principal,
				{
					userId: "u1",
				},
			),
		);
		expect(report!.status).toBe("unversioned");
		await withoutIntegrity.dispose();
	});
});

describe("audio pipeline", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Consultations, never>;
	let testDb: ReturnType<typeof makeDb>;

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Consultations>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Consultations, f);

	beforeAll(() => {
		testDb = makeDb(makeD1(DDL));
		runtime = ManagedRuntime.make(ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb))));
	});

	afterAll(() => runtime.dispose());

	it("module helpers walk the job lifecycle", async () => {
		const id = (await createConsultation(testDb, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(testDb, id, {
			audioKey: "audio/u1/1/x.webm",
			contentType: "audio/webm",
			size: 10,
		});
		expect(await audioJobRecord(testDb, id)).toEqual({
			audioKey: "audio/u1/1/x.webm",
			audioStatus: "stored",
			userId: "u1",
			tenantId: null,
		});
		await markAudioQueued(testDb, id);
		await beginAudioJob(testDb, id);
		await completeAudioJob(testDb, id, "server text");
		await saveCorrectedTranscript(testDb, id, "corrected text", "anthropic");
		const row = await testDb.query.consultations.findFirst({
			where: (t, { eq }) => eq(t.id, id),
		});
		expect(row).toMatchObject({
			audioStatus: "done",
			serverTranscript: "server text",
			correctedTranscript: "corrected text",
			enhancementEngine: "anthropic",
		});
	});

	it("failAudioJob records the reason", async () => {
		const id = (await createConsultation(testDb, { userId: "u1", source: "browser" }))!;
		await failAudioJob(testDb, id, "too large");
		const row = await testDb.query.consultations.findFirst({
			where: (t, { eq }) => eq(t.id, id),
		});
		expect(row?.audioStatus).toBe("failed");
		expect(row?.audioError).toBe("too large");
	});

	it("attachAudio/updateAudioStatus enforce ownership", async () => {
		const id = (await createConsultation(testDb, { userId: "u1", source: "browser" }))!;
		await asUser(
			"u1",
			call((c) => c.attachAudio("u1", { consultationId: id, audioKey: "k", size: 1 })),
		);
		await asUser(
			"u1",
			call((c) => c.updateAudioStatus("u1", id, "queued")),
		);
		const row = await audioJobRecord(testDb, id);
		expect(row?.audioStatus).toBe("queued");
		await expect(
			asUser(
				"u2",
				call((c) => c.attachAudio("u2", { consultationId: id, audioKey: "k2" })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u2",
				call((c) => c.updateAudioStatus("u2", id, "queued")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("audioJobsStream replays the projection then emits live deltas", async () => {
		const id = (await createConsultation(testDb, { userId: "u1", source: "browser" }))!;
		// Filtered take(1): skips the "none" backlog row for this
		// consultation, then waits for the live delta attachAudio publishes.
		const collect = asUser(
			"u1",
			call((c) =>
				c.audioJobsStream().pipe(
					Stream.filter((r) => r.id === id && r.audioStatus === "stored"),
					Stream.take(1),
					Stream.runCollect,
				),
			),
			"admin@x.com",
		);
		// Let the stream drain its backlog and subscribe to the PubSub
		// before the event fires — publishes before that are not replayed.
		await new Promise((r) => setTimeout(r, 100));
		await asUser(
			"u1",
			call((c) => c.attachAudio("u1", { consultationId: id, audioKey: "k-stream", size: 1 })),
		);
		const rows = await collect;
		expect(rows[0]?.audioStatus).toBe("stored");
		expect(rows[0]?.id).toBe(id);
	});

	it("audioJobsStream fails Forbidden for non-admin principals", async () => {
		await expect(
			asUser(
				"u1",
				call((c) => Stream.runCollect(c.audioJobsStream())),
				"other@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				null,
				call((c) => Stream.runCollect(c.audioJobsStream())),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("adminAudioJobs lists the projection for admins and denies others", async () => {
		const id = (await createConsultation(testDb, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(testDb, id, { audioKey: "k-admin-jobs", size: 1 });
		const rows = await asUser(
			"u1",
			call((c) => c.adminAudioJobs()),
			"admin@x.com",
		);
		expect(rows.find((r) => r.id === id)?.audioStatus).toBe("stored");
		await expect(
			asUser(
				"u1",
				call((c) => c.adminAudioJobs()),
				"other@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				null,
				call((c) => c.adminAudioJobs()),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("adminAudioJob returns the retry record and denies non-admins", async () => {
		const id = (await createConsultation(testDb, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(testDb, id, { audioKey: "k-retry", size: 1 });
		await failAudioJob(testDb, id, "boom");
		const record = await asUser(
			"u1",
			call((c) => c.adminAudioJob(id)),
			"admin@x.com",
		);
		expect(record).toMatchObject({
			audioKey: "k-retry",
			audioStatus: "failed",
			userId: "u1",
		});
		expect(
			await asUser(
				"u1",
				call((c) => c.adminAudioJob(424242)),
				"admin@x.com",
			),
		).toBeNull();
		await expect(
			asUser(
				"u1",
				call((c) => c.adminAudioJob(id)),
				"other@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("adminRequeueAudio flips retryable rows to queued and publishes the event", async () => {
		// Explicit bus so the test can subscribe to the same instance the
		// service layer dispatches on (same pattern as the tenant suite).
		const busRuntime = ManagedRuntime.make(makeEventBus());
		const bus = await busRuntime.runPromise(EventBus);
		const rt = ManagedRuntime.make(
			ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb, Layer.succeed(EventBus, bus)))),
		);
		const seen: { consultationId: number; audioStatus: string; tenantId?: number | null }[] = [];
		await Effect.runPromise(
			bus.subscribe(ConsultationAudioUpdated, (e) =>
				Effect.sync(() => {
					seen.push({
						consultationId: e.consultationId,
						audioStatus: e.audioStatus,
						tenantId: e.tenantId,
					});
				}),
			),
		);
		const asAdmin = <A, E>(effect: Effect.Effect<A, E, Consultations>) =>
			rt.runPromise(
				Effect.provideService(effect, Principal, { userId: "u1", email: "admin@x.com" }),
			);
		try {
			const id = (await createConsultation(testDb, { userId: "u1", source: "browser" }))!;
			await attachAudioRecord(testDb, id, { audioKey: "k-requeue", size: 1 });
			await failAudioJob(testDb, id, "boom");
			const ok = await asAdmin(Effect.flatMap(Consultations, (c) => c.adminRequeueAudio(id)));
			expect(ok).toBe(true);
			const row = await audioJobRecord(testDb, id);
			expect(row?.audioStatus).toBe("queued");
			const full = await testDb.query.consultations.findFirst({
				where: (t, { eq }) => eq(t.id, id),
			});
			expect(full?.audioError).toBeNull();
			expect(seen).toContainEqual({ consultationId: id, audioStatus: "queued", tenantId: null });
			// T-037: the requeue is audited (this is the /platform/ops retry).
			const auditRows = await testDb.select().from(adminAudit);
			const entry = auditRows.find(
				(r) => r.action === "consultations.audio.requeue" && r.targetId === String(id),
			);
			expect(entry).toMatchObject({
				actorUserId: "u1",
				actorEmail: "admin@x.com",
				targetType: "consultation",
			});
			// Second call: status already "queued" — not retryable → false.
			const again = await asAdmin(Effect.flatMap(Consultations, (c) => c.adminRequeueAudio(id)));
			expect(again).toBe(false);
			// Missing row → false; non-admin → Forbidden.
			expect(await asAdmin(Effect.flatMap(Consultations, (c) => c.adminRequeueAudio(424242)))).toBe(
				false,
			);
			await expect(
				rt.runPromise(
					Effect.provideService(
						Effect.flatMap(Consultations, (c) => c.adminRequeueAudio(id)),
						Principal,
						{ userId: "u1", email: "other@x.com" },
					),
				),
			).rejects.toMatchObject({ _tag: "Forbidden" });
		} finally {
			await rt.dispose();
			await busRuntime.dispose();
		}
	});
});

describe("Consultations.history", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Consultations, never>;
	let testDb: ReturnType<typeof makeDb>;
	let patientId = 0;
	let q4Id = 0;

	const asUser = <A, E>(userId: string | null, effect: Effect.Effect<A, E, Consultations>) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId }),
		);

	const sec = (content: string) => ({ content, confidence: "alta", evidence: [] });
	const doc = (qp: string, conduta: string) =>
		JSON.stringify({
			queixa_principal: sec(qp),
			hda: sec("h"),
			antecedentes: sec("a"),
			alergias: sec("al"),
			medicamentos_em_uso: sec("m"),
			exame_fisico: sec("e"),
			hipoteses: sec("hi"),
			conduta: sec(conduta),
		});

	const addConsultation = async (over: Partial<typeof consultationsTable.$inferInsert>) => {
		const rows = await testDb
			.insert(consultationsTable)
			.values({
				userId: "u1",
				transcript: "t",
				source: "browser",
				status: "done",
				createdAt: new Date(),
				...over,
			})
			.returning({ id: consultationsTable.id });
		return rows[0]!.id;
	};

	beforeAll(async () => {
		testDb = makeDb(makeD1(DDL));
		runtime = ManagedRuntime.make(ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb))));
		const [p] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Maria", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		patientId = p!.id;
		await grantPatientOwner(testDb, patientId, "u1");
		await testDb.insert(userTable).values({
			id: "u2",
			name: "Dr B",
			email: "b@x.com",
			emailVerified: false,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		// 4 done consultations → only the latest 3 summarized, count = 4
		for (const [i, qp] of ["Q1", "Q2", "Q3", "Q4"].entries()) {
			q4Id = await addConsultation({
				patientId,
				anamnesis: doc(qp, `C${i + 1}`),
				createdAt: new Date(2026, 0, i + 1),
			});
		}
		// excluded from history: live session, other user, other patient
		await addConsultation({ patientId, status: "live", anamnesis: doc("QL", "CL") });
		await addConsultation({
			patientId,
			userId: "u2",
			anamnesis: doc("QX", "CX"),
		});
		const [other] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Outra", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		await grantPatientOwner(testDb, other!.id, "u1");
		await addConsultation({ patientId: other!.id, anamnesis: doc("QO", "CO") });
	});

	afterAll(() => runtime.dispose());

	it("aggregates count + latest 3 visits with complaint and plan", async () => {
		const h = await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.history(patientId, "u1")),
		);
		expect(h?.count).toBe(4);
		expect(h?.visits).toHaveLength(3);
		// newest first
		expect(h?.visits[0]?.chiefComplaint).toBe("Q4");
		expect(h?.visits[0]?.plan).toBe("C4");
		expect(h?.visits.map((v) => v.chiefComplaint)).toEqual(["Q4", "Q3", "Q2"]);
		expect(h?.visits[0]?.date).toMatch(/^2026-01-04T/);
	});

	it("excludeId drops the consultation being viewed", async () => {
		const h = await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.history(patientId, "u1", q4Id)),
		);
		expect(h?.count).toBe(3);
		expect(h?.visits.map((v) => v.id)).not.toContain(q4Id);
		expect(h?.visits.map((v) => v.chiefComplaint)).toEqual(["Q3", "Q2", "Q1"]);
	});

	it("returns null for patients the caller does not own", async () => {
		const h = await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.history(99999, "u1")),
		);
		expect(h).toBeNull();
		// patient owned by u1 is invisible to u2
		const h2 = await asUser(
			"u2",
			Effect.flatMap(Consultations, (c) => c.history(patientId, "u2")),
		);
		expect(h2).toBeNull();
	});

	it("lists only the given patient's consultations, with patientId", async () => {
		const rows = await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.list("u1", patientId)),
		);
		// 4 done + 1 live for this patient; the other patient's and u2's are excluded
		expect(rows).toHaveLength(5);
		expect(rows.every((r) => r.patientId === patientId && r.patientName === "Maria")).toBe(true);
		const all = await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.list("u1")),
		);
		expect(all.length).toBeGreaterThan(rows.length);
	});

	it("denies history without a bound principal", async () => {
		await expect(
			asUser(
				null,
				Effect.flatMap(Consultations, (c) => c.history(patientId, "u1")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("nulls out missing anamnesis and pending placeholders", async () => {
		const [p2] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Sem docs", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		await grantPatientOwner(testDb, p2!.id, "u1");
		await addConsultation({ patientId: p2!.id }); // no anamnesis
		await addConsultation({
			patientId: p2!.id,
			anamnesis: doc("Q", "A preencher pelo médico: conduta."),
		});
		const h = await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.history(p2!.id, "u1")),
		);
		expect(h?.count).toBe(2);
		const bare = h?.visits.find((v) => v.chiefComplaint === null);
		expect(bare?.plan).toBeNull();
		const pending = h?.visits.find((v) => v.chiefComplaint === "Q");
		expect(pending?.plan).toBeNull();
	});

	it("treats malformed stored anamnesis JSON as absent", async () => {
		const [p3] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "JSON quebrado", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		await grantPatientOwner(testDb, p3!.id, "u1");
		await addConsultation({ patientId: p3!.id, anamnesis: "{not-json" });
		const h = await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.history(p3!.id, "u1")),
		);
		expect(h?.count).toBe(1);
		expect(h?.visits[0]?.chiefComplaint).toBeNull();
		expect(h?.visits[0]?.plan).toBeNull();
	});

	it("returns null when the owner tuple and owner_id disagree", async () => {
		// Divergent state (e.g. ownership transferred without dropping
		// the tuple): canReadPatientHistory admits via the tuple, then
		// patientHistoryRows' owner_id fence reports the patient as not
		// visible — null result, and no sensitive-read audit entry.
		const [p] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u2", name: "Divergente", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		await grantPatientOwner(testDb, p!.id, "u1");
		expect(
			await asUser(
				"u1",
				Effect.flatMap(Consultations, (c) => c.history(p!.id, "u1")),
			),
		).toBeNull();
		expect(
			await asUser(
				"u1",
				Effect.flatMap(Consultations, (c) => c.historyRows(p!.id, "u1")),
			),
		).toBeNull();
	});

	it("audits history reads on the patient target (P-086)", async () => {
		// Two fresh patients: identical `.read` emissions coalesce inside
		// Audit.record (P-087 D3), so each via gets its own target.
		const [p4] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Audit Hist", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		const [p5] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Audit Rows", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		await grantPatientOwner(testDb, p4!.id, "u1");
		await grantPatientOwner(testDb, p5!.id, "u1");
		await addConsultation({ patientId: p4!.id, anamnesis: doc("QA", "CA") });
		await addConsultation({ patientId: p5!.id, anamnesis: doc("QB", "CB") });
		await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.history(p4!.id, "u1")),
		);
		await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.historyRows(p5!.id, "u1")),
		);
		// A patient the caller cannot see is not a sensitive read — no entry.
		await asUser(
			"u1",
			Effect.flatMap(Consultations, (c) => c.history(99999, "u1")),
		);

		const rows = await testDb.select().from(adminAudit);
		const historyEntry = rows.find(
			(r) => r.action === "consultations.history.read" && r.targetId === String(p4!.id),
		);
		expect(historyEntry).toMatchObject({ targetType: "patient" });
		expect(historyEntry?.detail).toContain('"via":"history"');
		expect(historyEntry?.detail).toContain(`"patientId":${p4!.id}`);
		const rowsEntry = rows.find(
			(r) => r.action === "consultations.history.read" && r.targetId === String(p5!.id),
		);
		expect(rowsEntry).toMatchObject({ targetType: "patient" });
		expect(rowsEntry?.detail).toContain('"via":"history-rows"');
		expect(rowsEntry?.detail).toContain(`"patientId":${p5!.id}`);
		expect(
			(await testDb.select().from(adminAudit)).filter(
				(r) => r.action === "consultations.history.read" && r.targetId === "99999",
			),
		).toHaveLength(0);
	});

	it("patientHistory* return null for missing or foreign-owned patients", async () => {
		// anamnesis.ts owner fence: the patients.owner_id column decides —
		// a missing row and another doctor's patient both yield null.
		expect(await patientHistoryRows(testDb, 99999, "u1")).toBeNull();
		const [foreign] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u2", name: "De Outro", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		expect(await patientHistoryRows(testDb, foreign!.id, "u1")).toBeNull();
		expect(await patientHistory(testDb, foreign!.id, "u1")).toBeNull();
		expect(await patientHistory(testDb, 99999, "u1")).toBeNull();
	});

	it("deletePatientConsultations no-ops when the resolved rows are already gone", async () => {
		const [p] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Cascade Retry", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		const id = (await createConsultation(testDb, { userId: "u1", source: "browser" }))!;
		await testDb
			.update(consultationsTable)
			.set({ patientId: p!.id })
			.where(eq(consultationsTable.id, id));
		await deletePatientConsultations(testDb, p!.id, [id]);
		expect(
			await testDb
				.select({ id: consultationsTable.id })
				.from(consultationsTable)
				.where(eq(consultationsTable.id, id)),
		).toHaveLength(0);
		// A retried cascade (or a concurrent delete) re-resolves the same
		// ids but finds the rows already gone — the doomed scan comes
		// back empty and the helper must return without touching tuples.
		await deletePatientConsultations(testDb, p!.id, [id]);
	});
});

describe("patientId ownership on save/attach", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Consultations, never>;
	let testDb: ReturnType<typeof makeDb>;
	let ownPatient = 0;
	let foreignPatient = 0;

	const asUser = <A, E>(userId: string | null, effect: Effect.Effect<A, E, Consultations>) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId }),
		);
	const call = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Consultations, f);
	const saveInput = (over: Partial<SaveConsultationInput> = {}): SaveConsultationInput => ({
		transcript: "t",
		anamnesis: {} as SaveConsultationInput["anamnesis"],
		engine: "e",
		...over,
	});
	const attachInput = (
		over: Partial<Parameters<Consultations["Service"]["attachAnamnesis"]>[1]> = {},
	) => ({
		consultationId: 0,
		anamnesis: {} as SaveConsultationInput["anamnesis"],
		engine: "e",
		...over,
	});
	const linkedPatientId = async (id: number) =>
		(
			await testDb.query.consultations.findFirst({
				where: (t, { eq }) => eq(t.id, id),
			})
		)?.patientId;

	beforeAll(async () => {
		testDb = makeDb(makeD1(DDL));
		runtime = ManagedRuntime.make(ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb))));
		await testDb.insert(userTable).values({
			id: "u2",
			name: "Dr B",
			email: "b@x.com",
			emailVerified: false,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		const [own] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Own", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		const [foreign] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u2", name: "Foreign", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		ownPatient = own!.id;
		foreignPatient = foreign!.id;
		await grantPatientOwner(testDb, ownPatient, "u1");
		await grantPatientOwner(testDb, foreignPatient, "u2");
	});

	afterAll(() => runtime.dispose());

	it("save rejects a patientId the caller does not own", async () => {
		await expect(
			asUser(
				"u1",
				call((c) => c.save("u1", saveInput({ patientId: foreignPatient }))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		// Missing patient ids are denied the same way — no existence probe.
		await expect(
			asUser(
				"u1",
				call((c) => c.save("u1", saveInput({ patientId: 999_999 }))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		// Own patient links fine; omitted patientId still works.
		const saved = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput({ patientId: ownPatient }))),
		);
		expect(await linkedPatientId(saved.id)).toBe(ownPatient);
		const bare = await asUser(
			"u1",
			call((c) => c.save("u1", saveInput())),
		);
		expect(await linkedPatientId(bare.id)).toBeNull();
	});

	it("attachAnamnesis rejects foreign patientId and keeps tri-state semantics", async () => {
		const id = (await asUser(
			"u1",
			call((c) => c.create({ userId: "u1", transcript: "t", source: "browser" })),
		))!;

		// Foreign patient → Forbidden, link untouched.
		await expect(
			asUser(
				"u1",
				call((c) =>
					c.attachAnamnesis("u1", attachInput({ consultationId: id, patientId: foreignPatient })),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		expect(await linkedPatientId(id)).toBeNull();

		// Own patient links.
		await asUser(
			"u1",
			call((c) =>
				c.attachAnamnesis("u1", attachInput({ consultationId: id, patientId: ownPatient })),
			),
		);
		expect(await linkedPatientId(id)).toBe(ownPatient);

		// undefined keeps the existing link.
		await asUser(
			"u1",
			call((c) => c.attachAnamnesis("u1", attachInput({ consultationId: id }))),
		);
		expect(await linkedPatientId(id)).toBe(ownPatient);

		// null clears it.
		await asUser(
			"u1",
			call((c) => c.attachAnamnesis("u1", attachInput({ consultationId: id, patientId: null }))),
		);
		expect(await linkedPatientId(id)).toBeNull();
	});
});

describe("consultations.audioJobs query", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Query.Registered<typeof ConsultationsQueries>, never>;
	let testDb: ReturnType<typeof makeDb>;

	const dispatch = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Query.Registered<typeof ConsultationsQueries>>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const audioJobs = (userId: string | null, email?: string) =>
		dispatch(
			userId,
			Effect.scoped(
				Effect.gen(function* () {
					const queries = yield* Query.dispatcher(ConsultationsQueries);
					return yield* queries["consultations.audioJobs"]({});
				}),
			),
			email,
		);

	beforeAll(async () => {
		testDb = makeDb(makeD1(DDL));
		runtime = ManagedRuntime.make(
			ConsultationsQueriesLive.pipe(Layer.provideMerge(liveDeps(testDb))),
		) as ManagedRuntime.ManagedRuntime<Query.Registered<typeof ConsultationsQueries>, never>;
		const [p] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Jobs Paciente", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		const id = (await createConsultation(testDb, { userId: "u1", source: "browser" }))!;
		await testDb
			.update(consultationsTable)
			.set({
				patientId: p!.id,
				audioStatus: "processing",
				audioError: null,
			})
			.where(eq(consultationsTable.id, id));
	});

	afterAll(() => runtime.dispose());

	it("returns the minimal audio-job projection for an allowlisted admin", async () => {
		const rows = await audioJobs("u1", "admin@x.com");
		const row = rows.find((r) => r.audioStatus === "processing");
		expect(row).toBeDefined();
		expect(row).toMatchObject({ patientName: "Jobs Paciente", audioError: null });
		expect(row?.createdAt).toBeInstanceOf(Date);
	});

	it("fails Forbidden for non-admin, missing email and null principal", async () => {
		await expect(audioJobs("u1", "other@x.com")).rejects.toMatchObject({
			_tag: "Forbidden",
			path: "platform.admin",
		});
		await expect(audioJobs("u1")).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(audioJobs(null)).rejects.toMatchObject({ _tag: "Forbidden" });
	});
});

describe("plugins", () => {
	it("declares tables, services, routes, chrome and panel as single-concern plugins", () => {
		expect(consultationsTablesPlugin.id).toBe("consultations.tables");
		expect(consultationsTablesPlugin.tables?.consultations).toBeDefined();
		expect(consultationsServicesPlugin.id).toBe("consultations.services");
		expect(consultationsServicesPlugin.services).toBeDefined();
		expect(consultationsServicesPlugin.requiredDeps).toEqual([
			patientsServicesPlugin.id,
			platformAdminPlugin.id,
		]);
		expect(consultationsChromePlugin.id).toBe("consultations.chrome");
		expect(consultationsChromePlugin.requiredDeps).toEqual([platformPanelPlugin.id]);
		expect(consultationsChromePlugin.chrome.map((c) => c.region)).toEqual([
			"portal.sidebar",
			"app.notFound.actions",
			"app.error.actions",
			"portal.dashboard.stats",
			"portal.dashboard.sections",
		]);
		expect(consultationsPanelPlugin.id).toBe("consultations.panel");
		expect(consultationsPanelPlugin.requiredDeps).toEqual([platformPanelPlugin.id]);
		expect(consultationsPanelPlugin.panel?.pages?.[0]?.path).toBe("/platform/consultations");
	});

	it("declares the /consultations route subtree", () => {
		expect(consultationsRoutesPlugin.id).toBe("consultations.routes");
		// P-033: the subtree is a physical() mount of this package's own
		// src/routes directory — resolved against the host routes dir.
		expect(JSON.stringify(consultationsRoutesPlugin.routes)).toContain(
			"plugins/consultations/src/routes",
		);
	});

	it("platform loader maps blank owner fields to an empty label", async () => {
		const loader = consultationsPanelPlugin.panel?.pages?.[0]?.loader;
		expect(loader).toBeDefined();
		const result = await Effect.runPromise(
			loader!().pipe(
				Effect.provideService(Consultations, {
					adminList: () => Effect.succeed([]),
					adminBackfillVersions: () => Effect.succeed({ backfilled: 0, remaining: 0 }),
				} as never),
				Effect.provideService(Patients, {
					adminOwners: () => Effect.succeed([]),
					adminList: () =>
						Effect.succeed([
							{ id: 1, name: "Pat", ownerId: "u9", ownerName: null, ownerEmail: null },
						] as never),
				} as never),
			),
		);
		expect(result).toEqual({
			consultations: [],
			owners: [],
			patients: [{ id: 1, name: "Pat", ownerId: "u9", ownerName: "" }],
		});
	});

	it("platform loader collapses Forbidden failures to empty tables", async () => {
		const loader = consultationsPanelPlugin.panel?.pages?.[0]?.loader;
		expect(loader).toBeDefined();
		const forbidden = () => Effect.fail(new Forbidden({ path: "platform.admin" }));
		const result = await Effect.runPromise(
			loader!().pipe(
				Effect.provideService(Consultations, {
					adminBackfillVersions: forbidden,
					adminList: forbidden,
				} as never),
				Effect.provideService(Patients, { adminOwners: forbidden, adminList: forbidden } as never),
			),
		);
		expect(result).toEqual({ consultations: [], owners: [], patients: [] });
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"consultations.tables",
			"consultations.services",
			"consultations.routes",
			"consultations.chrome",
			"consultations.panel",
		]);
	});
});

describe("ConsultationsLive tenant scope (P-053)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Consultations, never>;
	let busRuntime: ManagedRuntime.ManagedRuntime<EventBus, never>;
	let testDb: ReturnType<typeof makeDb>;
	let bus: EventBusShape;

	const TENANT_A: TenantScope = { id: 7, kind: "clinic", slug: "clinica-a", role: "member" };
	const TENANT_B: TenantScope = { id: 8, kind: "clinic", slug: "clinica-b", role: "member" };
	const TENANT_ZK: TenantScope = { id: 9, kind: "clinic", slug: "clinica-zk", role: "member" };

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Consultations>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const asTenant = <A, E>(
		userId: string,
		tenant: TenantScope,
		effect: Effect.Effect<A, E, Consultations>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(
				Effect.provideService(effect, Principal, { userId, email }),
				Tenant,
				tenant,
			),
		);

	const call = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Consultations, f);

	const saveInput = (over: Partial<SaveConsultationInput> = {}): SaveConsultationInput => ({
		transcript: "t",
		anamnesis: {} as SaveConsultationInput["anamnesis"],
		engine: "e",
		...over,
	});

	const tenantIdOf = async (id: number) => {
		const rows = await testDb
			.select({ tenantId: consultationsTable.tenantId })
			.from(consultationsTable)
			.where(eq(consultationsTable.id, id));
		return rows[0]?.tenantId ?? null;
	};

	beforeAll(async () => {
		testDb = makeDb(makeD1(DDL));
		// The shared DDL seeds only u1 — tenant-member scenarios need u2
		// (the consultations.user_id FK is enforced by better-sqlite3).
		await testDb.insert(userTable).values({
			id: "u2",
			name: "Dr B",
			email: "b@x.com",
			emailVerified: false,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		// Build the bus explicitly so tests can subscribe to the same
		// instance the service layer dispatches on.
		busRuntime = ManagedRuntime.make(makeEventBus());
		bus = await busRuntime.runPromise(EventBus);
		runtime = ManagedRuntime.make(
			ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb, Layer.succeed(EventBus, bus)))),
		);
	});

	afterAll(async () => {
		await runtime.dispose();
		await busRuntime.dispose();
	});

	it("create/save/adminCreate stamp tenant_id from the bound tenant", async () => {
		const id = await asTenant(
			"u1",
			TENANT_A,
			call((c) => c.create({ userId: "u1", source: "browser" })),
		);
		expect(await tenantIdOf(id!)).toBe(7);

		const saved = await asTenant(
			"u1",
			TENANT_A,
			call((c) => c.save("u1", saveInput())),
		);
		expect(await tenantIdOf(saved.id)).toBe(7);

		const admin = await asTenant(
			"u1",
			TENANT_A,
			call((c) => c.adminCreate({ userId: "u2", source: "manual" })),
			"admin@x.com",
		);
		expect(await tenantIdOf(admin!)).toBe(7);

		// Personal scope and non-numeric tenant ids both stamp NULL.
		const personal = await asUser(
			"u1",
			call((c) => c.create({ userId: "u1", source: "browser" })),
		);
		expect(await tenantIdOf(personal!)).toBeNull();
		const weird = await asTenant(
			"u1",
			Object.assign({}, TENANT_A, { id: "clinic-x" }),
			call((c) => c.create({ userId: "u1", source: "browser" })),
		);
		expect(await tenantIdOf(weird!)).toBeNull();
	});

	it("list shows tenant consultations to members and hides them from outsiders and personal scope", async () => {
		const t7 = await createConsultation(testDb, { userId: "u1", source: "browser" }, 7);
		const t8 = await createConsultation(testDb, { userId: "u1", source: "browser" }, 8);

		const member = await asTenant(
			"u2",
			TENANT_A,
			call((c) => c.list("u2")),
		);
		const memberIds = member.map((r) => r.id);
		expect(memberIds).toContain(t7);
		expect(memberIds).not.toContain(t8);

		// Personal scope: tenant rows are invisible even to their creator.
		const personal = await asUser(
			"u1",
			call((c) => c.list("u1")),
		);
		const personalIds = personal.map((r) => r.id);
		expect(personalIds).not.toContain(t7);
		expect(personalIds).not.toContain(t8);
	});

	it("get/getLive let tenant members read tenant rows; outsiders and personal-scope owners are Forbidden", async () => {
		const t7 = await createConsultation(
			testDb,
			{ userId: "u1", transcript: "shared", source: "mic", status: "live" },
			7,
		);

		const got = await asTenant(
			"u2",
			TENANT_A,
			call((c) => c.get(t7!, "u2")),
		);
		expect(got?.transcript).toBe("shared");
		const live = await asTenant(
			"u2",
			TENANT_A,
			call((c) => c.getLive(t7!, "u2")),
		);
		expect(live).toEqual({ transcript: "shared", status: "live" });

		// Member of a different tenant → Forbidden.
		await expect(
			asTenant(
				"u2",
				TENANT_B,
				call((c) => c.get(t7!, "u2")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "consultation.read" });
		// The creator in personal scope → Forbidden (strict tenant rows).
		await expect(
			asUser(
				"u1",
				call((c) => c.get(t7!, "u1")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		// Platform admin reads cross-tenant.
		const admin = await asTenant(
			"u1",
			TENANT_B,
			call((c) => c.get(t7!, "u1")),
			"admin@x.com",
		);
		expect(admin?.transcript).toBe("shared");
	});

	it("attachAnamnesis/recordConsent let tenant members update tenant rows", async () => {
		const t7 = await createConsultation(testDb, { userId: "u1", source: "mic" }, 7);
		const anamnesis = {} as SaveConsultationInput["anamnesis"];

		await asTenant(
			"u2",
			TENANT_A,
			call((c) => c.attachAnamnesis("u2", { consultationId: t7!, anamnesis, engine: "e" })),
		);
		await asTenant(
			"u2",
			TENANT_A,
			call((c) => c.recordConsent(t7!, "u2")),
		);
		const rows = await testDb
			.select({
				anamnesis: consultationsTable.anamnesis,
				consentAt: consultationsTable.consentAt,
			})
			.from(consultationsTable)
			.where(eq(consultationsTable.id, t7!));
		expect(rows[0]?.anamnesis).not.toBeNull();
		expect(rows[0]?.consentAt).toBeInstanceOf(Date);

		// Non-member → Forbidden on both paths.
		await expect(
			asTenant(
				"u2",
				TENANT_B,
				call((c) => c.attachAnamnesis("u2", { consultationId: t7!, anamnesis, engine: "e2" })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asTenant(
				"u2",
				TENANT_B,
				call((c) => c.recordConsent(t7!, "u2")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("attachAudio/updateAudioStatus stamp the row's tenant_id on audio events", async () => {
		const t7 = await createConsultation(testDb, { userId: "u1", source: "mic" }, 7);
		const seen: (number | null | undefined)[] = [];
		await Effect.runPromise(
			bus.subscribe(ConsultationAudioUpdated, (e) =>
				Effect.sync(() => {
					seen.push(e.tenantId);
				}),
			),
		);
		// Tenant member operates the shared row — both events carry tenant 7.
		await asTenant(
			"u2",
			TENANT_A,
			call((c) => c.attachAudio("u2", { consultationId: t7!, audioKey: "k-t", size: 1 })),
		);
		await asTenant(
			"u2",
			TENANT_A,
			call((c) => c.updateAudioStatus("u2", t7!, "queued")),
		);
		expect(seen).toEqual([7, 7]);
	});

	it("save links tenant patients for members and rejects non-members", async () => {
		const patient = (
			await testDb
				.insert(patientsTable)
				.values({ ownerId: "u1", name: "Tenant Patient", tenantId: 7, createdAt: new Date() })
				.returning({ id: patientsTable.id })
		)[0]!;

		// Member of tenant 7 links the shared patient; the consultation
		// is stamped with the bound tenant.
		const saved = await asTenant(
			"u2",
			TENANT_A,
			call((c) => c.save("u2", saveInput({ patientId: patient.id }))),
		);
		expect(await tenantIdOf(saved.id)).toBe(7);

		// Member of another tenant → Forbidden (can't probe patient ids).
		await expect(
			asTenant(
				"u2",
				TENANT_B,
				call((c) => c.save("u2", saveInput({ patientId: patient.id }))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.read" });

		// The patient's owner in personal scope → Forbidden: tenant
		// patients need tenant context to link.
		await expect(
			asUser(
				"u1",
				call((c) => c.save("u1", saveInput({ patientId: patient.id }))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	// ---------- T-145: ZK cipher gates ----------

	const ENV = "v1.aXYtLmN0";
	const ENV2 = "v1.YW5hbS5jdA";
	const VERSION = { contentHash: "sha256:client-hash", signature: "sig-1" };

	it("save fails closed: plaintext under zk and envelopes outside zk", async () => {
		// Plaintext transcript/anamnesis under the ZK tenant → Forbidden.
		await expect(
			asTenant(
				"u1",
				TENANT_ZK,
				call((c) => c.save("u1", saveInput())),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "consultation.create" });

		// Envelope write under ZK succeeds — stored verbatim, with the
		// client-signed version landing on record_versions.
		const saved = await asTenant(
			"u1",
			TENANT_ZK,
			call((c) => c.save("u1", saveInput({ transcript: ENV, anamnesis: ENV2, version: VERSION }))),
		);
		expect(await tenantIdOf(saved.id)).toBe(9);
		const stored = await testDb
			.select()
			.from(consultationsTable)
			.where(eq(consultationsTable.id, saved.id));
		expect(stored[0]?.transcript).toBe(ENV);
		expect(stored[0]?.anamnesis).toBe(ENV2);
		const versions = await testDb
			.select()
			.from(recordVersions)
			.where(
				and(
					eq(recordVersions.entityType, "consultation.anamnesis"),
					eq(recordVersions.entityId, String(saved.id)),
				),
			);
		expect(versions).toHaveLength(1);
		expect(versions[0]?.contentHash).toBe(VERSION.contentHash);
		expect(versions[0]?.signature).toBe(VERSION.signature);

		// Same envelopes under a plaintext tenant and in personal scope
		// are rejected — ciphertext needs a clinic keyring.
		await expect(
			asTenant(
				"u1",
				TENANT_A,
				call((c) => c.save("u1", saveInput({ transcript: ENV, anamnesis: ENV2 }))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "consultation.create" });
		await expect(
			asUser(
				"u1",
				call((c) => c.save("u1", saveInput({ transcript: ENV, anamnesis: ENV2 }))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("create under zk rejects a populated plaintext transcript but allows the empty live form", async () => {
		await expect(
			asTenant(
				"u1",
				TENANT_ZK,
				call((c) => c.create({ userId: "u1", transcript: "plaintext live", source: "browser" })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "consultation.create" });
		const live = await asTenant(
			"u1",
			TENANT_ZK,
			call((c) => c.create({ userId: "u1", source: "browser", status: "live" })),
		);
		expect(live).not.toBeNull();
	});

	it("attachAnamnesis under zk stores envelopes with the client signature and rejects plaintext", async () => {
		const saved = await asTenant(
			"u1",
			TENANT_ZK,
			call((c) => c.save("u1", saveInput({ transcript: ENV, anamnesis: ENV2 }))),
		);
		await expect(
			asTenant(
				"u1",
				TENANT_ZK,
				call((c) =>
					c.attachAnamnesis("u1", {
						consultationId: saved.id,
						anamnesis: {} as SaveConsultationInput["anamnesis"],
						engine: "e",
					}),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "consultation.update" });
		await asTenant(
			"u1",
			TENANT_ZK,
			call((c) =>
				c.attachAnamnesis("u1", {
					consultationId: saved.id,
					anamnesis: "v1.bmV3LWVuYQ",
					engine: "heuristic",
					version: { contentHash: "sha256:v2", signature: "sig-2" },
				}),
			),
		);
		const stored = await testDb
			.select({ anamnesis: consultationsTable.anamnesis })
			.from(consultationsTable)
			.where(eq(consultationsTable.id, saved.id));
		expect(stored[0]?.anamnesis).toBe("v1.bmV3LWVuYQ");
		const v2 = await testDb
			.select()
			.from(recordVersions)
			.where(
				and(
					eq(recordVersions.entityType, "consultation.anamnesis"),
					eq(recordVersions.entityId, String(saved.id)),
					eq(recordVersions.version, 2),
				),
			);
		expect(v2[0]?.contentHash).toBe("sha256:v2");
		expect(v2[0]?.signature).toBe("sig-2");
	});

	it("list keeps envelope rows opaque — hasAnamnesis set, chiefComplaint null", async () => {
		await asTenant(
			"u1",
			TENANT_ZK,
			call((c) => c.save("u1", saveInput({ transcript: ENV, anamnesis: ENV2 }))),
		);
		const rows = await asTenant(
			"u1",
			TENANT_ZK,
			call((c) => c.list("u1")),
		);
		const env = rows.find((r) => r.hasAnamnesis);
		expect(env).toBeDefined();
		expect(env?.chiefComplaint).toBeNull();
		expect(env?.anamnesis).toBe(ENV2);
	});

	it("historyRows returns the raw envelopes for client-side decryption", async () => {
		const patient = (
			await testDb
				.insert(patientsTable)
				.values({ ownerId: "u1", name: "ZK Patient", createdAt: new Date() })
				.returning({ id: patientsTable.id })
		)[0]!;
		await grantPatientOwner(testDb, patient.id, "u1");
		const saved = await asTenant(
			"u1",
			TENANT_ZK,
			call((c) =>
				c.save("u1", saveInput({ transcript: ENV, anamnesis: ENV2, patientId: patient.id })),
			),
		);
		const history = await asTenant(
			"u1",
			TENANT_ZK,
			call((c) => c.historyRows(patient.id, "u1")),
		);
		expect(history?.rows[0]?.id).toBe(saved.id);
		expect(history?.rows[0]?.anamnesis).toBe(ENV2);
		// Scoping to another owner fails Forbidden (same gate as
		// `history`); a patient the caller does not own yields null.
		await expect(
			asTenant(
				"u1",
				TENANT_ZK,
				call((c) => c.historyRows(patient.id, "u2")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "consultation.read" });
		await expect(
			asTenant(
				"u1",
				TENANT_ZK,
				call((c) => c.historyRows(999_999, "u1")),
			),
		).resolves.toBeNull();
	});

	it("system transcript paths no-op on zk rows", async () => {
		const saved = await asTenant(
			"u1",
			TENANT_ZK,
			call((c) => c.save("u1", saveInput({ transcript: ENV, anamnesis: ENV2 }))),
		);
		// Whisper pipeline + LLM-cleaned transcript + live append all
		// refuse plaintext persistence on a zk-owned row.
		await appendTranscript(testDb, saved.id, "server asr text");
		await completeAudioJob(testDb, saved.id, "server asr text");
		await saveCorrectedTranscript(testDb, saved.id, "server llm text", "llm");
		const stored = await testDb
			.select({
				transcript: consultationsTable.transcript,
				serverTranscript: consultationsTable.serverTranscript,
				correctedTranscript: consultationsTable.correctedTranscript,
			})
			.from(consultationsTable)
			.where(eq(consultationsTable.id, saved.id));
		expect(stored[0]?.transcript).toBe(ENV);
		expect(stored[0]?.serverTranscript).toBeNull();
		expect(stored[0]?.correctedTranscript).toBeNull();
	});

	it("get returns the envelope via anamnesisRaw with a null parsed anamnesis", async () => {
		const saved = await asTenant(
			"u1",
			TENANT_ZK,
			call((c) => c.save("u1", saveInput({ transcript: ENV, anamnesis: ENV2 }))),
		);
		const detail = await asTenant(
			"u1",
			TENANT_ZK,
			call((c) => c.get(saved.id, "u1")),
		);
		expect(detail?.anamnesisRaw).toBe(ENV2);
		expect(detail?.anamnesis).toBeNull();
	});
});

describe("ConsultationsLive portal reads (T-141)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Consultations, never>;
	let testDb: ReturnType<typeof makeDb>;
	const allowed = new Set<number>();
	let ids: { p1: number; p2: number; ids: Record<string, number> };

	const accessLayer = Layer.succeed(PortalAccess, {
		link: (patientId: number) =>
			Effect.succeed(
				allowed.has(patientId) ? { patientId, name: "Paciente", relation: "self" as const } : null,
			),
		awaitingInvites: () => Effect.succeed(0),
	});

	beforeAll(async () => {
		testDb = makeDb(makeD1(DDL));
		runtime = ManagedRuntime.make(
			ConsultationsLive.pipe(Layer.provideMerge(Layer.mergeAll(liveDeps(testDb), accessLayer))),
		);
		const [p1] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "P1", createdAt: new Date(0) })
			.returning({ id: patientsTable.id });
		const [p2] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "P2", createdAt: new Date(0) })
			.returning({ id: patientsTable.id });
		const base = {
			userId: "u1",
			source: "browser",
			status: "done",
			transcript: "t",
		};
		const seed = async (key: string, values: Record<string, unknown>) => {
			const [row] = await testDb
				.insert(consultationsTable)
				.values({ ...base, ...values } as never)
				.returning({ id: consultationsTable.id });
			return row.id;
		};
		ids = {
			p1: p1!.id,
			p2: p2!.id,
			ids: {
				plain: await seed("plain", {
					patientId: p1!.id,
					anamnesis: "{}",
					createdAt: new Date(1000),
				}),
				zk: await seed("zk", {
					patientId: p1!.id,
					anamnesis: "v1.env",
					createdAt: new Date(2000),
				}),
				noAnamnesis: await seed("noAnamnesis", {
					patientId: p1!.id,
					anamnesis: null,
					createdAt: new Date(3000),
				}),
				other: await seed("other", {
					patientId: p2!.id,
					anamnesis: "{}",
					createdAt: new Date(4000),
				}),
				noPatient: await seed("noPatient", {
					patientId: null,
					anamnesis: "{}",
					tenantId: 7,
					createdAt: new Date(5000),
				}),
				scopeOnly: await seed("scopeOnly", {
					patientId: p1!.id,
					anamnesis: null,
					tenantId: 9,
					createdAt: new Date(6000),
				}),
			},
		};
	});

	afterAll(() => runtime.dispose());
	afterEach(() => allowed.clear());

	const run = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
		runtime.runPromise(Effect.flatMap(Consultations, f));

	it("portalList returns the patient's saved rows newest-first, link-gated", async () => {
		allowed.add(ids.p1);
		const rows = await run((c) => c.portalList(ids.p1));
		expect(rows.map((r) => r.id)).toEqual([ids.ids.zk, ids.ids.plain]);
		expect(rows[0]).toMatchObject({ anamnesis: "v1.env" });
		expect(await run((c) => c.portalList(ids.p2))).toEqual([]);
	});

	it("portalList is empty when the PortalAccess port is absent", async () => {
		const bare = ManagedRuntime.make(ConsultationsLive.pipe(Layer.provideMerge(liveDeps(testDb))));
		try {
			allowed.add(ids.p1);
			expect(
				await bare.runPromise(Effect.flatMap(Consultations, (c) => c.portalList(ids.p1))),
			).toEqual([]);
			expect(
				await bare.runPromise(Effect.flatMap(Consultations, (c) => c.portalGet(ids.ids.plain))),
			).toBeNull();
			expect(
				await bare.runPromise(Effect.flatMap(Consultations, (c) => c.portalScope(ids.ids.plain))),
			).toBeNull();
		} finally {
			await bare.dispose();
		}
	});

	it("portalGet returns the row for a linked patient and null otherwise", async () => {
		allowed.add(ids.p1);
		const row = await run((c) => c.portalGet(ids.ids.plain));
		expect(row).toMatchObject({
			id: ids.ids.plain,
			patientId: ids.p1,
			userId: "u1",
			anamnesis: "{}",
		});
		expect(row?.createdAt).toBeInstanceOf(Date);
		expect(await run((c) => c.portalGet(ids.ids.other))).toBeNull();
		expect(await run((c) => c.portalGet(ids.ids.noAnamnesis))).toBeNull();
		expect(await run((c) => c.portalGet(ids.ids.noPatient))).toBeNull();
		expect(await run((c) => c.portalGet(99999))).toBeNull();
	});

	it("portalScope returns patient + tenant for linked rows without requiring anamnesis", async () => {
		allowed.add(ids.p1);
		expect(await run((c) => c.portalScope(ids.ids.scopeOnly))).toEqual({
			patientId: ids.p1,
			tenantId: 9,
		});
		expect(await run((c) => c.portalScope(ids.ids.plain))).toEqual({
			patientId: ids.p1,
			tenantId: null,
		});
		expect(await run((c) => c.portalScope(ids.ids.noPatient))).toBeNull();
		expect(await run((c) => c.portalScope(ids.ids.other))).toBeNull();
		expect(await run((c) => c.portalScope(99999))).toBeNull();
	});
});

describe("ConsultationsLive without the Permissions port", () => {
	// T-182: record authz resolves owner tuples through @ktb/rbac's
	// Permissions service — when the rbac plugin isn't composed the
	// checks must fail closed (Forbidden), never allow.
	let runtime: ManagedRuntime.ManagedRuntime<Consultations, never>;
	let testDb: ReturnType<typeof makeDb>;
	let patientId = 0;

	const asUser = <A, E>(userId: string | null, effect: Effect.Effect<A, E, Consultations>) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId }),
		);
	const call = <A, E>(f: (c: Consultations["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Consultations, f);

	beforeAll(async () => {
		testDb = makeDb(makeD1(DDL));
		const infra = Layer.mergeAll(
			Layer.succeed(Db, testDb),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			makeEventBus(),
		);
		runtime = ManagedRuntime.make(
			ConsultationsLive.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						infra,
						Layer.mergeAll(PatientsQueriesLive, PatientsCommandsLive).pipe(Layer.provide(infra)),
					),
				),
			),
		);
		const [p] = await testDb
			.insert(patientsTable)
			.values({ ownerId: "u1", name: "Sem RBAC", createdAt: new Date() })
			.returning({ id: patientsTable.id });
		patientId = p!.id;
	});

	afterAll(() => runtime.dispose());

	it("create fails Forbidden when linking a personal patient", async () => {
		// patients.ownerOf resolves the row, but with no Permissions
		// service the owner-tuple check fails closed.
		await expect(
			asUser(
				"u1",
				call((c) => c.create({ userId: "u1", patientId, source: "browser" })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: `rbac.patient.${patientId}.owner` });
	});

	it("history and historyRows fail Forbidden instead of reporting null", async () => {
		// The absent port denies the patient fence outright — the
		// null-on-invisible contract only applies once the tuple check
		// can actually run.
		await expect(
			asUser(
				"u1",
				call((c) => c.history(patientId, "u1")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
			path: `rbac.patient.${patientId}.owner`,
		});
		await expect(
			asUser(
				"u1",
				call((c) => c.historyRows(patientId, "u1")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});
});
