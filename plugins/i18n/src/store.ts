import { and, eq, inArray, sql } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import type { MessageRow, MessageScope } from "@ktb/i18n";

import {
	i18nCrdtUpdates,
	i18nLocales,
	i18nMessages,
	i18nNamespaces,
	type I18nMessage,
} from "./schema.ts";

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
		/** Restrict to these namespaces (route slices); absent = all. */
		readonly namespaces?: readonly string[];
	},
): Promise<MessageRow[]> => {
	const scopeConds = input.scopes.map(({ scope, scopeId }) =>
		scope === "global"
			? eq(i18nMessages.scope, "global")
			: and(eq(i18nMessages.scope, scope), eq(i18nMessages.scopeId, scopeId)),
	);
	const conds = [
		inArray(i18nMessages.locale, [...input.locales]),
		sql`(${sql.join(scopeConds, sql` OR `)})`,
	];
	if (input.namespaces !== undefined && input.namespaces.length > 0) {
		conds.push(inArray(i18nMessages.namespace, [...input.namespaces]));
	}
	const rows = await db
		.select()
		.from(i18nMessages)
		.where(and(...conds));
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

/** Enabled locale rows only — the set `resolveRequestLocales` may pick from. */
export const listEnabledLocales = async (
	db: DbClient,
): Promise<ReadonlyArray<{ code: string; fallbacks: readonly string[] }>> => {
	const rows = await db
		.select({ code: i18nLocales.code, fallbacks: i18nLocales.fallbacks })
		.from(i18nLocales)
		.where(eq(i18nLocales.enabled, true));
	return rows;
};

export { i18nLocales, i18nMessages, i18nNamespaces };

// ---------- panel/admin reads (all statuses, drafts included) ----------

export interface MessageFilter {
	readonly namespace?: string;
	readonly locale?: string;
	readonly scope?: MessageScope;
	readonly scopeId?: string;
	readonly status?: "draft" | "published";
}

/** Full rows (draft_value included) for the panel matrix/editor. */
export const listMessageRows = async (
	db: DbClient,
	filter: MessageFilter = {},
): Promise<readonly I18nMessage[]> => {
	const conds = [];
	if (filter.namespace !== undefined) conds.push(eq(i18nMessages.namespace, filter.namespace));
	if (filter.locale !== undefined) conds.push(eq(i18nMessages.locale, filter.locale));
	if (filter.scope !== undefined) conds.push(eq(i18nMessages.scope, filter.scope));
	if (filter.scopeId !== undefined) conds.push(eq(i18nMessages.scopeId, filter.scopeId));
	if (filter.status !== undefined) conds.push(eq(i18nMessages.status, filter.status));
	return db
		.select()
		.from(i18nMessages)
		.where(conds.length === 0 ? undefined : and(...conds));
};

export const getMessageRow = async (
	db: DbClient,
	id: {
		readonly namespace: string;
		readonly key: string;
		readonly locale: string;
		readonly scope: MessageScope;
		readonly scopeId: string;
	},
): Promise<I18nMessage | undefined> => {
	const rows = await db
		.select()
		.from(i18nMessages)
		.where(
			and(
				eq(i18nMessages.namespace, id.namespace),
				eq(i18nMessages.key, id.key),
				eq(i18nMessages.locale, id.locale),
				eq(i18nMessages.scope, id.scope),
				eq(i18nMessages.scopeId, id.scopeId),
			),
		);
	return rows[0];
};

/** Loro op-log bytes for one message, oldest first. */
export const listCrdtUpdates = async (
	db: DbClient,
	id: {
		readonly namespace: string;
		readonly key: string;
		readonly locale: string;
		readonly scope: MessageScope;
		readonly scopeId: string;
	},
): Promise<readonly Uint8Array[]> => {
	const rows = await db
		.select({ update: i18nCrdtUpdates.update })
		.from(i18nCrdtUpdates)
		.where(
			and(
				eq(i18nCrdtUpdates.namespace, id.namespace),
				eq(i18nCrdtUpdates.key, id.key),
				eq(i18nCrdtUpdates.locale, id.locale),
				eq(i18nCrdtUpdates.scope, id.scope),
				eq(i18nCrdtUpdates.scopeId, id.scopeId),
			),
		)
		.orderBy(i18nCrdtUpdates.id);
	return rows.map((r) => r.update as Uint8Array);
};
