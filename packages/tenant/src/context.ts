import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { TenantSelector } from "./selector.ts";

/**
 * Request-scoped tenancy primitives (P-053) — the dependency-free core
 * shared by the resolver, scoped-repo and authz helpers. Kept separate
 * from `index.ts` so those modules never import the package entry point
 * (no import cycles).
 */

/** Built-in tenant roles, ranked owner > admin > member. Apps may store
 * additional role strings in their directory, but role assertions are
 * expressed against these three — see `requireTenantRole`. */
export type TenantRole = "owner" | "admin" | "member";

/** Tenant identity as carried on descriptors, wire payloads and
 * scoping helpers — `string | number` because selector transport and
 * some directories render ids as text. The canonical stored form is
 * the integer `tenant_id` column value (see {@link tenantStorageId}). */
export type TenantId = string | number;

/** A tenant as stored/looked up — identity without request role. */
export interface TenantDescriptor {
	readonly id: TenantId;
	readonly kind: string;
	readonly slug: string;
	readonly meta?: unknown;
}

/** The request-scoped tenant: descriptor + the caller's role in it. */
export interface Tenant extends TenantDescriptor {
	readonly role: TenantRole;
}

/**
 * Request-scoped tenant — which tenant the current effect acts in.
 *
 * Bound per request by the composition root (`runAs` in @ktb/app-host)
 * next to `Principal`. The default `null` marks personal scope: system
 * contexts (webhooks, jobs, `run()`) stay `null` until explicitly
 * re-bound via `runAsTenant` — ambient tenant is never inherited into
 * background work; an unscoped message is a bug, not a default.
 */
export const Tenant = Context.Reference<Tenant | null>("@ktb/tenant/Tenant", {
	defaultValue: () => null,
});

/**
 * Explicit accessible-tenant set for scoped reads. `null` (default)
 * derives the set from the bound `Tenant` — the active tenant only.
 * System flows that must read across several tenants (a nightly job
 * touching every clinic) bind a wider set via `withTenantAccess`;
 * personal (`NULL`) rows are always part of the visible set.
 */
export const TenantAccess = Context.Reference<readonly TenantId[] | null>(
	"@ktb/tenant/TenantAccess",
	{ defaultValue: () => null },
);

/** Run `effect` with an explicit accessible-tenant set (system flows). */
export const withTenantAccess = <A, E, R>(
	tenantIds: readonly TenantId[],
	effect: Effect.Effect<A, E, R>,
) => Effect.provideService(effect, TenantAccess, tenantIds);

/** Re-bind `Tenant` for the duration of `effect` — the system-flow
 * counterpart of `runAs`: queue consumers, webhook handlers and jobs
 * re-enter tenant scope from the `tenant_id` carried on their message
 * payload. Never relies on ambient context. */
export const runAsTenant = <A, E, R>(tenant: Tenant, effect: Effect.Effect<A, E, R>) =>
	Effect.provideService(effect, Tenant, tenant);

/** Numeric-looking string ids normalize to numbers — `tenant_id`
 * columns are integers and `accessibleTenantIds` consumers compare
 * numerically either way, but `inArray` fences stay exact. */
const normalizeTenantId = (id: string | number): string | number =>
	// Stryker disable next-line ConditionalExpression: for non-string ids the regex coerces via String(id); a match means Number(id) === id anyway, and non-matches return id unchanged
	typeof id === "string" && /^-?\d+$/.test(id) ? Number(id) : id;

/**
 * Re-bind tenant scope in system flows from a bare tenant id — the
 * shape queue messages, webhook row lookups and event payloads carry
 * (P-053 phase D). Binds {@link TenantAccess} to `[id]` so scoped
 * reads/writes fence to that tenant plus personal rows; `Tenant`
 * itself stays `null` because a system flow has no acting member or
 * role — `requireTenantRole` denies tenant-gated actions either way, and
 * create-path stamping (`tenantIdOf`) is only meaningful where a full
 * `Tenant` was resolved. A `null`/`undefined` id is personal scope —
 * pre-tenancy messages keep working unchanged.
 */
export const runAsTenantId = <A, E, R>(
	tenantId: TenantId | null | undefined,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	tenantId === null || tenantId === undefined
		? effect
		: Effect.provideService(effect, TenantAccess, [normalizeTenantId(tenantId)]);

/**
 * `tenant_id` column storage form of a {@link TenantId}: numeric ids
 * (a number, or a numeric-looking string per {@link normalizeTenantId})
 * normalize to the integer the column stores; non-numeric strings
 * resolve to `null` — they cannot be stamped, same contract as
 * {@link tenantScopeId} which delegates here.
 */
export const tenantStorageId = (id: TenantId | null | undefined): number | null => {
	if (id === null || id === undefined) return null;
	if (typeof id === "number") return Number.isFinite(id) ? id : null;
	return /^-?\d+$/.test(id) ? Number(id) : null;
};

/**
 * The `tenant_id` value a bound {@link Tenant} stamps and scopes by.
 * `Tenant.id` is `string | number` by contract but `tenant_id` columns
 * are integers (FK to `groups.id`): non-numeric ids cannot be stamped —
 * they resolve to `null` (personal scope) rather than pointing at a
 * bogus tenant. `null` tenant (personal/system scope) → `null`.
 */
export const tenantScopeId = (tenant: Tenant | null): number | null =>
	tenant === null ? null : tenantStorageId(tenant.id);

/** Selector did not resolve to an accessible tenant (unknown slug,
 * foreign tenant, unauthenticated caller). */
export class TenantNotFound extends Data.TaggedError("TenantNotFound")<{
	readonly selector: TenantSelector;
}> {}

/** Tenant scope is mandatory but none was selected/resolved — the
 * resolver's `"deny"` fallback and `requireTenant` failures. */
export class TenantRequired extends Data.TaggedError("TenantRequired")<{
	readonly reason: string;
}> {}

/** The bound tenant, failing `TenantRequired` when in personal scope. */
export const requireTenant = (path = "tenant") =>
	Effect.flatMap(Tenant, (tenant) =>
		tenant === null
			? Effect.fail(new TenantRequired({ reason: `tenant scope required (${path})` }))
			: Effect.succeed(tenant),
	);
