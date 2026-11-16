import { and, eq, inArray, sql } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import type { MessageRow, MessageScope } from "@ktb/i18n";

import { i18nLocales, i18nMessages, i18nNamespaces } from "./schema.ts";

/**
 * Drizzle access for the i18n tables. All reads here feed the per-isolate
 * catalog cache — nothing in this module is called per `t()`.
 */

const toRow = (m: typeof i18nMessages.$inferSelect): MessageRow => ({
	namespace: m.namespace,
	key: m.key,
	locale: m.locale,
	scope: m.scope,
	scopeId: m.scopeId,
	kind: m.kind,
	value: m.value,
	status: m.status,
	params: m.params,
	version: m.version,
});

/**
 * Published rows visible to a request: the given locales × the scope
 * chain (global always; tenant/portal only for the matching ids).
 */
export const listPublishedRows = async (
	db: DbClient,
	input: {
		readonly locales: readonly string[];
		readonly scopes: ReadonlyArray<{ scope: MessageScope; scopeId: string }>;
	},
): Promise<MessageRow[]> => {
	const scopeConds = input.scopes.map(({ scope, scopeId }) =>
		scope === "global"
			? eq(i18nMessages.scope, "global")
			: and(eq(i18nMessages.scope, scope), eq(i18nMessages.scopeId, scopeId)),
	);
	const rows = await db
		.select()
		.from(i18nMessages)
		.where(
			and(
				inArray(i18nMessages.locale, [...input.locales]),
				sql`(${sql.join(scopeConds, sql` OR `)})`,
			),
		);
	return rows.map(toRow);
};

/**
 * Cache stamp: SUM(version) + COUNT(*) over published rows. Every write
 * bumps `version`, every insert adds to the count — monotonic, so the
 * ~15s TTL re-read detects any change.
 */
export const catalogStamp = async (db: DbClient): Promise<string> => {
	const rows = await db
		.select({
			count: sql<number>`count(*)`,
			versionSum: sql<number>`coalesce(sum(${i18nMessages.version}), 0)`,
		})
		.from(i18nMessages)
		.where(eq(i18nMessages.status, "published"));
	const r = rows[0];
	return `${r?.count ?? 0}:${r?.versionSum ?? 0}`;
};

/** Enabled locales with their fallback chains, default first. */
export const listLocales = async (
	db: DbClient,
): Promise<
	ReadonlyArray<{ code: string; endonym: string; fallbacks: readonly string[]; enabled: boolean }>
> => {
	const rows = await db.select().from(i18nLocales);
	return rows.map((r) => ({
		code: r.code,
		endonym: r.endonym,
		fallbacks: r.fallbacks,
		enabled: r.enabled,
	}));
};

export { i18nLocales, i18nMessages, i18nNamespaces };
