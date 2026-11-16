import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Option from "effect/Option";

import { Audit, type AuditListResult } from "@ktb/audit";
import {
	ensureSessionUser,
	getLocale,
	getPatientContext,
	getSessionUser,
	runAs,
	setPatientSelection,
} from "@ktb/server-fns";

import { PatientPortal, type PortalConsultation } from "./index.ts";

// Patient-portal plugin server functions — the patient side. Every call
// runs as the *session* user: the portal shows what the person signed
// in may see, never what a doctor they act for may. Clinical data is
// read-only here: the portal lists and opens consultations, nothing more.

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

/** Active UI locale for the current request — route loaders attach it
 * to their data so plugin views never import the host's i18n runtime. */
export const localeFn = createServerFn({ method: "GET" }).handler(() => getLocale());

/**
 * Everything the portal home shows; null for anonymous visitors. An
 * entry point: invites are claimed first, so a new link shows up as
 * soon as the patient opens the portal.
 */
export const portalFn = createServerFn({ method: "GET" }).handler(async () => {
	const context = await getPatientContext(undefined, { syncLinks: true });
	if (!context) return null;
	const { user, profiles, active } = context;
	return runAs(
		user,
		Effect.gen(function* () {
			const portal = yield* PatientPortal;
			return {
				user: { name: user.name, email: user.email },
				awaitingInvites: yield* portal.awaitingInvites(),
				profiles,
				profile: active === null ? null : yield* portal.profile(active.patientId),
				consultations: active === null ? [] : yield* portal.consultations(active.patientId),
			};
		}).pipe(
			// The link was revoked between resolving the context and reading it.
			Effect.catchTag("Forbidden", () =>
				Effect.succeed({
					user: { name: user.name, email: user.email },
					awaitingInvites: 0,
					profiles: [],
					profile: null,
					consultations: [],
				}),
			),
		),
	);
});

export type PortalConsultationResult =
	| { readonly status: "anonymous" }
	| { readonly status: "missing" }
	| { readonly status: "ok"; readonly consultation: PortalConsultation };

/**
 * One consultation, read-only. "missing" covers both a consultation that
 * does not exist and one the user holds no active link to — the portal
 * never tells the two apart.
 */
export const portalConsultationFn = createServerFn({ method: "GET" })
	.validator((id: number) => decodeNumber(id))
	.handler(async ({ data: id }): Promise<PortalConsultationResult> => {
		const user = await getSessionUser();
		if (!user) return { status: "anonymous" };
		return runAs(
			user,
			Effect.gen(function* () {
				const portal = yield* PatientPortal;
				return { status: "ok" as const, consultation: yield* portal.consultation(id) };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ status: "missing" as const }))),
		);
	});

/** Page size the portal activity feed asks for (P-086). */
const PATIENT_ACTIVITY_LIMIT = 100;

const ACTIVITY_EMPTY: AuditListResult = {
	entries: [],
	total: 0,
	limit: PATIENT_ACTIVITY_LIMIT,
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
	.handler(async ({ data }): Promise<AuditListResult> => {
		const user = await getSessionUser();
		if (!user) return ACTIVITY_EMPTY;
		return runAs(
			user,
			Effect.gen(function* () {
				const audit = yield* Effect.serviceOption(Audit);
				if (Option.isNone(audit)) return ACTIVITY_EMPTY;
				return yield* audit.value
					.patientList({ patientId: data.patientId, limit: PATIENT_ACTIVITY_LIMIT })
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(ACTIVITY_EMPTY)));
			}),
		);
	});

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
	.handler(async ({ data }) => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const portal = yield* PatientPortal;
				return yield* portal.registerDevice(data).pipe(
					Effect.map((device) => ({ ok: true as const, device })),
					Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false as const })),
				);
			}),
		);
	});

/**
 * The caller's wrapped DEK envelopes for a batch of records, keyed by
 * entityId (T-148) — the portal mirror of `vaultDekEnvelopesFn`, which
 * is member-scoped and unreachable for portal users (no tenant
 * binding). Records the caller cannot read are simply absent.
 */
export const portalDekEnvelopesFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeDekEnvelopes(input))
	.handler(async ({ data }): Promise<Record<string, string>> => {
		const user = await getSessionUser();
		if (!user) return {};
		return runAs(
			user,
			Effect.gen(function* () {
				const portal = yield* PatientPortal;
				return yield* portal
					.dekEnvelopes(data)
					.pipe(Effect.catchTag("Forbidden", () => Effect.succeed({})));
			}),
		);
	});
