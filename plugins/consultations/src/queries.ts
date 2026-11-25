import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	or,
	sql,
	type SQL,
} from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { consultations, patients, user as users } from "@ktb/db/schema";
import { decodeAnamnesisOption } from "@ktb/anamnesis/schema";
import { deleteRelationTuples } from "@ktb/rbac";

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
export async function deletePatientConsultations(
	db: DbClient,
	patientId: number,
	ids: readonly number[],
) {
	// T-182: callers pass the exact rows that passed per-row authz.
	// Re-deriving visibility from user_id/tenant_id here would diverge
	// from the tuple check (user_id is attribution only) and could
	// leave a authorized row behind → FK-blocked patient delete.
	if (ids.length === 0) return;
	const where = and(eq(consultations.patientId, patientId), inArray(consultations.id, [...ids]));
	// Ids first: relation_tuples has no FK, so each deleted row's owner
	// tuple must be dropped explicitly (P-101).
	const doomed = await db.select({ id: consultations.id }).from(consultations).where(where);
	if (doomed.length === 0) return;
	await db.delete(consultations).where(where);
	for (const row of doomed) {
		await deleteRelationTuples(db, {
			objectType: "consultation",
			objectId: String(row.id),
			relation: "owner",
		});
	}
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
			anamnesisVersion: consultations.anamnesisVersion,
			transcriptReviewedAt: consultations.transcriptReviewedAt,
			transcriptReviewedBy: consultations.transcriptReviewedBy,
			anamnesisReviewedAt: consultations.anamnesisReviewedAt,
			anamnesisReviewedBy: consultations.anamnesisReviewedBy,
			anamnesisReviewedVersion: consultations.anamnesisReviewedVersion,
			deferredUntil: consultations.deferredUntil,
			audioKey: consultations.audioKey,
			audioStatus: consultations.audioStatus,
			// Recording duration = last ASR segment end (`$[#]` is the
			// append index, not "last" — hence length-1). `json_valid`
			// keeps ZK ciphertext envelopes from failing the query —
			// those rows just report null.
			audioDurationSec: sql<
				number | null
			>`CASE WHEN json_valid(${consultations.transcriptSegments}) AND json_array_length(${consultations.transcriptSegments}) > 0 THEN json_extract(${consultations.transcriptSegments}, '$[' || (json_array_length(${consultations.transcriptSegments}) - 1) || '].end') ELSE NULL END`,
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
		.select({
			id: consultations.id,
			userId: consultations.userId,
			tenantId: consultations.tenantId,
			anamnesisVersion: consultations.anamnesisVersion,
		})
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	return rows[0] ?? null;
}

/** Edit-log state for `saveTranscriptEdits`/`reviewTranscript` (PL-023):
 * the stored log, the pinned base tag, and base-layer presence flags
 * (IS NOT NULL on ciphertext columns works the same under ZK — an
 * envelope is non-null content either way). */
export async function transcriptEditsState(db: DbClient, id: number) {
	const rows = await db
		.select({
			edits: consultations.transcriptEdits,
			editsBase: consultations.transcriptEditsBase,
			hasCorrected: sql<boolean>`${consultations.correctedTranscript} IS NOT NULL`,
			hasServer: sql<boolean>`${consultations.serverTranscript} IS NOT NULL`,
		})
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	return rows[0] ?? null;
}

/** The review-queue predicates (PL-022/PL-023): unsigned — the
 * anamnesis is unapproved at its current version, or the row is
 * transcript-only and unconfirmed — and not parked (defer in the
 * future excludes the row until it expires). Shared by the queue
 * seek and the sidebar badge count so they never drift. */
const reviewPending = () =>
	or(
		and(
			isNotNull(consultations.anamnesis),
			or(
				isNull(consultations.anamnesisReviewedVersion),
				ne(consultations.anamnesisReviewedVersion, consultations.anamnesisVersion),
			),
		),
		and(isNull(consultations.anamnesis), isNull(consultations.transcriptReviewedAt)),
	);
const reviewNotParked = () =>
	or(isNull(consultations.deferredUntil), lte(consultations.deferredUntil, new Date()));

/** How many records sit in the caller's review queue — the sidebar
 * badge count (PL-023 F2). */
