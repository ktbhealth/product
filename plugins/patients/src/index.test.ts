import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminAudit, AUDIT_TEST_DDL, AuditLive } from "@ktb/audit";
import { VAULT_TEST_DDL } from "@ktb/vault";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { patientDocuments, user as userTable } from "@ktb/db/schema";
import { eq } from "drizzle-orm";
import { Forbidden, Principal } from "@ktb/authz";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
	Command,
	EventBus,
	type EventBusShape,
	makeEventBus,
	Query,
} from "@effect-server-utils/cqrs";
import {
	createPatient,
	deletePatientRow,
	getPatient,
	getPatientOwnerId,
	listAllPatients,
	listPatients,
	Patients,
	PatientsCommandsLive,
	PatientsLive,
	PatientsQueriesLive,
	patientsChromePlugin,
	patientsPanelPlugin,
	patientsRoutesPlugin,
	patientsServicesPlugin,
	patientsTablesPlugin,
	plugins,
	updatePatient,
} from "./index.ts";
import { PatientCreated, PatientDeleted, PatientsCommands, PatientsQueries } from "./api.ts";
import { TEXT_FIELDS, validatePatient, type PatientFields } from "./record.ts";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant, type Tenant as TenantScope } from "@ktb/tenant";

/** Validated fields for a name (birth date fixed — only the name varies in these tests). */
const fields = (name: string, extra: Record<string, string> = {}): PatientFields => {
	const r = validatePatient({ name, birthDate: "1984-03-05", ...extra });
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.fields;
};

