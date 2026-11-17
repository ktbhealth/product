import type { BatchItem, BatchResponse } from "drizzle-orm/batch";

import type { DbClient } from "./index.ts";

/**
 * tx — the portable "run these ops atomically" helper.
 *
 * `ops` are thenable drizzle query builders (insert/update/delete/…,
 * optionally `.returning()`) — the same values `db.batch` accepts on
 * the D1 driver. Callers keep building ops against `db`; `tx` only
 * decides HOW they execute:
 *
 * - SQLite/D1 (today's only driver): delegates to `db.batch`, which the
 *   d1 session lowers to ONE `SqlDatabase.batch` call — atomic on the
 *   wire (D1 batches are transactions; the better-sqlite3 dev adapter
 *   wraps them in a real transaction too).
 * - Postgres (when `makeDb` grows a pg driver): `DbClient` will gain
 *   `.transaction`; `tx` dispatches on the capability below so call
 *   sites never change. OPEN QUESTION for that driver: drizzle binds
 *   each builder to the session that created it, so prebuilt ops
 *   cannot be re-executed inside `db.transaction(tx => …)` — the pg
 *   branch will need ops expressed against the tx handle (thunks) or a
 *   session-level batch. Until then it fails loudly rather than
 *   silently running ops outside a transaction.
 *
 * Returns the same per-op result tuple `db.batch` does, so destructure
 * sites (`const [, [row]] = await tx(db, […])`) are unchanged.
 */
export type TxOp = BatchItem<"sqlite">;

/** The dialect seam: whatever atomic-execution capability the client has. */
interface BatchCapable {
	batch: DbClient["batch"];
}

const asBatchCapable = (db: DbClient): (DbClient & BatchCapable) | null =>
	typeof (db as { batch?: unknown }).batch === "function" ? (db as DbClient & BatchCapable) : null;

export async function tx<U extends TxOp, T extends Readonly<[U, ...U[]]>>(
	db: DbClient,
	ops: T,
): Promise<BatchResponse<T>> {
	const batchable = asBatchCapable(db);
	if (batchable !== null) return batchable.batch(ops);
	// TODO(pg): dispatch to db.transaction once the pg driver exists and
	// the op-rebinding question above is settled — see the module doc.
	throw new Error(
		"tx: this DbClient has no atomic batch — Postgres transaction support is not wired yet",
	);
}
