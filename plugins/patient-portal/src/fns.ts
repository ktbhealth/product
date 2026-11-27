import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Option from "effect/Option";

import { Audit, type AuditFacets, type AuditListQuery, type AuditListResult } from "@ktb/audit";
import {
	forbiddenTo,
	getPatientContext,
	getSessionUser,
	optionalSessionHandler,
	sessionHandler,
	setPatientSelection,
} from "@ktb/server-fns";

import { PatientPortal } from "./index.ts";

// Patient-portal plugin server functions — the patient side. Reads now
// happen inside the portal pages' loaders (/portal/patient/*); what is
// left here is the profile-selection mutation the home view calls and
// the session probe the legacy /portal redirects branch on.

const decodeNumber = Schema.decodeUnknownSync(Schema.Number);
const decodeDeviceKeys = Schema.decodeUnknownSync(
	Schema.Struct({
		wrapPublicKey: Schema.NonEmptyString,
		signPublicKey: Schema.NonEmptyString,
	}),
);
const decodeDekEnvelopes = Schema.decodeUnknownSync(
	Schema.Struct({
		entityType: Schema.Literals(["patient", "consultation"]),
		entityIds: Schema.Array(Schema.Union([Schema.Number, Schema.NonEmptyString])),
		wrapPublicKey: Schema.NonEmptyString,
	}),
);
const decodePatientActivity = Schema.decodeUnknownSync(Schema.Struct({ patientId: Schema.Number }));

/** Wire shape of {@link AuditListQuery} — same optionalKey/null-bucket
 * contract as the audit plugin's list fns. */
const ActivityQueryInput = Schema.Struct({
	limit: Schema.optionalKey(Schema.Number),
	offset: Schema.optionalKey(Schema.Number),
	actionGroup: Schema.optionalKey(Schema.NullOr(Schema.String)),
	actor: Schema.optionalKey(Schema.NullOr(Schema.String)),
	targetType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	q: Schema.optionalKey(Schema.NullOr(Schema.String)),
	since: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	until: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

const decodeActivityQuery = Schema.decodeUnknownSync(ActivityQueryInput);

type ActivityQueryWire = Schema.Schema.Type<typeof ActivityQueryInput>;

const toActivityQuery = (data: ActivityQueryWire): AuditListQuery => ({
	...(data.limit === undefined ? {} : { limit: data.limit }),
	...(data.offset === undefined ? {} : { offset: data.offset }),
	...(data.actionGroup === undefined ? {} : { actionGroup: data.actionGroup }),
	...(data.actor === undefined ? {} : { actor: data.actor }),
	...(data.targetType === undefined ? {} : { targetType: data.targetType }),
	...(data.q === undefined ? {} : { q: data.q }),
	...(data.since === undefined ? {} : { since: data.since }),
	...(data.until === undefined ? {} : { until: data.until }),
});

/**
 * Whether a session exists — the legacy `/portal` and
 * `/portal/consultations/$id` routes branch on it so anonymous visitors
 * keep landing on the patient sign-in page instead of the doctor one.
 */
export const portalSessionFn = createServerFn({ method: "GET" }).handler(async () => ({
	signedIn: (await getSessionUser()) !== null,
}));

/** Page size the portal activity feed asks for (P-086). */
const PATIENT_ACTIVITY_LIMIT = 100;

const ACTIVITY_EMPTY: AuditListResult = {
	entries: [],
	total: 0,
	limit: PATIENT_ACTIVITY_LIMIT,
	offset: 0,
};

/**
 * The patient-facing access log (P-086): audit entries naming
 * `patientId`'s own record. Authorization is the audit plugin's
 * `PatientAuditAccess` port (an active `patient_access` link — the
 * same grant the portal itself uses); anonymous callers, a missing
 * audit plugin and a denied check all collapse to an empty page —
 * the route never learns which case it was.
 */
export const patientActivityFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodePatientActivity(input))
	.handler(
		optionalSessionHandler(
			({ data }) => ACTIVITY_EMPTY,
			async ({ data, run }): Promise<AuditListResult> => {
				return run(
					Effect.gen(function* () {
						const audit = yield* Effect.serviceOption(Audit);
						if (Option.isNone(audit)) return ACTIVITY_EMPTY;
						return yield* audit.value
							.patientList({ patientId: data.patientId, limit: PATIENT_ACTIVITY_LIMIT })
							.pipe(forbiddenTo(ACTIVITY_EMPTY));
					}),
				);
			},
		),
	);

/**
 * Re-query the open record's access log with filters/pagination —
 * the /portal/patient/activity table's onQuery callback. Resolves the
 * active patient server-side (same `getPatientContext` the page
 * loader uses); no open record, an absent audit plugin and a denied
 * `PatientAuditAccess` check all collapse to an empty page.
 */
export const patientActivityQueryFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeActivityQuery(input ?? {}))
	.handler(
		optionalSessionHandler(
			({ data }) => ACTIVITY_EMPTY,
			async ({ data, run }): Promise<AuditListResult> => {
				const query = toActivityQuery(data);
				const context = await getPatientContext();
				const patientId = context?.active?.patientId ?? null;
				if (patientId === null) return ACTIVITY_EMPTY;
				return run(
					Effect.gen(function* () {
						const audit = yield* Effect.serviceOption(Audit);
						if (Option.isNone(audit)) return ACTIVITY_EMPTY;
						return yield* audit.value
							.patientList({ patientId, ...query })
							.pipe(forbiddenTo(ACTIVITY_EMPTY));
					}),
				);
			},
		),
	);

