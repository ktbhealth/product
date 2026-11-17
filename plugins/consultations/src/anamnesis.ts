import { and, asc, count, desc, eq, isNotNull, isNull, ne, type SQL } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { consultations, patients } from "@ktb/db/schema";
import type { PatientHistory, PriorVisit } from "@ktb/anamnesis";
import { factContent } from "@ktb/anamnesis";
import { decodeAnamnesisOption } from "@ktb/anamnesis/schema";
import type { IntegrityVerification } from "@ktb/integrity";

import { parseStored, serializeAnamnesis, type AttachAnamnesisInput } from "./shared.ts";

/** `record_versions.entity_type` for the anamnesis document (PL-007 F1). */
export const ANAMNESIS_ENTITY_TYPE = "consultation.anamnesis";

/**
 * Current integrity columns for a consultation — read BEFORE an
 * attachAnamnesis write so a pre-versioning row can seed its stored
 * anamnesis as version 1 (the write then chains as v2, preserving the
 * history the backfill would otherwise lose).
 */
export async function anamnesisIntegrityState(db: DbClient, id: number) {
	const rows = await db
		.select({
			anamnesis: consultations.anamnesis,
			anamnesisVersion: consultations.anamnesisVersion,
		})
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	return rows[0] ?? null;
}

/** Point the consultation's integrity columns at a recorded version. */
export async function setAnamnesisIntegrity(
	db: DbClient,
	id: number,
	version: { readonly version: number; readonly contentHash: string; readonly blobHash: string },
) {
	await db
		.update(consultations)
		.set({
			anamnesisHash: version.contentHash,
			anamnesisVersion: version.version,
			blobHash: version.blobHash,
		})
		.where(eq(consultations.id, id));
}

export async function attachAnamnesis(db: DbClient, data: AttachAnamnesisInput, scope?: SQL) {
	// patientId is tri-state: undefined leaves the column untouched,
	// null clears the link, a number re-links (ownership already checked
	// by the service). `scope` is the caller's tenant-aware visibility
	// fence — tenant members may update rows they don't own.
	const set: {
		anamnesis: string;
		engine: string;
		status: string;
		patientId?: number | null;
	} = {
		anamnesis: serializeAnamnesis(data.anamnesis),
		engine: data.engine,
		status: "done",
	};
	if (data.patientId === null) set.patientId = null;
	else if (data.patientId !== undefined) set.patientId = data.patientId;
	const rows = await db
		.update(consultations)
		.set(set)
		.where(and(eq(consultations.id, data.consultationId), scope))
		.returning({ id: consultations.id });
	// Only an applied write gets a version — a scope/missing-row no-op
	// must not mint a record_versions entry.
	return rows.length > 0;
}

/** Integrity columns + authz fields for the verifyIntegrity walk. */
export async function anamnesisIntegrityHead(db: DbClient, id: number) {
	const rows = await db
		.select({
			userId: consultations.userId,
			tenantId: consultations.tenantId,
			anamnesisHash: consultations.anamnesisHash,
			anamnesisVersion: consultations.anamnesisVersion,
		})
		.from(consultations)
		.where(eq(consultations.id, id))
		.limit(1);
	return rows[0] ?? null;
}

/** Domain verifyIntegrity report (T-139): the generic chain walk plus
 * the consultation row's materialized head pointer (`storedVersion`). */
export interface ConsultationIntegrityReport extends IntegrityVerification {
	/** `consultations.anamnesis_version` — must equal the chain head's
	 * version (a divergence means a version write was lost or the
	 * columns were rewritten → status "tampered", "head-diverged"). */
	readonly storedVersion: number | null;
}

/** Rows awaiting the v1 materialization (T-138 backfill): anamnesis
 * written before integrity columns existed. */
export async function unversionedAnamnesisRows(db: DbClient, limit: number) {
	return db
		.select({
			id: consultations.id,
			anamnesis: consultations.anamnesis,
			engine: consultations.engine,
			userId: consultations.userId,
			createdAt: consultations.createdAt,
		})
		.from(consultations)
		.where(and(isNotNull(consultations.anamnesis), isNull(consultations.anamnesisVersion)))
		.orderBy(asc(consultations.id))
		.limit(limit);
}

export async function countUnversionedAnamnesis(db: DbClient) {
	const rows = await db
		.select({ n: count() })
		.from(consultations)
		.where(and(isNotNull(consultations.anamnesis), isNull(consultations.anamnesisVersion)));
	/* v8 ignore next -- count() always yields a row */
	return rows[0]?.n ?? 0;
}

/** Rows materialized per backfill pass — the admin console loader
 * invokes it repeatedly until `remaining` reaches 0. */
export const BACKFILL_BATCH = 200;

/** How many prior consultations feed the history summary. */
export const HISTORY_LIMIT = 3;

/**
 * Raw history rows for the client-side history build (T-145): under ZK
 * the `anamnesis` column is an opaque envelope, so `factContent`
 * derivation must happen in the browser after decrypting. The server
 * only ever returns the stored column — plaintext JSON for non-ZK
 * rows, ciphertext for ZK ones.
 */
export interface HistoryRow {
	readonly id: number;
	readonly createdAt: Date;
	readonly anamnesis: string | null;
}

export interface PatientHistoryRows {
	readonly count: number;
	readonly rows: readonly HistoryRow[];
}

/**
 * Factual history rows of a patient's consultations, scoped to the
 * calling doctor (consultations.userId) and to patients they own.
 * Live sessions and `excludeId` (the consultation being viewed) are
 * skipped. Returns null when the patient is not owned by `userId`.
 */
export async function patientHistoryRows(
	db: DbClient,
	patientId: number,
	userId: string,
	excludeId?: number,
): Promise<PatientHistoryRows | null> {
	const owner = await db
		.select({ id: patients.id })
		.from(patients)
		.where(and(eq(patients.id, patientId), eq(patients.ownerId, userId)))
		.limit(1);
	if (!owner[0]) return null;
	const conds = [
		eq(consultations.patientId, patientId),
		eq(consultations.userId, userId),
		ne(consultations.status, "live"),
	];
	if (excludeId !== undefined) conds.push(ne(consultations.id, excludeId));
	const where = and(...conds);
	const countRows = await db.select({ n: count() }).from(consultations).where(where);
	const rows = await db
		.select({
			id: consultations.id,
			createdAt: consultations.createdAt,
			anamnesis: consultations.anamnesis,
		})
		.from(consultations)
		.where(where)
		.orderBy(desc(consultations.id))
		.limit(HISTORY_LIMIT);
	return { count: countRows[0]!.n, rows };
}

/**
 * Parsed visit summaries over `patientHistoryRows` — the server-side
 * variant for plaintext flows (LLM context in `extractAnamnesisFn`).
 * Under ZK the anamneses are envelopes: parsing yields null facts, so
 * callers needing real content must go through `historyRows` and
 * decrypt client-side.
 */
export async function patientHistory(
	db: DbClient,
	patientId: number,
	userId: string,
	excludeId?: number,
): Promise<PatientHistory | null> {
	const result = await patientHistoryRows(db, patientId, userId, excludeId);
	if (result === null) return null;
	const visits: PriorVisit[] = result.rows.map((row) => {
		const parsed = parseStored(row.anamnesis, decodeAnamnesisOption);
		return {
			id: row.id,
			date: row.createdAt.toISOString(),
			chiefComplaint: factContent(parsed?.queixa_principal.content),
			plan: factContent(parsed?.conduta.content),
		};
	});
	return { count: result.count, visits };
}
