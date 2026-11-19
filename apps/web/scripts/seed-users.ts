// Local dev seed: creates one dev account per profile kind through
// better-auth so passwords are hashed properly. Emails are marked
// verified (no inbox in dev). Profiles are derived from links, so each
// account gets the link that makes it what it is:
//
//   admin@ktb.test     doctor (own profile) — platform admin when listed
//                      in PLATFORM_ADMIN_EMAILS (apps/web/.env.local)
//   user@ktb.test      doctor (own profile) — never platform admin
//   secretary@ktb.test secretary acting for user@ktb.test
//   patient@ktb.test   patient portal, "self" on a record of user@ktb.test
//   guardian@ktb.test  patient portal, "guardian" of a child record of
//                      user@ktb.test
//
// Idempotent — existing emails are skipped, missing links are filled in.
//
//   bun run db:seed                 # uses defaults below
//   SEED_PASSWORD=… bun run db:seed # override the shared password
import { getPlatformProxy } from "wrangler";

import { and, eq } from "drizzle-orm";

import { makeDb, type DbClient } from "@ktb/db";
import { patientAccess, patients, user } from "@ktb/db/schema";
import { makeAuth } from "@ktb/auth-better";
import { ensureDoctorProfile } from "@ktb/doctors";
import { assignSubject, createRole, setRolePermission } from "@ktb/rbac-plugin";
import { roles } from "@ktb/rbac-plugin/schema";
import { writeRelationTuple } from "@ktb/rbac";
import { inviteSecretary } from "@ktb/secretaries";
import type { PatientAccessRelation } from "@ktb/patient-access/schema";

const PASSWORD = process.env.SEED_PASSWORD ?? "dev-password-123";
const USERS = [
	{ email: "admin@ktb.test", name: "Admin" },
	{ email: "user@ktb.test", name: "User" },
	{ email: "secretary@ktb.test", name: "Secretary" },
	{ email: "patient@ktb.test", name: "Patient" },
	{ email: "guardian@ktb.test", name: "Guardian" },
	{ email: "validator@ktb.test", name: "Validator" },
] as const;
type SeedEmail = (typeof USERS)[number]["email"];

/** The patient record `name` owned by `ownerId`, created on first call. */
const ensurePatient = async (
	db: DbClient,
	ownerId: string,
	fields: { readonly name: string; readonly email: string | null; readonly birthDate: string },
): Promise<number> => {
	const [existing] = await db
		.select({ id: patients.id })
		.from(patients)
		.where(and(eq(patients.ownerId, ownerId), eq(patients.name, fields.name)));
	let id = existing?.id;
	if (id === undefined) {
		const [row] = await db
			.insert(patients)
			.values({ ownerId, ...fields, createdAt: new Date() })
			.returning({ id: patients.id });
		id = row!.id;
	}
	// T-182: record authz reads the `owner` relation tuple, not
	// patients.owner_id — upsert it for seeded rows too (rows created
	// before the tuple write shipped have none).
	await writeRelationTuple(db, {
		objectType: "patient",
		objectId: String(id),
		relation: "owner",
		subjectKind: "user",
		subjectId: ownerId,
	});
	return id;
};

const grantPatientAccess = (
	db: DbClient,
	input: {
		readonly patientId: number;
		readonly userId: string;
		readonly relation: PatientAccessRelation;
		readonly grantedBy: string;
	},
) =>
	db
		.insert(patientAccess)
		.values({
			...input,
			status: "active",
			source: "invite",
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.onConflictDoNothing();

const { env, dispose } = await getPlatformProxy({
	configPath: "wrangler.jsonc",
	remoteBindings: false,
});
try {
	const db = makeDb(env.DB as D1Database);
	const auth = makeAuth(db, {
		secret: (env as Record<string, unknown>).BETTER_AUTH_SECRET as string | undefined,
		baseURL: (env as Record<string, unknown>).BETTER_AUTH_URL as string | undefined,
	});
	const ids = {} as Record<SeedEmail, string>;
	for (const u of USERS) {
		try {
			await auth.api.signUpEmail({ body: { ...u, password: PASSWORD } });
			console.log(`[seed] created ${u.email}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/already exists|already taken|duplicate/i.test(msg)) {
				console.log(`[seed] ${u.email} already exists — skipped`);
			} else {
				throw e;
			}
		}
		const [account] = await db
			.update(user)
			.set({ emailVerified: true })
			.where(eq(user.email, u.email))
			.returning({ id: user.id });
		ids[u.email] = account!.id;
	}

	await ensureDoctorProfile(db, ids["admin@ktb.test"], "Admin");
	const doctorId = ids["user@ktb.test"];
	const doctor = await ensureDoctorProfile(db, doctorId, "User");

	await inviteSecretary(db, {
		doctorId: doctor.id,
		email: "secretary@ktb.test",
		invitedBy: doctorId,
	});

	const patientRecord = await ensurePatient(db, doctorId, {
		name: "Patient",
		email: "patient@ktb.test",
		birthDate: "1990-01-01",
	});
	await grantPatientAccess(db, {
		patientId: patientRecord,
		userId: ids["patient@ktb.test"],
		relation: "self",
		grantedBy: doctorId,
	});
	const childRecord = await ensurePatient(db, doctorId, {
		name: "Child of Guardian",
		email: null,
		birthDate: "2018-01-01",
	});
	await grantPatientAccess(db, {
		patientId: childRecord,
		userId: ids["guardian@ktb.test"],
		relation: "guardian",
		grantedBy: doctorId,
	});

	// Eval validator (P-081): the validator login is a regular user
	// carrying the eval-validator role → the eval.validator grant. No
	// bypass — the same RBAC path the admin UI uses.
	const [existingRole] = await db
		.select({ id: roles.id })
		.from(roles)
		.where(eq(roles.name, "eval-validator"));
	const roleId =
		existingRole?.id ??
		(await createRole(db, {
			name: "eval-validator",
			description: "Reviews persona cohorts and runs evals (P-081)",
		}))!.id;
	// The login router sends 0-profile accounts to the patient portal —
	// the validator needs a doctor profile to reach the console.
	await ensureDoctorProfile(db, ids["validator@ktb.test"], "Validator");
	await setRolePermission(db, {
		roleId,
		resource: "eval",
		action: "validator",
		effect: "allow",
	});
	await assignSubject(db, {
		subjectKind: "user",
		subjectId: ids["validator@ktb.test"],
		roleId,
		grantedBy: ids["admin@ktb.test"],
	});
	console.log("[seed] validator@ktb.test has the eval-validator role");

	console.log(`[seed] password for all: ${PASSWORD}`);
} finally {
	await dispose();
}
