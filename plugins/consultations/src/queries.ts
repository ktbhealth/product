import { and, desc, eq, type SQL } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { consultations, patients, user as users } from "@ktb/db/schema";
import { decodeAnamnesisOption } from "@ktb/anamnesis/schema";

import {
	parseStored,
	type ConsultationDetail,
	type ConsultationRow,
	type ConsultationSummary,
} from "./shared.ts";

/** Every consultation linked to a patient, whoever owns it — authz happens in the service. */
export async function patientConsultationRows(db: DbClient, patientId: number) {
	return db
		.select({
			id: consultations.id,
			userId: consultations.userId,
			tenantId: consultations.tenantId,
			audioKey: consultations.audioKey,
		})
		.from(consultations)
		.where(eq(consultations.patientId, patientId));
}

/** Linked consultation rows only — the patient row itself goes through
 * the `patients.delete` command (authz + `patient.deleted` event live
 * in the patients plugin). Consultations are deleted first so a FK
 * constraint can't block the patient delete. The select stays
 * owner-agnostic on purpose: the service scans EVERY linked row and
 * fails `Forbidden` on a foreign one — that check is what keeps a
 * stray cross-owner link from silently surviving (or blocking) the
 * patient delete via the FK. */
export async function deletePatientConsultations(db: DbClient, patientId: number, scope?: SQL) {
	await db
		.delete(consultations)
		.where(
			scope === undefined
				? eq(consultations.patientId, patientId)
				: and(eq(consultations.patientId, patientId), scope),
		);
}

export async function listConsultations(
	db: DbClient,
	patientId: number | undefined,
	scope: SQL,
): Promise<ConsultationSummary[]> {
	const conds = [scope];
	if (patientId !== undefined) conds.push(eq(consultations.patientId, patientId));
	const where = and(...conds);
	const rows = await db
		.select({
			id: consultations.id,
			engine: consultations.engine,
			createdAt: consultations.createdAt,
			transcript: consultations.transcript,
			source: consultations.source,
			status: consultations.status,
			consentAt: consultations.consentAt,
			anamnesis: consultations.anamnesis,
			patientId: consultations.patientId,
			patientName: patients.name,
		})
		.from(consultations)
		.leftJoin(patients, eq(consultations.patientId, patients.id))
		.where(where)
		.orderBy(desc(consultations.id));
	return rows.map((c) => {
		const parsed = parseStored(c.anamnesis, decodeAnamnesisOption);
		return {
			...c,
			// `hasAnamnesis` derives from column presence only — under ZK
			// the column is an opaque envelope the server cannot parse,
			// so `chiefComplaint` stays null and clients re-derive it
			// after decrypting `anamnesis` (T-145).
			hasAnamnesis: c.anamnesis !== null,
			chiefComplaint: parsed?.queixa_principal.content ?? null,
		};
	});
}

/** Admin-console row: consultation plus owner/patient display fields. */
export interface AdminConsultationRow extends ConsultationRow {
	readonly ownerEmail: string | null;
	readonly ownerName: string | null;
	readonly patientName: string | null;
}

/**
 * Cross-owner listing for the /platform console. Callers MUST have
 * passed the `PlatformAdmin` gate first — this repo function itself is
 * unauthenticated, like the other helpers.
 */
export async function listAllConsultations(db: DbClient): Promise<AdminConsultationRow[]> {
	const rows = await db
		.select({
			consultation: consultations,
			ownerEmail: users.email,
			ownerName: users.name,
			patientName: patients.name,
		})
		.from(consultations)
		.leftJoin(users, eq(consultations.userId, users.id))
		.leftJoin(patients, eq(consultations.patientId, patients.id))
		.orderBy(desc(consultations.id));
	return rows.map(({ consultation, ownerEmail, ownerName, patientName }) => ({
		...consultation,
		ownerEmail,
		ownerName,
		patientName,
	}));
}

/** Owner lookup for authz checks — fetches by id regardless of caller.
 * `tenantId` lets the service apply tenant visibility (P-053). */
export async function consultationOwner(db: DbClient, id: number) {
	const rows = await db
		.select({ userId: consultations.userId, tenantId: consultations.tenantId })
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	return rows[0] ?? null;
}

export async function getConsultation(
	db: DbClient,
	id: number,
): Promise<ConsultationDetail | null> {
	const rows = await db
		.select({ c: consultations, patientName: patients.name })
		.from(consultations)
		.leftJoin(patients, eq(consultations.patientId, patients.id))
		.where(eq(consultations.id, id))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	return {
		...row.c,
		patientName: row.patientName,
		anamnesis: parseStored(row.c.anamnesis, decodeAnamnesisOption),
		anamnesisRaw: row.c.anamnesis,
	};
}

export async function getLiveConsultation(db: DbClient, id: number) {
	const rows = await db
		.select({
			transcript: consultations.transcript,
			status: consultations.status,
			userId: consultations.userId,
			tenantId: consultations.tenantId,
		})
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	return rows[0] ?? null;
}
