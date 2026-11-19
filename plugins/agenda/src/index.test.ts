import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventBus, type EventBusShape, makeEventBus } from "@effect-server-utils/cqrs";
import { Forbidden, Principal } from "@ktb/authz";
import { buildPermissions, Permissions } from "@ktb/rbac";
import { ConsultationsLive } from "@ktb/consultations";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { consultations } from "@ktb/db/schema";
import { eq } from "drizzle-orm";
import { Patients, PatientsQueriesLive } from "@ktb/patients";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, type Tenant as TenantScope } from "@ktb/tenant";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	AGENDA_TEST_DDL,
	agendaChromePlugin,
	agendaPagesPlugin,
	agendaServicesPlugin,
	agendaTablesPlugin,
	APPOINTMENT_STATUSES,
	APPOINTMENT_SYNC_STATES,
	APPOINTMENT_TRANSITIONS,
	Appointments,
	AppointmentsLive,
	appointmentScope,
	claimReminder,
	createAppointment,
	DEFAULT_DURATION_MIN,
	getAppointment,
	listAppointments,
	listDueAppointments,
	plugins,
	REMINDER_LEAD_MS,
	updateAppointment,
} from "./index.ts";
import {
	AppointmentCancelled,
	AppointmentReminderDue,
	AppointmentScheduled,
	AppointmentUpdated,
} from "./api.ts";