export async function countPendingReview(db: DbClient, scope: SQL): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)` })
		.from(consultations)
		.where(and(scope, reviewPending(), reviewNotParked()));
	return rows[0]?.n ?? 0;
}

/** Next record in the physician review queue (PL-022). `afterId` seeks
 * the next row below the current one in the list's id-DESC order; the
 * queue wraps to the top so the end-of-day ritual always finds work. */
export async function nextPendingReviewId(
	db: DbClient,
	scope: SQL,
	afterId: number,
): Promise<number | null> {
	const pending = reviewPending();
	const notParked = reviewNotParked();
	const pick = async (extra: SQL) => {
		const rows = await db
			.select({ id: consultations.id })
			.from(consultations)
			.where(and(scope, pending, notParked, extra))
			.orderBy(desc(consultations.id))
			.limit(1);
		return rows[0]?.id ?? null;
	};
	return (await pick(lt(consultations.id, afterId))) ?? pick(ne(consultations.id, afterId));
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

// ── Portal reads (T-141) ────────────────────────────────────────
// The patient portal's slice of this table: saved records only
// (`anamnesis` present — a row still being transcribed is not shown),
// raw column values (`anamnesis` stays a `v1.` envelope under ZK),
// never transcript/audio. Link authorization is NOT here — the service
// resolves it through the patient-access plugin's `PortalAccess` port.

/** One saved consultation as the portal lists it. */
export interface PortalConsultationSummaryRow {
	readonly id: number;
	readonly createdAt: Date;
	readonly anamnesis: string;
}

/** One saved consultation as the portal opens it. `userId` is the
 * recording doctor's account — the portal resolves its display name;
 * `tenantId` feeds the sensitive-read audit entry. */
export interface PortalConsultationRow {
	readonly id: number;
	readonly createdAt: Date;
	readonly patientId: number;
	readonly tenantId: number | null;
	readonly userId: string | null;
	readonly anamnesis: string;
}

/** Saved (`anamnesis` present) consultations of `patientId`, newest
 * first — whoever recorded them; the portal link is the caller's check. */
export async function portalConsultationRows(
	db: DbClient,
	patientId: number,
): Promise<PortalConsultationSummaryRow[]> {
	const rows = await db
		.select({
			id: consultations.id,
			createdAt: consultations.createdAt,
			anamnesis: consultations.anamnesis,
		})
		.from(consultations)
		.where(and(eq(consultations.patientId, patientId), isNotNull(consultations.anamnesis)))
		.orderBy(desc(consultations.createdAt), desc(consultations.id));
	// `as string` — the query filters IS NOT NULL.
	return rows.map((row) => ({ ...row, anamnesis: row.anamnesis as string }));
}

/** Consultation `id` when it has a saved record and a linked patient —
 * null otherwise. */
export async function portalConsultation(
	db: DbClient,
	id: number,
): Promise<PortalConsultationRow | null> {
	const rows = await db
		.select({
			id: consultations.id,
			createdAt: consultations.createdAt,
			patientId: consultations.patientId,
			tenantId: consultations.tenantId,
			userId: consultations.userId,
			anamnesis: consultations.anamnesis,
		})
		.from(consultations)
		.where(and(eq(consultations.id, id), isNotNull(consultations.anamnesis)))
		.limit(1);
	const row = rows[0];
	if (row === undefined || row.patientId === null) return null;
	return {
		id: row.id,
		createdAt: row.createdAt,
		patientId: row.patientId,
		tenantId: row.tenantId,
		userId: row.userId,
		// `as string` — the query filters IS NOT NULL.
		anamnesis: row.anamnesis as string,
	};
}

/** The patient/tenant scope a portal DEK grant resolves against —
 * any consultation row (saved record or not), null when it does not
 * exist or links no patient. */
export async function portalConsultationScope(
	db: DbClient,
	id: number,
): Promise<{ readonly patientId: number; readonly tenantId: number | null } | null> {
	const rows = await db
		.select({ patientId: consultations.patientId, tenantId: consultations.tenantId })
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	const row = rows[0];
	if (row === undefined || row.patientId === null) return null;
	return { patientId: row.patientId, tenantId: row.tenantId };
}

export async function getLiveConsultation(db: DbClient, id: number) {
	const rows = await db
		.select({
			id: consultations.id,
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
