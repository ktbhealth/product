// Remote prod seed for the HackBrasil demo D1. Runs under Node (Wrangler
// remote bindings refuse Bun): bundle with
//   bun build scripts/seed-remote.ts --outfile /tmp/seed-remote.mjs \
//     --target node --external wrangler
// then run with cuora-injected prod env:
//   SEED_CONFIRM=prod SEED_PASSWORD=… cuora run --env prod \
//     --config ../../cuora.toml -- node /tmp/seed-remote.mjs
//
// Discovers the Alchemy-managed prod D1 (ktb-web-db-prod-*) via
// `wrangler d1 list`, binds it with `remote: true`, and replays the same
// accounts/patients/demo-consult seed as scripts/seed-users.ts. Plugin
// service fns are replicated here against the light schema modules so the
// bundle stays free of TanStack/React server-fn imports.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { getPlatformProxy } from "wrangler";

import { HeuristicExtractor } from "@ktb/anamnesis";
import { makeAuth } from "@ktb/auth-better";
import { makeDb, type DbClient } from "@ktb/db";
import { consultations, patientAccess, patients, roles, user } from "@ktb/db/schema";
import { doctors } from "@ktb/doctors/schema";
import { writeRelationTuple } from "@ktb/rbac";
import { doctorAccess } from "@ktb/secretaries/schema";
import { PTBR_CONSULTATIONS } from "@ktb/eval-consultation/ptbr";

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

const ensureDoctorProfile = async (
	db: DbClient,
	userId: string,
	displayName: string,
): Promise<number> => {
	await db
		.insert(doctors)
		.values({ userId, displayName, createdAt: new Date(), updatedAt: new Date() })
		.onConflictDoNothing();
	const [row] = await db.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, userId));
	return row!.id;
};

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
		readonly relation: "self" | "guardian";
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

const inviteSecretary = async (
	db: DbClient,
	input: { readonly doctorId: number; readonly email: string; readonly invitedBy: string },
) => {
	const [account] = await db
		.select({ id: user.id, emailVerified: user.emailVerified })
		.from(user)
		.where(eq(user.email, input.email));
	const link = account?.emailVerified
		? { userId: account.id, status: "active" }
		: { userId: null, status: "invited" };
	const [row] = await db
		.insert(doctorAccess)
		.values({
			doctorId: input.doctorId,
			email: input.email,
			invitedBy: input.invitedBy,
			...link,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [doctorAccess.doctorId, doctorAccess.email],
			set: { invitedBy: input.invitedBy, ...link },
		})
		.returning();
	return row!;
};

const discoverProdDb = (): { readonly name: string; readonly id: string } => {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "2c03574ae47e534415b762ab3c474815";
	// getPlatformProxy's remote session resolves the account from the
	// process env, not the `wrangler d1 list` child env below.
	process.env.CLOUDFLARE_ACCOUNT_ID ??= accountId;
	const out = execFileSync("bunx", ["wrangler", "d1", "list", "--json"], {
		encoding: "utf8",
		cwd: process.cwd(),
		maxBuffer: 1024 * 1024,
		env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
	});
	const list = JSON.parse(out) as { name: string; uuid?: string }[];
	const name = process.env.SEED_D1_NAME ?? list.find((d) => /^ktb-web-db-prod-/.test(d.name))?.name;
	const id = process.env.SEED_D1_ID ?? list.find((d) => d.name === name)?.uuid;
	if (name === undefined || id === undefined) {
		throw new Error(`prod D1 not found (SEED_D1_NAME/SEED_D1_ID override available): ${out}`);
	}
	return { name, id };
};

if (process.env.SEED_CONFIRM !== "prod") {
	throw new Error("Refusing to seed prod D1 without SEED_CONFIRM=prod");
}

const target = discoverProdDb();
console.log(`[seed-remote] target D1: ${target.name} (${target.id})`);

const tmp = mkdtempSync(join(tmpdir(), "ktb-seed-"));
const configPath = join(tmp, "wrangler.json");
writeFileSync(
	configPath,
	JSON.stringify(
		{
			name: "ktb-seed-remote",
			compatibility_date: "2026-11-06",
			d1_databases: [
				{
					binding: "DB",
					database_name: target.name,
					database_id: target.id,
					remote: true,
				},
			],
		},
		null,
		2,
	),
);

const proxy = await getPlatformProxy({ configPath, remoteBindings: true });
try {
	const db = makeDb(proxy.env.DB as D1Database);
	const auth = makeAuth(db, {
		secret: process.env.BETTER_AUTH_SECRET,
		baseURL: process.env.BETTER_AUTH_URL,
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
	const doctorProfileId = await ensureDoctorProfile(db, doctorId, "User");

	await inviteSecretary(db, {
		doctorId: doctorProfileId,
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

	const DEMO_CONSULT_SLUG = "gp-lombalgia-03";
	const demoConsult = PTBR_CONSULTATIONS.find((c) => c.slug === DEMO_CONSULT_SLUG)!;
	const SPEAKER_LABEL = { doctor: "Médico", patient: "Paciente" } as const;
	const demoTranscript = demoConsult.turns
		.map((t) => `${SPEAKER_LABEL[t.speaker]}: ${t.text}`)
		.join("\n");
	const [existingConsult] = await db
		.select({ id: consultations.id })
		.from(consultations)
		.where(and(eq(consultations.userId, doctorId), eq(consultations.transcript, demoTranscript)));
	if (existingConsult === undefined) {
		const extractor = new HeuristicExtractor();
		const now = new Date();
		const [row] = await db
			.insert(consultations)
			.values({
				userId: doctorId,
				patientId: patientRecord,
				transcript: demoTranscript,
				anamnesis: JSON.stringify(await extractor.extract(demoTranscript)),
				engine: extractor.name,
				source: "browser",
				status: "done",
				consentAt: now,
				synthetic: true,
				createdAt: now,
			})
			.returning({ id: consultations.id });
		await writeRelationTuple(db, {
			objectType: "consultation",
			objectId: String(row!.id),
			relation: "owner",
			subjectKind: "user",
			subjectId: doctorId,
		});
		console.log(`[seed] consultation #${row!.id} (${DEMO_CONSULT_SLUG}) for user@ktb.test`);
	} else {
		console.log(`[seed] demo consultation #${existingConsult.id} already exists — skipped`);
	}

	const [existingRole] = await db
		.select({ id: roles.id, name: roles.name })
		.from(roles)
		.where(eq(roles.name, "eval-validator"));
	let roleName = existingRole?.name;
	let roleId = existingRole?.id;
	if (roleId === undefined) {
		const [row] = await db
			.insert(roles)
			.values({
				name: "eval-validator",
				description: "Reviews persona cohorts and runs evals (P-081)",
				meta: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.returning({ id: roles.id, name: roles.name });
		roleId = row!.id;
		roleName = row!.name;
	}
	await ensureDoctorProfile(db, ids["validator@ktb.test"], "Validator");
	await writeRelationTuple(db, {
		objectType: "eval",
		objectId: "*",
		relation: "validator",
		subjectKind: "role",
		subjectId: roleName!,
		effect: "allow",
	});
	await writeRelationTuple(db, {
		objectType: "role",
		objectId: roleName!,
		relation: "member",
		subjectKind: "user",
		subjectId: ids["validator@ktb.test"],
		effect: "allow",
		grantedBy: ids["admin@ktb.test"],
	});
	console.log("[seed] validator@ktb.test has the eval-validator role");

	console.log(`[seed] password for all: ${PASSWORD}`);
} finally {
	await proxy.dispose();
	rmSync(tmp, { recursive: true, force: true });
}
