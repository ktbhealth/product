import { and, eq, inArray } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { parseMessage } from "@ktb/i18n";

import { MAX_MESSAGE_VALUE_LENGTH, validateMessageId } from "./contract.ts";
import { i18nMessages, i18nNamespaces } from "./schema.ts";
import { bumpCatalogRevision } from "./store.ts";

/**
 * Baseline sync (PL-008 Phase 1): imports code-side catalogs
 * (`messages/*.json`, plugin `i18n.ts`) into `global`/`published` rows.
 * Idempotent — re-running with the same baseline is a no-op, and it
 * NEVER overwrites an existing row: the DB is canonical, so panel edits
 * survive re-imports. Re-importing changed baseline copy is a manual
 * ops step — `tools/import-i18n-baseline.mjs` re-runs this sync against
 * a target database (or emits equivalent idempotent SQL via `--sql`);
 * there is no in-panel reset-to-baseline op.
 *
 * Batched (not per-entry): validation is pure, existing keys come from
 * ONE select, and inserts go out in chunks — the runtime auto-seed runs
 * this on a cold isolate against a fresh D1 where ~8k sequential
 * SELECT+INSERT round-trips would stall the first request.
 */

export interface BaselineEntry {
	readonly namespace: string;
	readonly key: string;
	readonly locale: string;
	readonly kind?: "text" | "rich";
	readonly value: string;
}

export interface BaselineResult {
	readonly inserted: number;
	readonly skipped: number;
	readonly invalid: ReadonlyArray<{ entry: BaselineEntry; error: string }>;
}

/** Bound-parameter ceiling. Plain SQLite allows thousands, but D1
 * caps bound parameters at 100 per query — the runtime auto-seed runs
 * against D1, so chunking must satisfy the stricter limit. One row
 * below the cap leaves margin for driver-level extras. */
const MAX_BOUND_PARAMETERS = 100;
/** Columns bound per inserted message row — the keys set in
 * prepareBaselineEntries (createdAt/updatedAt/draftValue fall back to
 * column defaults and are not bound). */
const PARAMS_PER_MESSAGE_ROW = 10;
const INSERT_CHUNK_SIZE = Math.floor(
	(MAX_BOUND_PARAMETERS - 1) / PARAMS_PER_MESSAGE_ROW,
);

/** Injective tuple key for the logical message identity — same
 * JSON-tuple trick as runtime.ts `cacheKey` (separator-joined keys
 * collide when ids contain the separator). */
const messageTuple = (namespace: string, key: string, locale: string): string =>
	JSON.stringify([namespace, key, locale]);

/**
 * Pure half of the baseline sync: validate + parse every entry into
 * insert-ready `global`/`published` rows. Shared with
 * tools/import-i18n-baseline.mjs `--sql` mode so emitted SQL rows pass
 * the exact same gates the DB path enforces (id charset, value-length
 * cap, MF1 template parse, duplicate collapse). `skipped` here counts
 * in-batch duplicates only — pre-existing DB rows are filtered by
 * syncBaseline's existence select.
 */
