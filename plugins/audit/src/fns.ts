import { createServerFn } from "@tanstack/react-start";

import { forbiddenTo, getTenantSelector, optionalSessionHandler, runAs } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Schema } from "effect";

import {
	Audit,
	type AuditFacets,
	type AuditListQuery,
	type AuditListResult,
	type AuditVerifyResult,
} from "./index.ts";

// Audit plugin server functions: route/view modules under src/** reach
// the app runtime through @ktb/server-fns — no host imports. The
// /platform/audit "Verify chain" action calls auditVerifyFn; the
// PlatformAdmin gate re-runs inside Audit.adminVerify (defense in
// depth, same contract as the page guard).

/**
 * On-demand tamper-evident chain walk (T-139): platform admins only.
 * `null` for anonymous callers, non-admins (Forbidden → null, same
 * "not visible" contract as the other admin fns) and when the Audit
 * service is absent from the runtime.
 */
export const auditVerifyFn = createServerFn({ method: "GET" }).handler(
	optionalSessionHandler(
		() => null,
		async ({ run }): Promise<AuditVerifyResult | null> => {
			return run(
				Effect.gen(function* () {
					const audit = yield* Effect.serviceOption(Audit);
					if (Option.isNone(audit)) return null;
					return yield* audit.value.adminVerify().pipe(forbiddenTo(null));
				}),
			);
		},
	),
);

// ---------- filtered/paginated listings (audit logs UI) ----------

/** Wire shape of {@link AuditListQuery} — optionalKey keeps "absent"
 * distinct from an explicit `null` (the NULL-column bucket filter). */
const ListQueryInput = Schema.Struct({
	limit: Schema.optionalKey(Schema.Number),
	offset: Schema.optionalKey(Schema.Number),
	actionGroup: Schema.optionalKey(Schema.NullOr(Schema.String)),
	actor: Schema.optionalKey(Schema.NullOr(Schema.String)),
	targetType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	q: Schema.optionalKey(Schema.NullOr(Schema.String)),
	since: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	until: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

const decodeListQuery = Schema.decodeUnknownSync(ListQueryInput);

type ListQueryWire = Schema.Schema.Type<typeof ListQueryInput>;

/** Strip `patientId`-style extras defensively — the service takes the
 * query fields verbatim; unknown keys never reach it. */
const toQuery = (data: ListQueryWire): AuditListQuery => ({
	...(data.limit === undefined ? {} : { limit: data.limit }),
	...(data.offset === undefined ? {} : { offset: data.offset }),
	...(data.actionGroup === undefined ? {} : { actionGroup: data.actionGroup }),
	...(data.actor === undefined ? {} : { actor: data.actor }),
	...(data.targetType === undefined ? {} : { targetType: data.targetType }),
	...(data.q === undefined ? {} : { q: data.q }),
	...(data.since === undefined ? {} : { since: data.since }),
	...(data.until === undefined ? {} : { until: data.until }),
});

const EMPTY_PAGE = (query: AuditListQuery): AuditListResult => ({
	entries: [],
	total: 0,
	limit: query.limit ?? 200,
	offset: query.offset ?? 0,
});

/**
 * Re-query the platform admin log with filters/pagination — the
 * /platform/audit table's onQuery callback. Same fail-closed contract
 * as the page loader: anonymous callers and non-admins (Forbidden)
 * collapse to an empty page, so the route never learns which case it
 * was. The `PlatformAdmin` gate re-runs inside `Audit.adminList`.
 */
export const auditAdminListFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeListQuery(input ?? {}))
	.handler(
		optionalSessionHandler(
			({ data }) => EMPTY_PAGE(toQuery(data)),
			async ({ data, run }): Promise<AuditListResult> => {
				const query = toQuery(data);
				return run(
					Effect.gen(function* () {
						const audit = yield* Effect.serviceOption(Audit);
						if (Option.isNone(audit)) return EMPTY_PAGE(query);
						return yield* audit.value.adminList(query).pipe(forbiddenTo(EMPTY_PAGE(query)));
					}),
				);
			},
		),
	);

/**
 * Re-query the actor-scoped staff activity feed — the
 * /portal/<instance>/activity table's onQuery callback. The tenant
 * selector is forwarded so `runAs` binds the same request context the
 * page loader resolved; an absent principal or empty actor scope
 * fails closed inside `Audit.activityList` → empty page.
 */
export const auditActivityListFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeListQuery(input ?? {}))
	.handler(
		optionalSessionHandler(
			({ data }) => EMPTY_PAGE(toQuery(data)),
			async ({ data, user }): Promise<AuditListResult> => {
				const query = toQuery(data);
				const tenantSelector = await getTenantSelector();
				return runAs(
					user,
					Effect.gen(function* () {
						const audit = yield* Effect.serviceOption(Audit);
						if (Option.isNone(audit)) return EMPTY_PAGE(query);
						return yield* audit.value.activityList(query).pipe(forbiddenTo(EMPTY_PAGE(query)));
					}),
					tenantSelector,
				);
			},
		),
	);

const EMPTY_FACETS: AuditFacets = { actionGroups: [], actors: [], targetTypes: [] };

/**
 * Distinct filter values for the /platform/audit dropdowns — same
 * fail-closed contract as {@link auditAdminListFn}.
 */
export const auditAdminFacetsFn = createServerFn({ method: "GET" }).handler(
	optionalSessionHandler(
		() => EMPTY_FACETS,
		async ({ run }): Promise<AuditFacets> => {
			return run(
				Effect.gen(function* () {
					const audit = yield* Effect.serviceOption(Audit);
					if (Option.isNone(audit)) return EMPTY_FACETS;
					return yield* audit.value.adminFacets().pipe(forbiddenTo(EMPTY_FACETS));
				}),
			);
		},
	),
);

/**
 * Distinct filter values within the bound actor scope's activity
 * feed — same tenant-selector forwarding as {@link auditActivityListFn}.
 */
export const auditActivityFacetsFn = createServerFn({ method: "GET" }).handler(
	optionalSessionHandler(
		() => EMPTY_FACETS,
		async ({ user }): Promise<AuditFacets> => {
			const tenantSelector = await getTenantSelector();
			return runAs(
				user,
				Effect.gen(function* () {
					const audit = yield* Effect.serviceOption(Audit);
					if (Option.isNone(audit)) return EMPTY_FACETS;
					return yield* audit.value.activityFacets().pipe(forbiddenTo(EMPTY_FACETS));
				}),
				tenantSelector,
			);
		},
	),
);
