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
	// Stryker disable next-line ConditionalExpression: enabled.find(l => l.code === undefined) always yields undefined (code is a string), so skipping the ternary's short-circuit is identical (probe-verified).
	const row = requested === undefined ? undefined : enabled.find((l) => l.code === requested);
	// Stryker disable next-line ArrayDeclaration: localeChain appends defaultLocale and dedupes, so [] and [defaultLocale] produce the same locales (probe-verified).
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

// JSON tuple: injective for ANY field content — whitespace, quotes and
// separator-like substrings can't collide ("a b"+"c" vs "a"+"b c").
// It's only a Map key, so readability doesn't matter.
const rowKey = (r: {
	readonly namespace: string;
	readonly key: string;
	readonly locale: string;
	readonly scope: MessageScope;
	readonly scopeId: string;
}) => JSON.stringify([r.namespace, r.key, r.locale, r.scope, r.scopeId]);

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
 * Resolve `namespace.key` for a request down to the winning ROW.
 * Scope is the OUTER dimension (ADR-0003: scope → locale → default →
 * sentinel): every locale in the chain is tried at portal scope before
 * tenant, then global — so a tenant's own override beats generic copy
 * in another locale. Returns undefined on a total miss.
 */
export const resolveRow = (
	index: ReadonlyMap<string, MessageRow>,
	input: {
		readonly namespace: string;
		readonly key: string;
		readonly scopeChain: ScopeChain;
		readonly locales: LocaleChain;
	},
): MessageRow | undefined => {
	for (const { scope, scopeId } of input.scopeChain.scopes) {
		for (const locale of input.locales.locales) {
			const row = index.get(
				rowKey({
					namespace: input.namespace,
					key: input.key,
					locale,
					scope,
					scopeId,
				}),
			);
			if (row) return row;
		}
	}
	// Hand-built chains may omit the default locale — probe it last
	// across every scope so the documented fallback still holds.
	// Stryker disable next-line ConditionalExpression: when defaultLocale is already in locales, the extra probe only re-checks (scope, defaultLocale) pairs the main loop already missed — same hit/miss outcome (probe-verified identical).
	if (!input.locales.locales.includes(input.locales.defaultLocale)) {
		for (const { scope, scopeId } of input.scopeChain.scopes) {
			const row = index.get(
				rowKey({
					namespace: input.namespace,
					key: input.key,
					locale: input.locales.defaultLocale,
					scope,
					scopeId,
				}),
			);
			if (row) return row;
		}
	}
	return undefined;
};

/** Resolve `namespace.key` for a request; a total miss returns the
 * `namespace.key` sentinel (never blank — telemetry counts these). */
export const resolveMessage = (
	index: ReadonlyMap<string, MessageRow>,
	input: {
		readonly namespace: string;
		readonly key: string;
		readonly scopeChain: ScopeChain;
		readonly locales: LocaleChain;
	},
): ResolvedMessage => {
	const row = resolveRow(index, input);
	if (row !== undefined) {
		return {
			template: row.value,
			source: { kind: "hit", scope: row.scope, locale: row.locale, version: row.version },
		};
	}
	return {
		template: `${input.namespace}.${input.key}`,
		source: { kind: "missing" },
	};
};
