import { and, eq, type SQL } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { consultations } from "@ktb/db/schema";
import { deleteRelationTuples, writeRelationTuple } from "@ktb/rbac";
import { tenantIsZk } from "@ktb/vault";

import { serializeAnamnesis, type SaveConsultationInput } from "./shared.ts";

/**
 * P-101: mirror the retired permix ownership rule (`consultation.*` →
 * `user_id === principal.userId`) into `relation_tuples` as a global
 * (tenant_id NULL) `owner` grant — the subject pin to the recording
 * doctor's user id is the fence; row tenant visibility stays a
 * separate concern. `grantedBy` is the acting principal when the
 * caller has one (null for system/test writes).
 */
const writeOwnerTuple = (
	db: DbClient,
	consultationId: number,
	ownerId: string,
	grantedBy: string | null,
) =>
	writeRelationTuple(db, {
		objectType: "consultation",
		objectId: String(consultationId),
		relation: "owner",
		subjectKind: "user",
		subjectId: ownerId,
		grantedBy,
	});

export async function createConsultation(
	db: DbClient,
	fields: {
		userId: string;
		patientId?: number;
		transcript?: string;
		source: string;
		status?: string;
		botId?: string;
	},
	tenantId: number | null = null,
	grantedBy: string | null = null,
) {
	const rows = await db
		.insert(consultations)
		.values({
			userId: fields.userId,
			patientId: fields.patientId ?? null,
			tenantId,
			transcript: fields.transcript ?? "",
			source: fields.source,
			status: fields.status ?? "done",
			botId: fields.botId ?? null,
			createdAt: new Date(),
		})
		.returning({ id: consultations.id });
	const id = rows[0]?.id ?? null;
	if (id !== null) await writeOwnerTuple(db, id, fields.userId, grantedBy);
	return id;
}

/**
 * Raw row delete — returns the stored audio key so callers can purge
 * the recording from R2. Used by `Consultations.adminDelete` and by
 * the save fn's rollback path when DEK-grant persistence fails (T-145).
 */
export async function deleteConsultationRow(db: DbClient, id: number) {
	const rows = await db
		.select({ audioKey: consultations.audioKey })
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	// undefined = row missing (delete is a no-op); otherwise the stored
	// audio key (null when the consultation has no recording).
	if (rows.length === 0) return undefined;
	await db.delete(consultations).where(eq(consultations.id, id));
	// P-101: relation_tuples has no FK — drop the owner tuple with the row.
	await deleteRelationTuples(db, {
		objectType: "consultation",
		objectId: String(id),
		relation: "owner",
	});
	return rows[0]!.audioKey;
}

/** The row's tenant is a ZK tenant — plaintext clinical content must
 * never be written there (fail closed, T-145). */
export async function rowTenantIsZk(db: DbClient, consultationId: number): Promise<boolean> {
	const tenantId = await consultationTenantId(db, consultationId);
	return tenantId !== null && (await tenantIsZk(db, tenantId));
}

/**
 * Append a transcript chunk (webhook sources — diarized or not).
 * ZK tenants have no server transcript path (the pipeline never runs
 * there — T-147): plaintext chunks would persist readable clinical
 * content, so they are dropped instead of appended.
 */
export async function appendTranscript(db: DbClient, consultationId: number, text: string) {
	if (await rowTenantIsZk(db, consultationId)) return;
	const rows = await db
		.select({ transcript: consultations.transcript })
		.from(consultations)
		.where(eq(consultations.id, consultationId))
		.limit(1);
	const current = rows[0]?.transcript ?? "";
	await db
		.update(consultations)
		.set({ transcript: `${current}${current ? "\n" : ""}${text}` })
		.where(eq(consultations.id, consultationId));
}

export async function finishConsultation(db: DbClient, consultationId: number) {
	await db
		.update(consultations)
		.set({ status: "done" })
		.where(eq(consultations.id, consultationId));
}