const EMPTY_FACETS: AuditFacets = { actionGroups: [], actors: [], targetTypes: [] };

/**
 * Distinct filter values within the open record's feed — same
 * fail-closed resolution as {@link patientActivityQueryFn}.
 */
export const patientActivityFacetsFn = createServerFn({ method: "POST" }).handler(
	optionalSessionHandler(
		() => EMPTY_FACETS,
		async ({ run }): Promise<AuditFacets> => {
			const context = await getPatientContext();
			const patientId = context?.active?.patientId ?? null;
			if (patientId === null) return EMPTY_FACETS;
			return run(
				Effect.gen(function* () {
					const audit = yield* Effect.serviceOption(Audit);
					if (Option.isNone(audit)) return EMPTY_FACETS;
					return yield* audit.value.patientFacets({ patientId }).pipe(forbiddenTo(EMPTY_FACETS));
				}),
			);
		},
	),
);

/** Open `patientId` in the portal from now on. Refused (`{ ok: false }`)
 * for a record the user holds no active link to. */
export const selectPatientFn = createServerFn({ method: "POST" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: patientId }) => {
		const context = await getPatientContext();
		if (!context?.profiles.some((p) => p.patientId === patientId)) return { ok: false };
		await setPatientSelection(patientId);
		return { ok: true };
	});

/**
 * Publish this device's public keys (T-148): the browser generates a
 * non-extractable keypair on first portal use and registers its public
 * halves here so an approved clinic device can wrap record DEKs to
 * them. Self-service — the row is keyed by the session user's own id.
 */
export const portalRegisterDeviceFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeDeviceKeys(input))
	.handler(
		sessionHandler(async ({ data, run }) => {
			return run(
				Effect.gen(function* () {
					const portal = yield* PatientPortal;
					return yield* portal.registerDevice(data).pipe(
						Effect.map((device) => ({ ok: true as const, device })),
						forbiddenTo({ ok: false as const }),
					);
				}),
			);
		}),
	);

/**
 * The caller's wrapped DEK envelopes for a batch of records, keyed by
 * entityId (T-148) — the portal mirror of `vaultDekEnvelopesFn`, which
 * is member-scoped and unreachable for portal users (no tenant
 * binding). Records the caller cannot read are simply absent.
 */
export const portalDekEnvelopesFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeDekEnvelopes(input))
	.handler(
		optionalSessionHandler(
			({ data }) => ({}),
			async ({ data, run }): Promise<Record<string, string>> => {
				return run(
					Effect.gen(function* () {
						const portal = yield* PatientPortal;
						return yield* portal.dekEnvelopes(data).pipe(forbiddenTo({}));
					}),
				);
			},
		),
	);
