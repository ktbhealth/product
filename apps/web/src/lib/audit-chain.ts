import { insertAuditEntry, verifyAuditChain, type AuditVerifyResult } from "@ktb/audit";
import type { DbClient } from "@ktb/db";

import { db as platformDb } from "#/lib/platform.ts";

/**
 * Scheduled audit-chain verification (T-139 follow-up): the worker's
 * `scheduled` handler (src/server.ts) runs this once per cron fire —
 * daily via the Alchemy `crons` trigger. `scheduled()` never fires in
 * `bun run dev`; the /platform/audit "Verify chain" action covers dev.
 *
 * System path — no Principal: the tamper marker row is written with
 * null actor columns, which is exactly what `insertAuditEntry` records
 * for system contexts. Verification failures are logged and swallowed:
 * a broken cron run must never crash the isolate or retry-storm.
 */

/** Action recorded on the audit log itself when the chain walk finds a
 * broken link — the marker is itself chained, so the tamper evidence
 * stays inside the tamper-evident log. */
export const AUDIT_CHAIN_TAMPERED_ACTION = "audit.chain.tampered";

/** Structured log line — flat JSON like the http.access sink so Workers
 * Logs ingests it as one event. */
const log = (level: "INFO" | "WARN" | "ERROR", message: string, fields: object): void => {
	const line = JSON.stringify({ message, level, ...fields });
	if (level === "ERROR") console.error(line);
	else if (level === "WARN") console.warn(line);
	else console.info(line);
};

/** Append the tamper marker row. Exported for tests and reuse. */
export const recordAuditChainTamper = (db: DbClient, result: AuditVerifyResult): Promise<unknown> =>
	insertAuditEntry(db, {
		action: AUDIT_CHAIN_TAMPERED_ACTION,
		targetType: "audit",
		targetId: result.brokenAt,
		detail: { brokenAt: result.brokenAt, entries: result.entries },
		actorUserId: null,
		actorEmail: null,
	});

export interface ScheduledAuditVerifyDeps {
	readonly db?: DbClient;
	readonly verify?: (db: DbClient) => Promise<AuditVerifyResult>;
	readonly recordTamper?: (db: DbClient, result: AuditVerifyResult) => Promise<unknown>;
}

/**
 * Run one verification pass. Returns the walk's result, or `null` when
 * the walk itself threw (the error is already logged). Injectable deps
 * keep the orchestration unit-testable without a database.
 */
export async function runScheduledAuditVerification(
	deps: ScheduledAuditVerifyDeps = {},
): Promise<AuditVerifyResult | null> {
	const database = deps.db ?? platformDb;
	const verify = deps.verify ?? verifyAuditChain;
	const recordTamper = deps.recordTamper ?? recordAuditChainTamper;

	let result: AuditVerifyResult;
	try {
		result = await verify(database);
	} catch (error) {
		log("ERROR", "audit.chain.verify.failed", { error: String(error) });
		return null;
	}

	if (result.status === "tampered") {
		log("ERROR", "audit.chain.tampered", {
			brokenAt: result.brokenAt,
			entries: result.entries,
		});
		// The marker write is best-effort like Audit.record: a failed
		// insert must not mask the tamper signal already logged above.
		try {
			await recordTamper(database, result);
		} catch (error) {
			log("WARN", "audit.chain.tamper-marker.failed", { error: String(error) });
		}
	} else {
		log("INFO", "audit.chain.verified", { status: result.status, entries: result.entries });
	}
	return result;
}
