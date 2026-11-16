import { and, eq } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { parseMessage, paramSignature } from "@ktb/i18n";

import { i18nMessages, i18nNamespaces } from "./schema.ts";

/**
 * Baseline sync (PL-008 Phase 1): imports code-side catalogs
 * (`messages/*.json`, plugin `i18n.ts`) into `global`/`published` rows.
 * Idempotent — re-running with the same baseline is a no-op, and it
 * NEVER overwrites an existing row: the DB is canonical, so panel edits
 * survive re-imports. Re-importing changed baseline copy is a panel
 * operation (reset-to-baseline), not a sync side effect.
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

const logicalKey = (e: BaselineEntry) =>
	and(
		eq(i18nMessages.namespace, e.namespace),
		eq(i18nMessages.key, e.key),
		eq(i18nMessages.locale, e.locale),
		eq(i18nMessages.scope, "global"),
		eq(i18nMessages.scopeId, ""),
	);

export const syncBaseline = async (
	db: DbClient,
	entries: readonly BaselineEntry[],
): Promise<BaselineResult> => {
	let inserted = 0;
	let skipped = 0;
	const invalid: Array<{ entry: BaselineEntry; error: string }> = [];

	for (const e of entries) {
		const kind = e.kind ?? "text";
		const parsed = parseMessage(kind, e.value);
		if (!parsed.ok) {
			invalid.push({ entry: e, error: parsed.error });
			continue;
		}
		const params = paramSignature(e.value);
		const paramList = Array.isArray(params) ? params : [];

		const existing = await db
			.select({ key: i18nMessages.key })
			.from(i18nMessages)
			.where(logicalKey(e));
		if (existing.length > 0) {
			skipped++;
			continue;
		}

		await db.insert(i18nMessages).values({
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
		inserted++;
	}

	// Register namespaces seen in the baseline (idempotent).
	const namespaces = [...new Set(entries.map((e) => e.namespace))];
	for (const ns of namespaces) {
		await db
			.insert(i18nNamespaces)
			.values({ namespace: ns, pluginId: "", defaultLocale: "en" })
			.onConflictDoNothing();
	}

	return { inserted, skipped, invalid };
};