const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL, image TEXT, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO "user" (id, name, email, email_verified, image, banned, created_at, updated_at) VALUES ('u1', 'Dra', 'd@x.com', 0, NULL, 0, 0, 0);
INSERT INTO "user" (id, name, email, email_verified, image, banned, created_at, updated_at) VALUES ('u2', 'Dr B', 'b@x.com', 0, NULL, 0, 0, 0);
CREATE TABLE patients (synthetic INTEGER NOT NULL DEFAULT 0, id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL REFERENCES "user"(id), name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, social_name TEXT, gender TEXT, birth_date TEXT, phone TEXT, email TEXT, preferred_language TEXT, address_line TEXT, address_number TEXT, address_complement TEXT, district TEXT, city TEXT, state TEXT, postal_code TEXT, country TEXT, mother_name TEXT, marital_status TEXT, race_color TEXT, nationality TEXT, emergency_contact_name TEXT, emergency_contact_relationship TEXT, emergency_contact_phone TEXT, created_at INTEGER, updated_at INTEGER, tenant_id INTEGER);
CREATE TABLE patient_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, type TEXT NOT NULL, country TEXT, number TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, UNIQUE (patient_id, type));
${AUDIT_TEST_DDL}
${VAULT_TEST_DDL}
INSERT INTO groups (id, name, slug, kind, zk, created_at, updated_at) VALUES (7, 'Clínica A', 'clinica-a', 'clinic', 0, 0, 0);
INSERT INTO groups (id, name, slug, kind, zk, created_at, updated_at) VALUES (8, 'Clínica B', 'clinica-b', 'clinic', 0, 0, 0);
INSERT INTO groups (id, name, slug, kind, zk, created_at, updated_at) VALUES (9, 'Clínica ZK', 'clinica-zk', 'clinic', 1, 0, 0);
`;

describe("patients repo", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(DDL));
	});

	it("creates and lists scoped by owner", async () => {
		await createPatient(db, "u1", fields("Ana"));
		await createPatient(db, "u1", fields("Bia"));
		const rows = await listPatients(db, "u1");
		expect(rows.map((r) => r.name)).toEqual(["Ana", "Bia"]);
	});

	it("scopes to owner only", async () => {
		expect(await listPatients(db, "u2")).toEqual([]);
	});

	it("returns the created row", async () => {
		const p = await createPatient(db, "u1", fields("Cid"));
		expect(p?.name).toBe("Cid");
		expect(p?.ownerId).toBe("u1");
	});

	it("returns null when insert yields no row", async () => {
		const stub = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as typeof db;
		expect(await createPatient(stub, "u1", fields("X"))).toBeNull();
	});

	it("persists the full record and gets it by id", async () => {
		const p = await createPatient(
			db,
			"u1",
			fields("Dora", { cpf: "529.982.247-25", city: "Recife" }),
		);
		const row = await getPatient(db, p!.id);
		expect(row).toMatchObject({
			name: "Dora",
			cpf: "52998224725",
			city: "Recife",
			active: true,
		});
		expect(row?.birthDate).toBe("1984-03-05");
		expect(await getPatient(db, 9999)).toBeNull();
	});

	it("updates a record and stamps updatedAt", async () => {
		const p = await createPatient(db, "u1", fields("Eva"));
		expect(p?.updatedAt).toBeNull();
		const updated = await updatePatient(db, p!.id, {
			...fields("Eva Lima"),
			active: false,
		});
		expect(updated).toMatchObject({ name: "Eva Lima", active: false });
		expect(updated?.updatedAt).toBeInstanceOf(Date);
		expect(await updatePatient(db, 9999, fields("Nobody"))).toBeNull();
	});

	describe("documents", () => {
		const documentsOf = async (patientId: number) =>
			(
				await db
					.select({
						type: patientDocuments.type,
						country: patientDocuments.country,
						number: patientDocuments.number,
					})
					.from(patientDocuments)
					.where(eq(patientDocuments.patientId, patientId))
			).sort((a, b) => a.type.localeCompare(b.type));

		const full = {
			cpf: "529.982.247-25",
			cns: "100 0000 0000 0007",
			passport: "FX123456",
		};

		it("stores each identifier as its own row, with the issuing country", async () => {
			const p = await createPatient(db, "u1", fields("Doc Ana", full));
			// The read model stays flat…
			expect(p).toMatchObject({
				cpf: "52998224725",
				cns: "100000000000007",
				passport: "FX123456",
			});
			// …while storage is one row per document.
			expect(await documentsOf(p!.id)).toEqual([
				{ type: "cns", country: "BR", number: "100000000000007" },
				{ type: "cpf", country: "BR", number: "52998224725" },
				{ type: "passport", country: null, number: "FX123456" },
			]);
		});

		it("stores nothing for a record without identifiers and reads them as null", async () => {
			const p = await createPatient(db, "u1", fields("Doc Bia"));
			expect(await documentsOf(p!.id)).toEqual([]);
			expect(await getPatient(db, p!.id)).toMatchObject({
				cpf: null,
				cns: null,
				passport: null,
			});
		});

		it("replaces the documents on update: changed, removed and added", async () => {
			const p = await createPatient(db, "u1", fields("Doc Cid", { cpf: full.cpf, cns: full.cns }));
			const updated = await updatePatient(
				db,
				p!.id,
				fields("Doc Cid", { cpf: "111.444.777-35", passport: "ZZ998877" }),
			);
			expect(updated).toMatchObject({
				cpf: "11144477735",
				cns: null,
				passport: "ZZ998877",
			});
			expect(await documentsOf(p!.id)).toEqual([
				{ type: "cpf", country: "BR", number: "11144477735" },
				{ type: "passport", country: null, number: "ZZ998877" },
			]);
			expect(await getPatient(db, p!.id)).toMatchObject({
				cpf: "11144477735",
				cns: null,
				passport: "ZZ998877",
			});

			// Clearing every identifier leaves no rows behind.
			await updatePatient(db, p!.id, fields("Doc Cid"));
			expect(await documentsOf(p!.id)).toEqual([]);
		});

		it("keeps each patient's documents to itself when listing", async () => {
			const withDocs = await createPatient(db, "u2", fields("Lista Ana", { cpf: full.cpf }));
			const without = await createPatient(db, "u2", fields("Lista Bia"));
			const other = await createPatient(db, "u2", fields("Lista Cid", { cns: full.cns }));
			const rows = await listPatients(db, "u2");
			expect(rows.map((r) => [r.id, r.cpf, r.cns, r.passport])).toEqual([
				[withDocs!.id, "52998224725", null, null],
				[without!.id, null, null, null],
				[other!.id, null, "100000000000007", null],
			]);
			// Another owner's listing is unaffected, and so is the admin one.
			expect(await listPatients(db, "u9")).toEqual([]);
			const admin = await listAllPatients(db);
			expect(admin.find((r) => r.id === withDocs!.id)).toMatchObject({
				cpf: "52998224725",
			});
			expect(admin.find((r) => r.id === without!.id)).toMatchObject({
				cpf: null,
			});
		});

		it("leaves a document type this build does not know out of the read model", async () => {
			const p = await createPatient(db, "u1", fields("Doc Dora", { cpf: full.cpf }));
			await db.insert(patientDocuments).values({
				patientId: p!.id,
				type: "dni",
				country: "AR",
				number: "30123456",
				createdAt: new Date(),
			});
			const row = await getPatient(db, p!.id);
			expect(row).toMatchObject({ cpf: "52998224725" });
			expect(row).not.toHaveProperty("dni");
		});

		it("deletes the documents with the patient", async () => {
			const p = await createPatient(db, "u1", fields("Doc Eva", full));
			const kept = await createPatient(db, "u1", fields("Doc Fia", { cpf: "111.444.777-35" }));
			await deletePatientRow(db, p!.id);
			expect(await getPatient(db, p!.id)).toBeNull();
			expect(await documentsOf(p!.id)).toEqual([]);
			expect(await documentsOf(kept!.id)).toHaveLength(1);
		});
	});

	it("listAllPatients returns cross-owner rows with owner fields", async () => {
		await createPatient(db, "u1", fields("Admin Ana"));
		await createPatient(db, "u2", fields("Admin Bia"));
		const rows = await listAllPatients(db);
		const byName = new Map(rows.map((r) => [r.name, r]));
		expect(byName.get("Admin Ana")?.ownerEmail).toBe("d@x.com");
		expect(byName.get("Admin Ana")?.ownerName).toBe("Dra");
		expect(byName.get("Admin Bia")?.ownerEmail).toBe("b@x.com");
		// Newest first.
		expect(rows[0]?.name).toBe("Admin Bia");
	});
});

describe("PatientsLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Patients, never>;
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			makeEventBus(),
		);
		// Provide the real audit service so adminCreate writes an
		// admin_audit row (T-037); the "without a stored row" and tenant
		// describes below intentionally omit it.
		const allDeps = Layer.mergeAll(deps, AuditLive.pipe(Layer.provide(deps)));
		runtime = ManagedRuntime.make(PatientsLive.pipe(Layer.provideMerge(allDeps)));
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Patients>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (p: Patients["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Patients, f);

	it("list returns own patients for the bound principal", async () => {
		await asUser(
			"u1",
			call((p) => p.create("u1", fields("Ana"))),
		);
		const rows = await asUser(
			"u1",
			call((p) => p.list("u1")),
		);
		expect(rows.map((r) => r.name)).toContain("Ana");
	});

	it("list fails Forbidden for another ownerId and for null principal", async () => {
		await expect(
			asUser(
				"u1",
				call((p) => p.list("u2")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asUser(
				null,
				call((p) => p.list("u1")),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("create succeeds for the principal's own id", async () => {
		const patient = await asUser(
			"u1",
			call((p) => p.create("u1", fields("Svc Patient"))),
		);
		expect(patient?.name).toBe("Svc Patient");
		expect(patient?.ownerId).toBe("u1");
	});

	it("create fails Forbidden on owner mismatch and null principal", async () => {
		await expect(
			asUser(
				"u1",
				call((p) => p.create("u2", fields("X"))),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
			path: "patient.create",
		});
		await expect(
			asUser(
				null,
				call((p) => p.create("u1", fields("X"))),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("get returns the owner's patient, null when missing", async () => {
		const created = await asUser(
			"u1",
			call((p) => p.create("u1", fields("Gil"))),
		);
		const got = await asUser(
			"u1",
			call((p) => p.get("u1", created!.id)),
		);
		expect(got?.name).toBe("Gil");
		expect(
			await asUser(
				"u1",
				call((p) => p.get("u1", 9999)),
			),
		).toBeNull();
	});

	it("get fails Forbidden for another owner's row, owner mismatch and null principal", async () => {
		const created = await asUser(
			"u1",
			call((p) => p.create("u1", fields("Private"))),
		);
		// u2's own principal, reading u1's row → permix denies on the real owner.
		await expect(
			asUser(
				"u2",
				call((p) => p.get("u2", created!.id)),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.read" });
		await expect(
			asUser(
				"u1",
				call((p) => p.get("u2", created!.id)),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				null,
				call((p) => p.get("u1", created!.id)),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("update rewrites the owner's patient, null when missing", async () => {
		const created = await asUser(
			"u1",
			call((p) => p.create("u1", fields("Hugo"))),
		);
		const updated = await asUser(
			"u1",
			call((p) => p.update("u1", created!.id, fields("Hugo Reis", { city: "Natal" }))),
		);
		expect(updated).toMatchObject({ name: "Hugo Reis", city: "Natal" });
		expect(
			await asUser(
				"u1",
				call((p) => p.update("u1", 9999, fields("X"))),
			),
		).toBeNull();
	});

	it("update fails Forbidden for another owner's row and null principal", async () => {
		const created = await asUser(
			"u1",
			call((p) => p.create("u1", fields("Locked"))),
		);
		await expect(
			asUser(
				"u2",
				call((p) => p.update("u2", created!.id, fields("Hijack"))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.update" });
		await expect(
			asUser(
				null,
				call((p) => p.update("u1", created!.id, fields("X"))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("audits owner create/update with ids only (P-080)", async () => {
		const created = await asUser(
			"u1",
			call((p) => p.create("u1", fields("Audited Pat"))),
		);
		let rows = await db.select().from(adminAudit);
		const createEntry = rows.find(
			(r) => r.action === "patients.create" && r.targetId === String(created!.id),
		);
		expect(createEntry).toMatchObject({ actorUserId: "u1", targetType: "patient" });
		expect(createEntry?.detail).toContain('"ownerId":"u1"');
		expect(createEntry?.detail).not.toContain("Audited Pat");

		const updated = await asUser(
			"u1",
			call((p) => p.update("u1", created!.id, fields("Audited Pat 2"))),
		);
		expect(updated?.name).toBe("Audited Pat 2");
		rows = await db.select().from(adminAudit);
		const updateEntry = rows.find(
			(r) => r.action === "patients.update" && r.targetId === String(created!.id),
		);
		expect(updateEntry).toMatchObject({ actorUserId: "u1", targetType: "patient" });
		expect(updateEntry?.detail).toContain('"ownerId":"u1"');
		expect(updateEntry?.detail).not.toContain("Audited Pat 2");
	});

	it("adminList returns cross-owner rows for an allowlisted principal", async () => {
		const rows = await asUser(
			"u1",
			call((p) => p.adminList()),
			"admin@x.com",
		);
		expect(rows.length).toBeGreaterThan(0);
		// All fixture patients here are u1-owned; the join resolves the
		// owner's email — proof adminList is not owner-scoped.
		expect(rows.every((r) => r.ownerEmail === "d@x.com")).toBe(true);
	});

	it("adminList fails Forbidden for non-admin email, missing email and null principal", async () => {
		await expect(
			asUser(
				"u1",
				call((p) => p.adminList()),
				"other@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "platform.admin" });
		await expect(
			asUser(
				"u1",
				call((p) => p.adminList()),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				null,
				call((p) => p.adminList()),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("adminCreate inserts a patient for another owner", async () => {
		const row = await asUser(
			"u1",
			call((p) => p.adminCreate("u2", fields("Admin Made"))),
			"admin@x.com",
		);
		expect(row?.ownerId).toBe("u2");
		expect(row?.name).toBe("Admin Made");
		// T-037: the audit row carries ids only — never patient fields.
		const auditRows = await db.select().from(adminAudit);
		const entry = auditRows.find(
			(r) => r.action === "patients.create" && r.targetId === String(row!.id),
		);
		expect(entry).toMatchObject({
			actorUserId: "u1",
			actorEmail: "admin@x.com",
			targetType: "patient",
		});
		expect(entry?.detail).not.toContain("Admin Made");
	});

	it("adminCreate fails Forbidden for non-admin and null principal", async () => {
		await expect(
			asUser(
				"u1",
				call((p) => p.adminCreate("u2", fields("Nope"))),
				"other@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "platform.admin" });
		await expect(
			asUser(
				null,
				call((p) => p.adminCreate("u2", fields("Nope"))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("adminOwners lists user accounts for allowlisted admins only", async () => {
		// Blank names fall back to email, then to the id — the picker
		// label must never render empty.
		await db.insert(userTable).values([
			{
				id: "u3",
				name: "",
				email: "noname@x.com",
				emailVerified: false,
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
			{
				id: "u4",
				name: "",
				email: "",
				emailVerified: false,
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
		]);
		const owners = await asUser(
			"u1",
			call((p) => p.adminOwners()),
			"admin@x.com",
		);
		expect(owners.map((o) => o.id).sort()).toEqual(["u1", "u2", "u3", "u4"]);
		expect(owners.find((o) => o.id === "u3")?.label).toBe("noname@x.com");
		expect(owners.find((o) => o.id === "u4")?.label).toBe("u4");
		await expect(
			asUser(
				"u1",
				call((p) => p.adminOwners()),
				"other@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("get and update let an admin cross the owner boundary", async () => {
		const foreign = await asUser(
			"u2",
			call((p) => p.create("u2", fields("Foreign Read"))),
		);
		const id = foreign!.id;
		// Admin reads and updates u2's row through the owner-scoped API.
		const read = await asUser(
			"u1",
			call((p) => p.get("u1", id)),
			"admin@x.com",
		);
		expect(read?.name).toBe("Foreign Read");
		const updated = await asUser(
			"u1",
			call((p) => p.update("u1", id, fields("Foreign Edited"))),
			"admin@x.com",
		);
		expect(updated?.name).toBe("Foreign Edited");
		// P-080: the audit row records the ROW's owner (u2), not the
		// admin caller — ownerId is patient attribution, not the actor.
		const auditRows = await db.select().from(adminAudit);
		const updateEntry = auditRows.find(
			(r) => r.action === "patients.update" && r.targetId === String(id),
		);
		expect(updateEntry).toMatchObject({ actorUserId: "u1", targetType: "patient" });
		expect(updateEntry?.detail).toContain('"ownerId":"u2"');
		// A non-admin still gets Forbidden on the same row.
		await expect(
			asUser(
				"u1",
				call((p) => p.get("u1", id)),
			),
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("get audits the sensitive read scoped to the row's tenant (P-086)", async () => {
		// Tenant-owned row (group 7) read cross-owner by a platform admin —
		// the audit entry must carry the ROW's tenant_id, not ambient scope.
		const tenantRow = await createPatient(db, "u2", fields("Tenant Read"), 7);
		await asUser(
			"u1",
			call((p) => p.get("u1", tenantRow!.id)),
			"admin@x.com",
		);
		// Personal row → tenant_id NULL.
		const personal = await asUser(
			"u1",
			call((p) => p.create("u1", fields("Personal Read"))),
		);
		await asUser(
			"u1",
			call((p) => p.get("u1", personal!.id)),
		);

		const rows = await db.select().from(adminAudit);
		const tenantEntry = rows.find(
			(r) => r.action === "patients.read" && r.targetId === String(tenantRow!.id),
		);
		expect(tenantEntry).toMatchObject({
			actorUserId: "u1",
			targetType: "patient",
			tenantId: 7,
		});
		const personalEntry = rows.find(
			(r) => r.action === "patients.read" && r.targetId === String(personal!.id),
		);
		expect(personalEntry).toMatchObject({ targetType: "patient", tenantId: null });

		// Missing rows, denied reads and list() write nothing.
		const before = rows.length;
		expect(
			await asUser(
				"u1",
				call((p) => p.get("u1", 99999)),
			),
		).toBeNull();
		await expect(
			asUser(
				"u2",
				call((p) => p.get("u2", personal!.id)),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await asUser(
			"u1",
			call((p) => p.list("u1")),
		);
		expect(await db.select().from(adminAudit)).toHaveLength(before);
	});
});

describe("plugins", () => {
	it("declares tables, services and panel as single-concern plugins", () => {
		expect(patientsTablesPlugin.id).toBe("patients.tables");
		expect(patientsTablesPlugin.tables?.patients).toBeDefined();
		expect(patientsServicesPlugin.id).toBe("patients.services");
		expect(patientsServicesPlugin.requiredDeps).toEqual(["platform.admin"]);
		expect(patientsServicesPlugin.services).toBeDefined();
		expect(patientsPanelPlugin.id).toBe("patients.panel");
		expect(patientsPanelPlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(patientsPanelPlugin.panel?.pages?.[0]?.path).toBe("/platform/patients");
		expect(patientsChromePlugin.id).toBe("patients.chrome");
		expect(patientsChromePlugin.chrome.map((c) => c.region)).toEqual(["portal.sidebar"]);
	});

	it("keeps routes and chrome out of the tables, services and panel plugins", () => {
		expect("routes" in patientsTablesPlugin).toBe(false);
		expect("chrome" in patientsServicesPlugin).toBe(false);
		expect("routes" in patientsPanelPlugin).toBe(false);
		expect("chrome" in patientsPanelPlugin).toBe(false);
	});

	it("declares the /patients route subtree", () => {
		expect(patientsRoutesPlugin.id).toBe("patients.routes");
		// P-033: the subtree is a physical() mount of this package's own
		// src/routes directory — resolved against the host routes dir.
		expect(JSON.stringify(patientsRoutesPlugin.routes)).toContain("plugins/patients/src/routes");
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"patients.tables",
			"patients.services",
			"patients.routes",
			"patients.chrome",
			"patients.panel",
		]);
	});

	it("platform loader collapses Forbidden failures to empty tables", async () => {
		const loader = patientsPanelPlugin.panel?.pages?.[0]?.loader;
		expect(loader).toBeDefined();
		const forbidden = () => Effect.fail(new Forbidden({ path: "platform.admin" }));
		const result = await Effect.runPromise(
			loader!().pipe(
				Effect.provideService(Patients, {
					adminList: forbidden,
					adminOwners: forbidden,
				} as never),
			),
		);
		expect(result).toEqual({ patients: [], owners: [] });
	});
});

describe("patients.ownerOf", () => {
	it("returns the owner row for a patient and null for unknown ids", async () => {
		const db = makeDb(makeD1(DDL));
		const p = await createPatient(db, "u1", fields("Owner Lookup"));
		expect(p?.id).toBeTypeOf("number");
		expect(await getPatientOwnerId(db, p!.id)).toMatchObject({ ownerId: "u1" });
		expect(await getPatientOwnerId(db, 99999)).toBeNull();
	});

	it("resolves through the query dispatcher", async () => {
		const db = makeDb(makeD1(DDL));
		const p = await createPatient(db, "u1", fields("Dispatcher Lookup"));
		const runtime = ManagedRuntime.make(
			PatientsQueriesLive.pipe(Layer.provide(Layer.succeed(Db, db))),
		);
		try {
			const lookup = (id: number) =>
				runtime.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const queries = yield* Query.dispatcher(PatientsQueries);
							return yield* queries["patients.ownerOf"]({ id });
						}),
					),
				);
			expect((await lookup(p!.id))?.ownerId).toBe("u1");
			expect(await lookup(99999)).toBeNull();
		} finally {
			await runtime.dispose();
		}
	});
});

describe("PatientsLive without a stored row", () => {
	it("create returns null (and emits nothing) when the insert yields no row", async () => {
		const stub = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as ReturnType<typeof makeDb>;
		const deps = Layer.mergeAll(
			Layer.succeed(Db, stub),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			makeEventBus(),
		);
		const runtime = ManagedRuntime.make(PatientsLive.pipe(Layer.provide(deps)));
		try {
			const row = await runtime.runPromise(
				Effect.provideService(
					Effect.flatMap(Patients, (p) => p.create("u1", fields("Ghost"))),
					Principal,
					{ userId: "u1" },
				),
			);
			expect(row).toBeNull();
		} finally {
			await runtime.dispose();
		}
	});

	it("adminCreate returns null when the insert yields no row", async () => {
		const stub = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as ReturnType<typeof makeDb>;
		const deps = Layer.mergeAll(
			Layer.succeed(Db, stub),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			makeEventBus(),
		);
		const runtime = ManagedRuntime.make(PatientsLive.pipe(Layer.provide(deps)));
		try {
			const row = await runtime.runPromise(
				Effect.provideService(
					Effect.flatMap(Patients, (p) => p.adminCreate("u2", fields("Ghost Admin"))),
					Principal,
					{ userId: "u1", email: "admin@x.com" },
				),
			);
			expect(row).toBeNull();
		} finally {
			await runtime.dispose();
		}
	});

	it("update returns null (and skips the audit write) when the update yields no row", async () => {
		// getPatient sees the row but updatePatient's RETURNING is empty —
		// the concurrent-delete shape the `updated !== null` guard covers.
		const existing = { id: 7, ownerId: "u1", tenantId: null, name: "Ghost" };
		const stub = {
			select: () => ({
				from: () => ({
					// patients path ends in .limit(1); the patient_documents
					// join in withIdentifiers awaits the where() result.
					where: () => ({
						limit: async () => [existing],
						then: (resolve: (rows: unknown[]) => void) => resolve([]),
					}),
					innerJoin: () => ({ where: async () => [] }),
				}),
			}),
			delete: () => ({ where: () => ({}) }),
			update: () => ({
				set: () => ({ where: () => ({ returning: async () => [] }) }),
			}),
			batch: async () => [[], []],
		} as unknown as ReturnType<typeof makeDb>;
		const deps = Layer.mergeAll(
			Layer.succeed(Db, stub),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			makeEventBus(),
		);
		const runtime = ManagedRuntime.make(PatientsLive.pipe(Layer.provide(deps)));
		try {
			const row = await runtime.runPromise(
				Effect.provideService(
					Effect.flatMap(Patients, (p) => p.update("u1", 7, fields("Ghost Update"))),
					Principal,
					{ userId: "u1" },
				),
			);
			expect(row).toBeNull();
		} finally {
			await runtime.dispose();
		}
	});
});

describe("PatientsCommandsLive", () => {
	const adminGate = () =>
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")));

	it("patients.delete is a no-op for a patient that does not exist", async () => {
		const deps = Layer.mergeAll(
			Layer.succeed(Db, makeDb(makeD1(DDL))),
			makeEventBus(),
			adminGate(),
		);
		const runtime = ManagedRuntime.make(PatientsCommandsLive.pipe(Layer.provideMerge(deps)));
		try {
			await expect(
				runtime.runPromise(
					Effect.provideService(
						Effect.gen(function* () {
							const commands = yield* Command.dispatcher(PatientsCommands);
							return yield* commands["patients.delete"]({ id: 424242 });
						}).pipe(Effect.scoped),
						Principal,
						{ userId: "u1" },
					),
				),
			).resolves.toBeUndefined();
		} finally {
			await runtime.dispose();
		}
	});

	it("patients.delete removes the owner's patient, emits patient.deleted and audits (P-080)", async () => {
		const db = makeDb(makeD1(DDL));
		const row = (await createPatient(db, "u1", fields("To Delete")))!;
		const infra = Layer.mergeAll(Layer.succeed(Db, db), makeEventBus(), adminGate());
		const deps = Layer.mergeAll(infra, AuditLive.pipe(Layer.provide(infra)));
		const runtime = ManagedRuntime.make(PatientsCommandsLive.pipe(Layer.provideMerge(deps)));
		try {
			await runtime.runPromise(
				Effect.provideService(
					Effect.gen(function* () {
						const commands = yield* Command.dispatcher(PatientsCommands);
						yield* commands["patients.delete"]({ id: row.id });
					}).pipe(Effect.scoped),
					Principal,
					{ userId: "u1" },
				),
			);
			expect(await getPatient(db, row.id)).toBeNull();
			// ids only — the audit row carries the row's owner, never fields.
			const auditRows = await db.select().from(adminAudit);
			const entry = auditRows.find(
				(r) => r.action === "patients.delete" && r.targetId === String(row.id),
			);
			expect(entry).toMatchObject({ actorUserId: "u1", targetType: "patient" });
			expect(entry?.detail).toContain('"ownerId":"u1"');
		} finally {
			await runtime.dispose();
		}
	});

	it("patients.delete lets a platform admin remove another owner's patient and audits the row's owner", async () => {
		const db = makeDb(makeD1(DDL));
		const row = (await createPatient(db, "u2", fields("Foreign")))!;
		const infra = Layer.mergeAll(Layer.succeed(Db, db), makeEventBus(), adminGate());
		const deps = Layer.mergeAll(infra, AuditLive.pipe(Layer.provide(infra)));
		const runtime = ManagedRuntime.make(PatientsCommandsLive.pipe(Layer.provideMerge(deps)));
		try {
			await runtime.runPromise(
				Effect.provideService(
					Effect.gen(function* () {
						const commands = yield* Command.dispatcher(PatientsCommands);
						yield* commands["patients.delete"]({ id: row.id });
					}).pipe(Effect.scoped),
					Principal,
					{ userId: "u1", email: "admin@x.com" },
				),
			);
			expect(await getPatient(db, row.id)).toBeNull();
			const auditRows = await db.select().from(adminAudit);
			const entry = auditRows.find(
				(r) => r.action === "patients.delete" && r.targetId === String(row.id),
			);
			expect(entry).toMatchObject({
				actorUserId: "u1",
				actorEmail: "admin@x.com",
				targetType: "patient",
			});
			expect(entry?.detail).toContain('"ownerId":"u2"');
		} finally {
			await runtime.dispose();
		}
	});

	it("patients.delete still fails Forbidden for a non-admin non-owner", async () => {
		const db = makeDb(makeD1(DDL));
		const row = (await createPatient(db, "u2", fields("Foreign 2")))!;
		const deps = Layer.mergeAll(Layer.succeed(Db, db), makeEventBus(), adminGate());
		const runtime = ManagedRuntime.make(PatientsCommandsLive.pipe(Layer.provideMerge(deps)));
		try {
			await expect(
				runtime.runPromise(
					Effect.provideService(
						Effect.gen(function* () {
							const commands = yield* Command.dispatcher(PatientsCommands);
							yield* commands["patients.delete"]({ id: row.id });
						}).pipe(Effect.scoped),
						Principal,
						{ userId: "u1", email: "other@x.com" },
					),
				),
			).rejects.toMatchObject({ _tag: "Forbidden" });
			expect(await getPatient(db, row.id)).not.toBeNull();
		} finally {
			await runtime.dispose();
		}
	});
});

describe("PatientsLive tenant scope (P-053)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Patients, never>;
	let busRuntime: ManagedRuntime.ManagedRuntime<EventBus, never>;
	let db: ReturnType<typeof makeDb>;
	let bus: EventBusShape;

	const TENANT_A: TenantScope = {
		id: 7,
		kind: "clinic",
		slug: "clinica-a",
		role: "member",
	};
	const TENANT_B: TenantScope = {
		id: 8,
		kind: "clinic",
		slug: "clinica-b",
		role: "member",
	};

	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		// Build the bus explicitly so tests can subscribe to the same
		// instance the service layer dispatches on.
		busRuntime = ManagedRuntime.make(makeEventBus());
		bus = await busRuntime.runPromise(EventBus);
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			Layer.succeed(EventBus, bus),
		);
		runtime = ManagedRuntime.make(PatientsLive.pipe(Layer.provide(deps)));
	});

	afterAll(async () => {
		await runtime.dispose();
		await busRuntime.dispose();
	});

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Patients>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const asTenant = <A, E>(
		userId: string,
		tenant: TenantScope,
		effect: Effect.Effect<A, E, Patients>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(
				Effect.provideService(effect, Principal, { userId, email }),
				Tenant,
				tenant,
			),
		);

	const call = <A, E>(f: (p: Patients["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Patients, f);

	it("create stamps tenant_id from the bound tenant; personal scope stamps NULL", async () => {
		const shared = await asTenant(
			"u1",
			TENANT_A,
			call((p) => p.create("u1", fields("Tenant Pat"))),
		);
		expect(shared?.tenantId).toBe(7);
		expect((await getPatient(db, shared!.id))?.tenantId).toBe(7);

		const personal = await asUser(
			"u1",
			call((p) => p.create("u1", fields("Personal Pat"))),
		);
		expect(personal?.tenantId).toBeNull();
	});

	it("create leaves tenant_id NULL for non-numeric tenant ids", async () => {
		const row = await asTenant(
			"u1",
			Object.assign({}, TENANT_A, { id: "clinic-x" }),
			call((p) => p.create("u1", fields("Strange Tenant"))),
		);
		expect(row?.tenantId).toBeNull();
	});

	it("create/adminCreate events carry the stamped tenant_id", async () => {
		const seen: (number | null | undefined)[] = [];
		await Effect.runPromise(
			bus.subscribe(PatientCreated, (e) =>
				Effect.sync(() => {
					seen.push(e.tenantId);
				}),
			),
		);
		await asTenant(
			"u1",
			TENANT_A,
			call((p) => p.create("u1", fields("Evt Pat"))),
		);
		await asTenant(
			"u1",
			TENANT_A,
			call((p) => p.adminCreate("u2", fields("Evt Admin"))),
			"admin@x.com",
		);
		await asUser(
			"u1",
			call((p) => p.create("u1", fields("Evt Personal"))),
		);
		expect(seen).toEqual([7, 7, null]);
	});

	it("adminCreate stamps the bound tenant", async () => {
		const row = await asTenant(
			"u1",
			TENANT_A,
			call((p) => p.adminCreate("u2", fields("Admin Tenant Pat"))),
			"admin@x.com",
		);
		expect(row?.tenantId).toBe(7);
		expect(row?.ownerId).toBe("u2");
	});

	it("list shows tenant rows to members and hides them from outsiders and personal scope", async () => {
		await createPatient(db, "u1", fields("Clinic Shared"), 7);
		await createPatient(db, "u2", fields("Other Clinic"), 8);

		// u2 is a member of tenant 7: sees u1's tenant-7 row, not tenant 8's.
		const member = await asTenant(
			"u2",
			TENANT_A,
			call((p) => p.list("u2")),
		);
		const memberNames = member.map((r) => r.name);
		expect(memberNames).toContain("Clinic Shared");
		expect(memberNames).not.toContain("Other Clinic");

		// Personal scope: tenant rows are invisible even to their creator.
		const personal = await asUser(
			"u1",
			call((p) => p.list("u1")),
		);
		expect(personal.map((r) => r.name)).not.toContain("Clinic Shared");
		expect(personal.map((r) => r.name)).not.toContain("Other Clinic");
	});

	it("get lets tenant members read tenant rows; outsiders, personal-scope owners and admins behave", async () => {
		const shared = (await createPatient(db, "u1", fields("Shared Get"), 7))!;

		const got = await asTenant(
			"u2",
			TENANT_A,
			call((p) => p.get("u2", shared.id)),
		);
		expect(got?.name).toBe("Shared Get");

		// Member of a different tenant → Forbidden.
		await expect(
			asTenant(
				"u2",
				TENANT_B,
				call((p) => p.get("u2", shared.id)),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.read" });

		// The creator in personal scope → Forbidden: tenant rows require
		// tenant context, ownerId is not an access grant outside it.
		await expect(
			asUser(
				"u1",
				call((p) => p.get("u1", shared.id)),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });

		// Platform admin reads cross-tenant.
		const admin = await asTenant(
			"u1",
			TENANT_B,
			call((p) => p.get("u1", shared.id)),
			"admin@x.com",
		);
		expect(admin?.name).toBe("Shared Get");
	});

	it("update lets tenant members operate tenant rows; non-members are Forbidden", async () => {
		const shared = (await createPatient(db, "u1", fields("Shared Edit"), 7))!;

		const updated = await asTenant(
			"u2",
			TENANT_A,
			call((p) => p.update("u2", shared.id, fields("Shared Edit 2"))),
		);
		expect(updated?.name).toBe("Shared Edit 2");

		await expect(
			asTenant(
				"u2",
				TENANT_B,
				call((p) => p.update("u2", shared.id, fields("Hijack"))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.update" });
	});

	it("patients.delete lets a tenant member remove a tenant row; non-members are Forbidden", async () => {
		const db2 = makeDb(makeD1(DDL));
		const shared = (await createPatient(db2, "u1", fields("Shared Del"), 7))!;
		// Same explicit-bus trick as the tenant describe: subscribe on
		// the instance the command layer dispatches to.
		const busRuntime = ManagedRuntime.make(makeEventBus());
		const bus = await busRuntime.runPromise(EventBus);
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db2),
			Layer.succeed(EventBus, bus),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const rt = ManagedRuntime.make(PatientsCommandsLive.pipe(Layer.provideMerge(deps)));
		const seen: (number | null | undefined)[] = [];
		await Effect.runPromise(
			bus.subscribe(PatientDeleted, (e) =>
				Effect.sync(() => {
					seen.push(e.tenantId);
				}),
			),
		);
		const del = (tenant: TenantScope) =>
			rt.runPromise(
				Effect.provideService(
					Effect.provideService(
						Effect.gen(function* () {
							const commands = yield* Command.dispatcher(PatientsCommands);
							yield* commands["patients.delete"]({ id: shared.id });
						}).pipe(Effect.scoped),
						Principal,
						{ userId: "u2" },
					),
					Tenant,
					tenant,
				),
			);
		try {
			await expect(del(TENANT_B)).rejects.toMatchObject({ _tag: "Forbidden" });
			expect(await getPatient(db2, shared.id)).not.toBeNull();
			await del(TENANT_A);
			expect(await getPatient(db2, shared.id)).toBeNull();
			// patient.deleted carries the deleted row's tenant_id.
			expect(seen).toEqual([7]);
		} finally {
			await rt.dispose();
			await busRuntime.dispose();
		}
	});
});

describe("PatientsLive ZK gate (T-144)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Patients, never>;
	let db: ReturnType<typeof makeDb>;

	// Group 9 is `zk = 1` in the shared DDL; groups 7/8 stay plaintext.
	const TENANT_ZK: TenantScope = { id: 9, kind: "clinic", slug: "clinica-zk", role: "member" };

	beforeAll(() => {
		db = makeDb(makeD1(DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			makeEventBus(),
		);
		runtime = ManagedRuntime.make(PatientsLive.pipe(Layer.provideMerge(deps)));
	});

	afterAll(() => runtime.dispose());

	const asTenant = <A, E>(
		userId: string,
		tenant: TenantScope,
		effect: Effect.Effect<A, E, Patients>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(
				Effect.provideService(effect, Principal, { userId, email }),
				Tenant,
				tenant,
			),
		);

	const call = <A, E>(f: (p: Patients["Service"]) => Effect.Effect<A, E>) =>
		Effect.flatMap(Patients, f);

	/** Envelope-shaped fields — what the browser sends for a ZK tenant. */
	const ciphered = (extra: Partial<PatientFields> = {}): PatientFields => ({
		...(Object.fromEntries(TEXT_FIELDS.map((k) => [k, null])) as Record<
			(typeof TEXT_FIELDS)[number],
			null
		>),
		name: "v1.aXYtLmN0",
		birthDate: "v1.ZGF0YQ",
		active: true,
		...extra,
	});

	it("create rejects plaintext fields for a ZK tenant", async () => {
		await expect(
			asTenant(
				"u1",
				TENANT_ZK,
				call((p) => p.create("u1", fields("Plain"))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.create" });
	});

	it("create rejects a ciphered payload carrying one plaintext value", async () => {
		await expect(
			asTenant(
				"u1",
				TENANT_ZK,
				call((p) => p.create("u1", ciphered({ phone: "11999990000" }))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.create" });
	});

	it("create persists envelope fields for a ZK tenant", async () => {
		const row = await asTenant(
			"u1",
			TENANT_ZK,
			call((p) => p.create("u1", ciphered())),
		);
		expect(row?.tenantId).toBe(9);
		expect(row?.name).toBe("v1.aXYtLmN0");
		expect(row?.birthDate).toBe("v1.ZGF0YQ");
	});

	it("update gates on the row's tenant, not the caller's fields", async () => {
		const row = (await createPatient(db, "u1", ciphered(), 9))!;
		await expect(
			asTenant(
				"u1",
				TENANT_ZK,
				call((p) => p.update("u1", row.id, fields("Plain Update"))),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.update" });
		const updated = await asTenant(
			"u1",
			TENANT_ZK,
			call((p) => p.update("u1", row.id, ciphered({ name: "v1.bmV3TmFtZQ" }))),
		);
		expect(updated?.name).toBe("v1.bmV3TmFtZQ");
	});

	it("adminCreate rejects plaintext for a ZK tenant", async () => {
		await expect(
			asTenant(
				"u1",
				TENANT_ZK,
				call((p) => p.adminCreate("u2", fields("Admin Plain"))),
				"admin@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.create" });
	});

	it("plaintext still flows for non-ZK tenant writes", async () => {
		const TENANT_A: TenantScope = { id: 7, kind: "clinic", slug: "clinica-a", role: "member" };
		const row = await asTenant(
			"u1",
			TENANT_A,
			call((p) => p.create("u1", fields("Plain Ok"))),
		);
		expect(row?.name).toBe("Plain Ok");
	});

	it("create rejects a ciphered payload on a non-ZK tenant", async () => {
		const TENANT_A: TenantScope = { id: 7, kind: "clinic", slug: "clinica-a", role: "member" };
		await expect(
			asTenant(
				"u1",
				TENANT_A,
				call((p) => p.create("u1", ciphered())),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.create" });
	});

	it("update rejects a ciphered payload when the row lives in a non-ZK tenant", async () => {
		const TENANT_A: TenantScope = { id: 7, kind: "clinic", slug: "clinica-a", role: "member" };
		const row = (await createPatient(db, "u1", fields("Plain Row"), 7))!;
		await expect(
			asTenant(
				"u1",
				TENANT_A,
				call((p) => p.update("u1", row.id, ciphered())),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "patient.update" });
	});
});
