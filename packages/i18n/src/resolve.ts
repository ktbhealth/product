import type { MessageKind, MessageParam } from "./message.ts";

/**
 * Scoped catalog resolution (P-083 / PL-008 Phase 2 core):
 * portal instance → tenant → global scope, then the locale fallback
 * chain, then the default locale, then the `namespace.key` sentinel.
 * Pure functions over already-loaded rows — no I/O, no DB.
 */

export type MessageScope = "global" | "tenant" | "portal";

/** A materialized message row: one published value at one scope. */
export interface MessageRow {
	readonly namespace: string;
	readonly key: string;
	readonly locale: string;
	readonly scope: MessageScope;
	/** Owning tenant/portal id within the scope; "" for global. */
	readonly scopeId: string;
	readonly kind: MessageKind;
	readonly value: string;
	readonly status: "draft" | "published";
	readonly params: readonly MessageParam[];
	readonly version: number;
}

/** Ordered scope chain for a request, most specific first. */
export interface ScopeChain {
	readonly scopes: ReadonlyArray<{ scope: MessageScope; scopeId: string }>;
}

export const GLOBAL_SCOPE: ScopeChain = { scopes: [{ scope: "global", scopeId: "" }] };

/** Tenant scope for a tenant id. */
export const tenantScope = (tenantId: string): ScopeChain => ({
	scopes: [
		{ scope: "tenant", scopeId: tenantId },
		{ scope: "global", scopeId: "" },
	],
});

/** Portal-instance scope without a tenant binding (PL-008 Phase 6):
 * portal copy overrides global; tenant slot lands when request context
 * carries a tenant id. */
export const portalInstanceScope = (portalId: string): ScopeChain => ({
	scopes: [
		{ scope: "portal", scopeId: portalId },
		{ scope: "global", scopeId: "" },
	],
});

/** Portal-instance scope for a portal inside a tenant. */
export const portalScope = (tenantId: string, portalId: string): ScopeChain => ({
	scopes: [
		{ scope: "portal", scopeId: portalId },
		{ scope: "tenant", scopeId: tenantId },
		{ scope: "global", scopeId: "" },
	],
});

/** Locale fallback chain, e.g. ["pt-BR","en"]; always ends at default. */
export interface LocaleChain {
	readonly locales: readonly string[];
	readonly defaultLocale: string;
}

export const localeChain = (locales: readonly string[], defaultLocale: string): LocaleChain => ({
	locales: [...new Set([...locales, defaultLocale])],
	defaultLocale,
});

/** An enabled locale row as the resolver needs it. */
export interface EnabledLocale {
	readonly code: string;
	readonly fallbacks: readonly string[];
}

/**
 * Request locale resolution (PL-008 Phase 2): the requested locale
 * (cookie/portal default) wins only when enabled; otherwise the
 * default locale serves. The chain is `requested → its fallbacks →
 * default`, deduped — e.g. pt-BR → ["pt-BR","en"].
 */
export const resolveRequestLocales = (
	requested: string | undefined,
	enabled: readonly EnabledLocale[],
	defaultLocale: string,
): LocaleChain => {
	const row = requested === undefined ? undefined : enabled.find((l) => l.code === requested);
	if (row === undefined) return localeChain([defaultLocale], defaultLocale);
	return localeChain([row.code, ...row.fallbacks], defaultLocale);
};

export interface ResolvedMessage {
	/** The template to render; sentinel `namespace.key` when missing. */
	readonly template: string;
	/** Where the value came from — for telemetry/badges. */
	readonly source:
		| { kind: "hit"; scope: MessageScope; locale: string; version: number }
		| { kind: "missing" };
}

const rowKey = (r: MessageRow) => `${r.namespace}${r.key}${r.locale}${r.scope}${r.scopeId}`;

/** Index rows once; resolution is then O(chain × locales) map probes. */
export const indexMessages = (rows: readonly MessageRow[]): ReadonlyMap<string, MessageRow> => {
	const map = new Map<string, MessageRow>();
	for (const r of rows) {
		if (r.status !== "published") continue;
		map.set(rowKey(r), r);
	}
	return map;
};

/**
 * Resolve `namespace.key` for a request. Scope is tried outermost, then
 * locale fallback, then default locale; a total miss returns the
 * `namespace.key` sentinel (never blank — telemetry counts these).
 */
export const resolveMessage = (
	index: ReadonlyMap<string, MessageRow>,
	input: {
		readonly namespace: string;
		readonly key: string;
		readonly scopeChain: ScopeChain;
		readonly locales: LocaleChain;
	},
): ResolvedMessage => {
	const probe = (locale: string) => {
		for (const { scope, scopeId } of input.scopeChain.scopes) {
			const row = index.get(`${input.namespace}${input.key}${locale}${scope}${scopeId}`);
			if (row) {
				return {
					template: row.value,
					source: { kind: "hit" as const, scope: row.scope, locale, version: row.version },
				};
			}
		}
		return null;
	};
	for (const locale of input.locales.locales) {
		const hit = probe(locale);
		if (hit) return hit;
	}
	const fallback = probe(input.locales.defaultLocale);
	if (fallback) return fallback;
	return {
		template: `${input.namespace}.${input.key}`,
		source: { kind: "missing" },
	};
};