export const prepareBaselineEntries = (
	entries: readonly BaselineEntry[],
): {
	readonly rows: ReadonlyArray<typeof i18nMessages.$inferInsert>;
	readonly skipped: number;
	readonly invalid: ReadonlyArray<{ entry: BaselineEntry; error: string }>;
} => {
	let skipped = 0;
	const invalid: Array<{ entry: BaselineEntry; error: string }> = [];

	// Validate + parse every entry up front — no DB round-trips in this
	// loop. Entries are generated, but ids land in the composite PK so
	// the same charset/scope rules as the admin write path apply, plus
	// the shared value-length cap.
	const candidates: Array<typeof i18nMessages.$inferInsert> = [];
	const seen = new Set<string>();
	for (const e of entries) {
		const kind = e.kind ?? "text";
		const idError = validateMessageId({
			namespace: e.namespace,
			key: e.key,
			locale: e.locale,
			scope: "global",
			scopeId: "",
		});
		if (idError !== null || e.value.length > MAX_MESSAGE_VALUE_LENGTH) {
			invalid.push({
				entry: e,
				error: idError ?? `value exceeds ${MAX_MESSAGE_VALUE_LENGTH} characters`,
			});
			continue;
		}
		const parsed = parseMessage(kind, e.value);
		if (!parsed.ok) {
			invalid.push({ entry: e, error: parsed.error });
			continue;
		}
		// parsed.ok guarantees a signature — reuse it rather than
		// re-deriving (paramSignature can't fail on the same input).
		const paramList = parsed.message.params;

		// First occurrence wins — a duplicated baseline key is skipped
		// exactly like a pre-existing DB row (never overwrite).
		const tuple = messageTuple(e.namespace, e.key, e.locale);
		if (seen.has(tuple)) {
			skipped++;
			continue;
		}
		seen.add(tuple);
		candidates.push({
			namespace: e.namespace,
			key: e.key,
			locale: e.locale,
			scope: "global",
			scopeId: "",
			kind,
			value: e.value,
			status: "published",
			params: paramList,
			version: 1,
		});
	}
	return { rows: candidates, skipped, invalid };
};

export const syncBaseline = async (
	db: DbClient,
	entries: readonly BaselineEntry[],
): Promise<BaselineResult> => {
	const prepared = prepareBaselineEntries(entries);
	let skipped = prepared.skipped;
	const invalid = prepared.invalid;
	const candidates = prepared.rows;

	// One SELECT for every existing global baseline key, then chunked
	// inserts. `onConflictDoNothing` still guards the select-then-insert
	// race: two isolates auto-seeding the same empty DB concurrently
	// would otherwise PK-conflict on the composite key.
	let inserted = 0;
	if (candidates.length > 0) {
		const namespaces = [...new Set(candidates.map((r) => r.namespace))];
		const existing = await db
			.select({
				namespace: i18nMessages.namespace,
				key: i18nMessages.key,
				locale: i18nMessages.locale,
			})
			.from(i18nMessages)
			.where(
				and(
					eq(i18nMessages.scope, "global"),
					eq(i18nMessages.scopeId, ""),
					inArray(i18nMessages.namespace, namespaces),
				),
			);
		const existingKeys = new Set(existing.map((r) => messageTuple(r.namespace, r.key, r.locale)));
		const fresh = candidates.filter(
			(r) => !existingKeys.has(messageTuple(r.namespace, r.key, r.locale)),
		);
		skipped += candidates.length - fresh.length;
		for (let i = 0; i < fresh.length; i += INSERT_CHUNK_SIZE) {
			await db
				.insert(i18nMessages)
				.values(fresh.slice(i, i + INSERT_CHUNK_SIZE))
				.onConflictDoNothing();
		}
		inserted = fresh.length;
		// Published rows landed → move the cache stamp so isolates pick
		// the new catalog up on their next TTL re-check.
		if (inserted > 0) await bumpCatalogRevision(db);
	}

	// Register namespaces seen in the baseline — one batched insert
	// (idempotent). Namespaces aren't part of the published catalog, so
	// no revision bump here.
	const namespaces = [...new Set(entries.map((e) => e.namespace))];
	if (namespaces.length > 0) {
		const nsRows = namespaces.map((ns) => ({
			namespace: ns,
			pluginId: "",
			defaultLocale: "en",
		}));
		// Same bound-parameter ceiling as the message insert — 3 params
		// per namespace row.
		const nsChunk = Math.floor((MAX_BOUND_PARAMETERS - 1) / 3);
		for (let i = 0; i < nsRows.length; i += nsChunk) {
			await db
				.insert(i18nNamespaces)
				.values(nsRows.slice(i, i + nsChunk))
				.onConflictDoNothing();
		}
	}

	return { inserted, skipped, invalid };
};