/** Tenant scope for system paths (bot webhook, P-053 phase D): the
 * row's `tenant_id` regardless of caller — null for personal rows AND
 * for missing rows (callers authorize existence separately, e.g. via
 * `ownedByBot` before any mutation). */
export async function consultationTenantId(db: DbClient, id: number) {
	const rows = await db
		.select({ tenantId: consultations.tenantId })
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	return rows[0]?.tenantId ?? null;
}

/** Tenant scope + patient link for audit rows written as the record is
 * deleted (P-086) — both are read while the row still exists; the
 * patient feed joins deleted consultations on `detail.patientId`. */
export async function consultationAuditScope(db: DbClient, id: number) {
	const rows = await db
		.select({ tenantId: consultations.tenantId, patientId: consultations.patientId })
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	return rows[0] ?? { tenantId: null, patientId: null };
}

/** Bot-webhook ownership check: the botId binds consultation ↔ provider session. */
export async function ownsBot(db: DbClient, consultationId: number, botId: string) {
	const rows = await db
		.select({ id: consultations.id })
		.from(consultations)
		.where(and(eq(consultations.id, consultationId), eq(consultations.botId, botId)))
		.limit(1);
	return rows.length > 0;
}

export async function saveConsultation(
	db: DbClient,
	userId: string,
	data: SaveConsultationInput,
	tenantId: number | null = null,
	grantedBy: string | null = null,
) {
	const rows = await db
		.insert(consultations)
		.values({
			userId,
			patientId: data.patientId ?? null,
			tenantId,
			transcript: data.transcript,
			anamnesis: serializeAnamnesis(data.anamnesis),
			engine: data.engine,
			createdAt: new Date(),
		})
		.returning({ id: consultations.id });
	const id = rows[0]!.id;
	await writeOwnerTuple(db, id, userId, grantedBy);
	return { id };
}

export async function recordConsent(db: DbClient, id: number, scope?: SQL) {
	await db
		.update(consultations)
		.set({ consentAt: new Date() })
		.where(and(eq(consultations.id, id), scope));
}

/** "I confirmed the transcript matches the encounter" (PL-022) — raw
 * evidence stamp; `editsCount` binds the stamp to the edit-log length
 * at confirm time (PL-023) so later corrections read as new. */
export async function setTranscriptReview(
	db: DbClient,
	id: number,
	userId: string,
	editsCount: number,
	scope?: SQL,
) {
	await db
		.update(consultations)
		.set({
			transcriptReviewedAt: new Date(),
			transcriptReviewedBy: userId,
			transcriptReviewedEdits: editsCount,
		})
		.where(and(eq(consultations.id, id), scope));
}

/** Physician transcript edit log (PL-023): store the client-computed
 * Loro update log and pin the projection base — set once, on first
 * write (server-derived, never client-supplied). */
export async function saveTranscriptEdits(
	db: DbClient,
	id: number,
	input: { edits: string; base: string | null },
	scope?: SQL,
) {
	await db
		.update(consultations)
		.set({ transcriptEdits: input.edits, transcriptEditsBase: input.base })
		.where(and(eq(consultations.id, id), scope));
}

/** "I approve this anamnesis into the record" (PL-022) — binds the
 * exact `anamnesisVersion` reviewed so later edits surface as stale. */
export async function setAnamnesisReview(
	db: DbClient,
	id: number,
	userId: string,
	version: number | null,
	scope?: SQL,
) {
	await db
		.update(consultations)
		.set({
			anamnesisReviewedAt: new Date(),
			anamnesisReviewedBy: userId,
			anamnesisReviewedVersion: version,
		})
		.where(and(eq(consultations.id, id), scope));
}

/** Park the record from the review queue until `until` (null clears). */
export async function setDeferred(db: DbClient, id: number, until: Date | null, scope?: SQL) {
	await db
		.update(consultations)
		.set({ deferredUntil: until })
		.where(and(eq(consultations.id, id), scope));
}