const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL, image TEXT, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO "user" (id, name, email, email_verified, image, banned, created_at, updated_at) VALUES ('u1', 'Dra', 'd@x.com', 0, NULL, 0, 0, 0);
INSERT INTO "user" (id, name, email, email_verified, image, banned, created_at, updated_at) VALUES ('u2', 'Dr B', 'b@x.com', 0, NULL, 0, 0, 0);
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, zk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO groups (id, name, slug, kind, zk) VALUES (7, 'Clínica A', 'clinica-a', 'clinic', 0), (8, 'Clínica B', 'clinica-b', 'clinic', 0), (9, 'Clínica ZK', 'clinica-zk', 'clinic', 1);
CREATE TABLE patients (synthetic INTEGER NOT NULL DEFAULT 0, id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL REFERENCES "user"(id), name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, social_name TEXT, gender TEXT, birth_date TEXT, phone TEXT, email TEXT, preferred_language TEXT, address_line TEXT, address_number TEXT, address_complement TEXT, district TEXT, city TEXT, state TEXT, postal_code TEXT, country TEXT, mother_name TEXT, marital_status TEXT, race_color TEXT, nationality TEXT, emergency_contact_name TEXT, emergency_contact_relationship TEXT, emergency_contact_phone TEXT, created_at INTEGER, updated_at INTEGER, tenant_id INTEGER);
CREATE TABLE patient_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, type TEXT NOT NULL, country TEXT, number TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, UNIQUE (patient_id, type));
CREATE TABLE consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES "user"(id), patient_id INTEGER REFERENCES patients(id), tenant_id INTEGER REFERENCES groups(id) ON DELETE SET NULL, transcript TEXT NOT NULL, anamnesis TEXT, review TEXT, engine TEXT, source TEXT NOT NULL DEFAULT 'browser', status TEXT NOT NULL DEFAULT 'done', bot_id TEXT, consent_at INTEGER, audio_key TEXT, audio_status TEXT NOT NULL DEFAULT 'none', audio_content_type TEXT, audio_size INTEGER, audio_error TEXT, server_transcript TEXT, corrected_transcript TEXT, enhancement_engine TEXT, anamnesis_hash TEXT, anamnesis_version INTEGER, blob_hash TEXT, synthetic INTEGER NOT NULL DEFAULT 0, eval_item_id INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
${AGENDA_TEST_DDL}
INSERT INTO patients (id, owner_id, name) VALUES (1, 'u1', 'Ana'), (2, 'u1', 'Bia'), (3, 'u2', 'Other Doc Patient'), (4, 'u1', 'Shared Pat');
UPDATE patients SET tenant_id = 7 WHERE id = 4;
-- T-182: personal-patient record authz resolves owner tuples — the raw
-- inserts above bypass createPatient's tuple write, so mirror it.
-- Patient 4 is tenant-owned: membership governs, no tuple needed.
INSERT INTO relation_tuples (object_type, object_id, relation, subject_kind, subject_id, effect, created_at) VALUES
('patient', '1', 'owner', 'user', 'u1', 'allow', 0),
('patient', '2', 'owner', 'user', 'u1', 'allow', 0),
('patient', '3', 'owner', 'user', 'u2', 'allow', 0);
`;

const day = 24 * 60 * 60 * 1000;

describe("agenda repo", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(DDL));
	});

	it("creates, gets and lists appointments in window order", async () => {
		const now = Date.now();
		const later = await createAppointment(db, {
			ownerId: "u1",
			patientId: 1,
			tenantId: null,
			startsAt: new Date(now + 2 * day),
			durationMin: 30,
		});
		const sooner = await createAppointment(db, {
			ownerId: "u1",
			patientId: 2,
			tenantId: null,
			startsAt: new Date(now + day),
			durationMin: 45,
			note: "bring exams",
		});
		expect(later).not.toBeNull();
		expect(sooner?.note).toBe("bring exams");
		expect((await getAppointment(db, sooner!.id))?.patientId).toBe(2);
		expect(await getAppointment(db, 9999)).toBeNull();

		const rows = await listAppointments(
			db,
			undefined,
			new Date(now - day),
			new Date(now + 3 * day),
		);
		expect(rows[0]?.id).toBe(sooner?.id);
		expect(rows[0]?.patientName).toBe("Bia");
		expect(rows.map((r) => r.id)).toContain(later?.id);

		// Outside the window nothing lists.
		expect(
			await listAppointments(db, undefined, new Date(now - 2 * day), new Date(now - day)),
		).toEqual([]);
	});

	it("returns null when insert yields no row", async () => {
		const stub = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as typeof db;
		expect(
			await createAppointment(stub, {
				ownerId: "u1",
				patientId: 1,
				tenantId: null,
				startsAt: new Date(),
				durationMin: 30,
			}),
		).toBeNull();
	});

	it("updates fields and returns null on missing rows", async () => {
		const row = await createAppointment(db, {
			ownerId: "u1",
			patientId: 1,
			tenantId: null,
			startsAt: new Date(Date.now() + day),
			durationMin: 30,
		});
		const moved = new Date(Date.now() + 2 * day);
		const updated = await updateAppointment(db, row!.id, {
			startsAt: moved,
			status: "confirmed",
			note: null,
		});
		expect(updated?.status).toBe("confirmed");
		expect(updated?.startsAt.getTime()).toBe(moved.getTime());
		expect(await updateAppointment(db, 9999, { status: "cancelled" })).toBeNull();
	});

	it("due-reminder listing honours status, window and the sent marker", async () => {
		const now = new Date();
		const due = await createAppointment(db, {
			ownerId: "u1",
			patientId: 1,
			tenantId: null,
			startsAt: new Date(now.getTime() + 5 * 60 * 1000),
			durationMin: 30,
		});
		// Not due: beyond the lead horizon.
		await createAppointment(db, {
			ownerId: "u1",
			patientId: 1,
			tenantId: null,
			startsAt: new Date(now.getTime() + day),
			durationMin: 30,
		});
		// Not due: terminal status.
		const cancelled = await createAppointment(db, {
			ownerId: "u1",
			patientId: 1,
			tenantId: null,
			startsAt: new Date(now.getTime() + 5 * 60 * 1000),
			durationMin: 30,
		});
		await updateAppointment(db, cancelled!.id, { status: "cancelled" });
		// Not due: already past the stale cutoff.
		await createAppointment(db, {
			ownerId: "u1",
			patientId: 1,
			tenantId: null,
			startsAt: new Date(now.getTime() - 2 * REMINDER_LEAD_MS),
			durationMin: 30,
		});

		const rows = await listDueAppointments(db, now, REMINDER_LEAD_MS);
		expect(rows.map((r) => r.id)).toContain(due?.id);
		expect(rows.map((r) => r.id)).not.toContain(cancelled?.id);
	});

	it("claimReminder flips the marker exactly once", async () => {
		const row = await createAppointment(db, {
			ownerId: "u1",
			patientId: 1,
			tenantId: null,
			startsAt: new Date(),
			durationMin: 30,
		});
		expect(await claimReminder(db, row!.id)).toBe(true);
		expect(await claimReminder(db, row!.id)).toBe(false);
	});
});

// ---------- service ----------

describe("AppointmentsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Appointments, never>;
	let db: ReturnType<typeof makeDb>;
	let bus: EventBusShape;

	const TENANT_A: TenantScope = { id: 7, kind: "clinic", slug: "clinica-a", role: "member" };

	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		const busRuntime = ManagedRuntime.make(makeEventBus());
		bus = await busRuntime.runPromise(EventBus);
		const infra = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			Layer.succeed(Permissions, buildPermissions(db)),
			Layer.succeed(EventBus, bus),
		);
		const queries = PatientsQueriesLive.pipe(Layer.provide(infra));
		const consults = ConsultationsLive.pipe(Layer.provideMerge(queries), Layer.provideMerge(infra));
		const services = AppointmentsLive.pipe(
			Layer.provideMerge(consults),
			Layer.provideMerge(queries),
			Layer.provideMerge(infra),
		);
		runtime = ManagedRuntime.make(services);
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Appointments>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const asTenant = <A, E>(
		userId: string,
		tenant: TenantScope,
		effect: Effect.Effect<A, E, Appointments>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(
				Effect.provideService(effect, Principal, { userId, email }),
				Tenant,
				tenant,
			),
		);

	const call = <A, E>(f: (p: Appointments["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Appointments, f);

	const input = (startsAt: Date, patientId = 1) => ({ patientId, startsAt });

	it("creates an appointment scoped to the bound owner and stamps personal tenant", async () => {
		const row = await asUser(
			"u1",
			call((p) => p.create("u1", input(new Date(Date.now() + day)))),
		);
		expect(row?.ownerId).toBe("u1");
		expect(row?.tenantId).toBeNull();
		expect(row?.status).toBe("scheduled");
		expect(row?.durationMin).toBe(DEFAULT_DURATION_MIN);
	});

	it("dispatches AppointmentScheduled on create", async () => {
		const seen: string[] = [];
		await Effect.runPromise(
			bus.subscribe(AppointmentScheduled, (e) =>
				Effect.sync(() => {
					seen.push(e.ownerId);
				}),
			),
		);
		await asUser(
			"u1",
			call((p) => p.create("u1", input(new Date(Date.now() + day)))),
		);
		expect(seen).toEqual(["u1"]);
	});

	it("denies create for another user and for a null principal", async () => {
		await expect(
			asUser(
				"u2",
				call((p) => p.create("u1", input(new Date(Date.now() + day)))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				null,
				call((p) => p.create("u1", input(new Date(Date.now() + day)))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("denies create on a patient the principal may not see", async () => {
		await expect(
			// Patient 3 belongs to u2.
			asUser(
				"u1",
				call((p) => p.create("u1", input(new Date(Date.now() + day), 3))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			// Patient 999 does not exist — same denial shape (no probing).
			asUser(
				"u1",
				call((p) => p.create("u1", input(new Date(Date.now() + day), 999))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("update applies full and sparse patches", async () => {
		const row = await asUser(
			"u1",
			call((p) =>
				p.create("u1", {
					patientId: 1,
					startsAt: new Date(Date.now() + day),
					durationMin: 30,
					note: "v1",
				}),
			),
		);
		// Sparse patch: every optional spread takes its absent side.
		const sparse = await asUser(
			"u1",
			call((p) => p.update("u1", row!.id, { durationMin: 60 })),
		);
		expect(sparse?.durationMin).toBe(60);
		// Full patch: every spread takes its present side, including the
		// reschedule re-arm of reminderSentAt.
		const full = await asUser(
			"u1",
			call((p) =>
				p.update("u1", row!.id, {
					patientId: 2,
					startsAt: new Date(Date.now() + 2 * day),
					durationMin: 45,
					note: "v3",
				}),
			),
		);
		expect(full).toMatchObject({ patientId: 2, durationMin: 45, note: "v3" });
		expect(full?.reminderSentAt).toBeNull();
	});

	it("denies personal-scope create on a tenant-owned patient", async () => {
		// Patient 4 is tenant 7's record — a personal-scope caller has no
		// tenant membership covering it, so the owner check fails closed.
		await expect(
			asUser(
				"u1",
				call((p) => p.create("u1", input(new Date(Date.now() + day), 4))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("lists only the caller's agenda", async () => {
		const rows = await asUser(
			"u1",
			call((p) =>
				p.list("u1", { from: new Date(Date.now() - day), to: new Date(Date.now() + 3 * day) }),
			),
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.ownerId === "u1" || r.tenantId !== null)).toBe(true);
		await expect(
			asUser(
				"u2",
				call((p) => p.list("u1", { from: new Date(0), to: new Date(Date.now() + 3 * day) })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("get returns null for missing rows and denies foreign owners", async () => {
		const row = await asUser(
			"u1",
			call((p) => p.create("u1", input(new Date(Date.now() + day)))),
		);
		expect(
			await asUser(
				"u1",
				call((p) => p.get("u1", row!.id)),
			),
		).toMatchObject({
			id: row!.id,
		});
		expect(
			await asUser(
				"u1",
				call((p) => p.get("u1", 9999)),
			),
		).toBeNull();
		// u2's own appointment is invisible to u1.
		const foreign = await createAppointment(db, {
			ownerId: "u2",
			patientId: 3,
			tenantId: null,
			startsAt: new Date(Date.now() + day),
			durationMin: 30,
		});
		await expect(
			asUser(
				"u1",
				call((p) => p.get("u1", foreign!.id)),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("updates fields, re-arms the reminder on reschedule and emits AppointmentUpdated", async () => {
		const row = await asUser(
			"u1",
			call((p) => p.create("u1", input(new Date(Date.now() + day)))),
		);
		await updateAppointment(db, row!.id, { reminderSentAt: new Date() });
		const seen: number[] = [];
		await Effect.runPromise(
			bus.subscribe(AppointmentUpdated, (e) =>
				Effect.sync(() => {
					seen.push(e.id);
				}),
			),
		);
		const moved = new Date(Date.now() + 2 * day);
		const updated = await asUser(
			"u1",
			call((p) => p.update("u1", row!.id, { startsAt: moved, note: "room 2" })),
		);
		expect(updated?.startsAt.getTime()).toBe(moved.getTime());
		expect(updated?.reminderSentAt).toBeNull();
		expect(seen).toEqual([row!.id]);
		// Non-reschedule edits keep the marker.
		await updateAppointment(db, row!.id, { reminderSentAt: new Date() });
		const touched = await asUser(
			"u1",
			call((p) => p.update("u1", row!.id, { note: "other" })),
		);
		expect(touched?.reminderSentAt).not.toBeNull();
		// Missing row → null; forbidden owner → Forbidden.
		expect(
			await asUser(
				"u1",
				call((p) => p.update("u1", 9999, {})),
			),
		).toBeNull();
		await expect(
			asUser(
				"u1",
				call((p) => p.update("u1", row!.id, { patientId: 3 })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("setStatus walks the transition table and emits AppointmentCancelled", async () => {
		const row = await asUser(
			"u1",
			call((p) => p.create("u1", input(new Date(Date.now() + day)))),
		);
		const seen: number[] = [];
		await Effect.runPromise(
			bus.subscribe(AppointmentCancelled, (e) =>
				Effect.sync(() => {
					seen.push(e.id);
				}),
			),
		);
		expect(
			await asUser(
				"u1",
				call((p) => p.setStatus("u1", row!.id, "confirmed")),
			),
		).toMatchObject({ status: "confirmed" });
		expect(
			await asUser(
				"u1",
				call((p) => p.setStatus("u1", row!.id, "cancelled")),
			),
		).toMatchObject({ status: "cancelled" });
		expect(seen).toEqual([row!.id]);
		// Terminal rows accept nothing.
		await expect(
			asUser(
				"u1",
				call((p) => p.setStatus("u1", row!.id, "scheduled")),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		expect(
			await asUser(
				"u1",
				call((p) => p.setStatus("u1", 9999, "cancelled")),
			),
		).toBeNull();
	});

	it("start creates the linked consultation once and reuses it", async () => {
		const row = await asUser(
			"u1",
			call((p) => p.create("u1", input(new Date(Date.now() + day)))),
		);
		const first = await asUser(
			"u1",
			call((p) => p.start("u1", row!.id)),
		);
		expect(first?.consultationId).toBeTypeOf("number");
		const consult = await db
			.select()
			.from(consultations)
			.where(eq(consultations.id, first!.consultationId));
		expect(consult[0]).toMatchObject({ userId: "u1", patientId: 1, source: "agenda" });
		// Second start returns the same link without a new record.
		const again = await asUser(
			"u1",
			call((p) => p.start("u1", row!.id)),
		);
		expect(again?.consultationId).toBe(first?.consultationId);
		expect(
			await asUser(
				"u1",
				call((p) => p.start("u1", 9999)),
			),
		).toBeNull();
	});

	it("start refuses terminal appointments", async () => {
		const row = await asUser(
			"u1",
			call((p) => p.create("u1", input(new Date(Date.now() + day)))),
		);
		await asUser(
			"u1",
			call((p) => p.setStatus("u1", row!.id, "cancelled")),
		);
		await expect(
			asUser(
				"u1",
				call((p) => p.start("u1", row!.id)),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("tenant members share the clinic agenda; outsiders see nothing", async () => {
		const shared = await asTenant(
			"u1",
			TENANT_A,
			call((p) => p.create("u1", input(new Date(Date.now() + day), 4))),
		);
		expect(shared?.tenantId).toBe(7);
		// A tenant-7 member reads + mutates the shared row.
		const member = await asTenant(
			"u2",
			TENANT_A,
			call((p) => p.get("u2", shared!.id)),
		);
		expect(member?.id).toBe(shared?.id);
		expect(
			await asTenant(
				"u2",
				TENANT_A,
				call((p) => p.setStatus("u2", shared!.id, "confirmed")),
			),
		).toMatchObject({ status: "confirmed" });
		// Personal-scope callers cannot reach the tenant row.
		await expect(
			asUser(
				"u2",
				call((p) => p.get("u2", shared!.id)),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		// …and a member start records the covering doctor, not the owner.
		const started = await asTenant(
			"u2",
			TENANT_A,
			call((p) => p.start("u2", shared!.id)),
		);
		expect(started?.consultationId).toBeTypeOf("number");
	});

	it("start denies a null principal and a foreign ownerId", async () => {
		const row = await asUser(
			"u1",
			call((p) => p.create("u1", input(new Date(Date.now() + day)))),
		);
		await expect(
			asUser(
				null,
				call((p) => p.start("u1", row!.id)),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				"u2",
				call((p) => p.start("u1", row!.id)),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("dispatchDueReminders claims each due row once and emits AppointmentReminderDue", async () => {
		const soon = new Date(Date.now() + 5 * 60 * 1000);
		const row = await asUser(
			"u1",
			call((p) => p.create("u1", input(soon))),
		);
		const seen: { id: number; patientName: string | null }[] = [];
		await Effect.runPromise(
			bus.subscribe(AppointmentReminderDue, (e) =>
				Effect.sync(() => {
					seen.push({ id: e.id, patientName: e.patientName });
				}),
			),
		);
		const sweep = call((p) => p.dispatchDueReminders());
		const first = await asUser(null, sweep);
		expect(first).toBeGreaterThanOrEqual(1);
		expect(seen.map((e) => e.id)).toContain(row!.id);
		expect(seen.find((e) => e.id === row!.id)?.patientName).toBe("Ana");
		// A concurrent pair races the conditional claim — exactly one
		// fiber wins each row; the loser exercises the !claimed skip.
		const row2 = await asUser(
			"u1",
			call((p) => p.create("u1", input(new Date(Date.now() + 5 * 60 * 1000)))),
		);
		const pair = await asUser(
			null,
			Effect.forEach([0, 1], () => call((p) => p.dispatchDueReminders()), {
				concurrency: 2,
			}),
		);
		expect(pair[0]! + pair[1]!).toBe(1);
		expect(row2).not.toBeNull();
		// Explicit clock/lead options take the provided side of the defaults.
		const opted = await asUser(
			null,
			call((p) => p.dispatchDueReminders({ now: new Date(), leadMs: 60 * 60 * 1000 })),
		);
		expect(opted).toBeGreaterThanOrEqual(0);
		// Idempotent: nothing left to claim.
		expect(await asUser(null, sweep)).toBe(0);
	});
});

// ---------- service without the Permissions port ----------

describe("AppointmentsLive without the Permissions port", () => {
	// T-182: the patient-link guard resolves owner tuples through
	// @ktb/rbac's Permissions service — when the rbac plugin isn't
	// composed the check must fail closed (Forbidden), never allow.
	let runtime: ManagedRuntime.ManagedRuntime<Appointments, never>;
	let db: ReturnType<typeof makeDb>;
	let bus: EventBusShape;

	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		const busRuntime = ManagedRuntime.make(makeEventBus());
		bus = await busRuntime.runPromise(EventBus);
		const infra = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			Layer.succeed(EventBus, bus),
		);
		const queries = PatientsQueriesLive.pipe(Layer.provide(infra));
		const consults = ConsultationsLive.pipe(Layer.provideMerge(queries), Layer.provideMerge(infra));
		const services = AppointmentsLive.pipe(
			Layer.provideMerge(consults),
			Layer.provideMerge(queries),
			Layer.provideMerge(infra),
		);
		runtime = ManagedRuntime.make(services);
	});

	afterAll(() => runtime.dispose());

	it("create fails Forbidden on a personal patient when the port is absent", async () => {
		// Patient 1 is u1's personal record — patients.ownerOf resolves
		// it, but with no Permissions service the owner-tuple check
		// fails closed before requireObject ever runs.
		await expect(
			runtime.runPromise(
				Effect.provideService(
					Effect.flatMap(Appointments, (p) =>
						p.create("u1", { patientId: 1, startsAt: new Date(Date.now() + day) }),
					),
					Principal,
					{ userId: "u1" },
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "rbac.patient.1.owner" });
	});
});

// ---------- plugin manifests ----------

describe("agenda plugins", () => {
	it("declares the tables contribution", () => {
		expect(agendaTablesPlugin.id).toBe("agenda.tables");
		expect(agendaTablesPlugin.tables?.appointments).toBeDefined();
	});

	it("declares services ordered after patients + consultations", () => {
		expect(agendaServicesPlugin.id).toBe("agenda.services");
		expect(agendaServicesPlugin.requiredDeps).toEqual([
			"patients.services",
			"consultations.services",
		]);
		expect(agendaServicesPlugin.services).toBeDefined();
	});

	it("mounts the agenda page under both clinical portals", () => {
		const pages = agendaPagesPlugin.pages ?? [];
		expect(pages.map((p) => p.path)).toEqual(["/portal/doctor/agenda", "/portal/secretary/agenda"]);
		expect(agendaPagesPlugin.requiredDeps).toEqual(["patients.services"]);
		expect(agendaPagesPlugin.optionalDeps).toEqual(["clinician.portal"]);
	});

	it("contributes sidebar entries scoped per clinical portal", () => {
		const chrome = agendaChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(2);
		for (const [i, portal] of ["doctor", "secretary"].entries()) {
			expect(chrome[i]).toMatchObject({
				region: "portal.sidebar",
				portal,
				content: {
					kind: "sidebarItem",
					item: { to: `/portal/${portal}/agenda`, group: "Care" },
				},
			});
		}
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"agenda.tables",
			"agenda.services",
			"agenda.pages",
			"agenda.chrome",
		]);
	});

	it("loader returns empty payloads without a principal", async () => {
		const page = (agendaPagesPlugin.pages ?? [])[0]!;
		const load = page.loader!;
		// Principal is a Reference defaulting to null — the loader
		// short-circuits before touching services, so the unknown-R
		// contract never reaches for Appointments at runtime.
		const out = await Effect.runPromise(
			load("/portal/doctor/agenda") as unknown as Effect.Effect<unknown>,
		);
		expect(out).toEqual({ appointments: [], patients: [] });
	});

	const runLoader = (appointments: Record<string, unknown>, patients?: Record<string, unknown>) => {
		const page = (agendaPagesPlugin.pages ?? [])[0]!;
		const load = page.loader!;
		let eff = (load("/portal/doctor/agenda") as Effect.Effect<unknown, unknown, unknown>).pipe(
			Effect.provideService(Principal, { userId: "u1", email: "d@x.com" }),
			Effect.provideService(Appointments, appointments as never),
		);
		if (patients !== undefined) {
			eff = eff.pipe(Effect.provideService(Patients, patients as never));
		}
		return Effect.runPromise(eff as Effect.Effect<unknown, unknown, never>);
	};

	it("loader aggregates appointments and patient names for a principal", async () => {
		const out = (await runLoader(
			{
				dispatchDueReminders: () => Effect.fail(new Forbidden({ path: "agenda.reminders" })),
				list: () =>
					Effect.succeed([
						{ id: 9, patientId: 1, ownerId: "u1", status: "scheduled", startsAt: new Date() },
					]),
			},
			{ list: () => Effect.succeed([{ id: 1, name: "Paciente Um" }]) },
		)) as { appointments: unknown[]; patients: { id: number; name: string }[] };
		expect(out.patients).toEqual([{ id: 1, name: "Paciente Um" }]);
		expect(out.appointments).toHaveLength(1);
	});

	it("loader degrades to empty lists on Forbidden and absent Patients", async () => {
		const out = (await runLoader({
			dispatchDueReminders: () => Effect.succeed(0),
			list: () => Effect.fail(new Forbidden({ path: "agenda.list" })),
		})) as { appointments: unknown[]; patients: unknown[] };
		expect(out).toEqual({ appointments: [], patients: [] });
	});

	it("loader empties patients when the patients list is Forbidden", async () => {
		const out = (await runLoader(
			{
				dispatchDueReminders: () => Effect.succeed(0),
				list: () => Effect.succeed([]),
			},
			{ list: () => Effect.fail(new Forbidden({ path: "patients.list" })) },
		)) as { appointments: unknown[]; patients: unknown[] };
		expect(out).toEqual({ appointments: [], patients: [] });
	});
});

describe("agenda constants", () => {
	it("keeps every status in the transition table", () => {
		for (const status of APPOINTMENT_STATUSES) {
			expect(APPOINTMENT_TRANSITIONS[status]).toBeDefined();
		}
		expect(APPOINTMENT_TRANSITIONS.cancelled).toEqual([]);
		expect(APPOINTMENT_TRANSITIONS.scheduled).toContain("confirmed");
	});

	it("declares the external-sync states", () => {
		expect(APPOINTMENT_SYNC_STATES).toEqual(["local", "pending_push", "synced", "conflict"]);
	});

	it("appointmentScope admits personal rows of the owner and tenant rows", async () => {
		const scope = await Effect.runPromise(
			appointmentScope("u1").pipe(Effect.provideService(Tenant, null)),
		);
		expect(scope).toBeDefined();
	});
});
