import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, eq, inArray, isNotNull, like, or } from "drizzle-orm";

import { Db } from "@ktb/db";
import { consultations, patientAccess, patients, portalKeys } from "@ktb/db/schema";
import { Email } from "@ktb/email";
import { inviteAcceptPath } from "@ktb/invites";
import {
	getDoctorAccess,
	getDoctorContext,
	getDoctorUser,
	getLocale,
	run,
	runAs,
} from "@ktb/server-fns";
import { tenantZkOrClosed } from "@ktb/vault";

import { patientAccessMessages } from "./i18n.ts";
import { PatientLinks, type PatientInviteErrorCode, type PatientLink } from "./index.ts";

// Patient-access plugin server functions — the doctor side of portal
// access. Every call runs as the *acting doctor* (`getDoctorUser`), so a
// secretary manages links for the doctor they act for; the service
// scopes every operation to that doctor's patients.

const decodeNumber = Schema.decodeUnknownSync(Schema.Number);
const decodeInvite = Schema.decodeUnknownSync(
	Schema.Struct({
		patientId: Schema.Number,
		email: Schema.String,
		relation: Schema.String,
	}),
);

/** Doctor-side standing of the request — drives the route guard. */
export const doctorAccessFn = createServerFn({ method: "GET" }).handler(() => getDoctorAccess());

/** Which clinical portal instance this request belongs in — "doctor"
 * for own-profile accounts, "secretary" for delegated-only ones. Null
 * for anonymous visitors and for accounts with no doctor side. */
export const clinicalPortalFn = createServerFn({ method: "GET" }).handler(async () => {
	const context = await getDoctorContext();
	if (!context) return null;
	return context.profiles.some((p) => p.role === "owner") ? "doctor" : "secretary";
});

/**
 * A patient of the acting doctor with its portal links; null when the
 * caller is not acting as a doctor or the patient is not theirs. The
 * record's email comes along so an invite can be prefilled with it.
 */
export const patientLinksFn = createServerFn({ method: "GET" })
	.validator((patientId: number) => decodeNumber(patientId))
	.handler(async ({ data: patientId }) => {
		const user = await getDoctorUser();
		if (!user) return null;
		return runAs(
			user,
			Effect.gen(function* () {
				const service = yield* PatientLinks;
				const links = yield* service.list(patientId);
				const db = yield* Db;
				const [patient] = yield* Effect.promise(() =>
					db
						.select({
							id: patients.id,
							name: patients.name,
							email: patients.email,
						})
						.from(patients)
						.where(and(eq(patients.id, patientId), eq(patients.ownerId, user.id))),
				);
				// Deleted between the ownership check and this read.
				if (patient === undefined) return null;
				return { patient, links };
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null))),
		);
	});

export type InvitePatientResult =
	| {
			readonly ok: true;
			readonly link: Pick<PatientLink, "id" | "email" | "status">;
			/** Whether the access email actually went out — false when this
			 * deployment sends no email or the delivery failed. */
			readonly emailed: boolean;
	  }
	| { readonly ok: false; readonly error: PatientInviteErrorCode | "failed" };

/**
 * Tell the invitee by email, in the acting user's current locale.
 * Someone with no account yet gets a single-use accept link that
 * creates it; an existing account is pointed at the portal sign-in.
 * Best effort: the grant already exists, so a deployment without email
 * or a failed delivery never fails the invite — it only reports `false`.
 */
const notifyInvitee = async (
	to: string,
	doctorName: string,
	patientName: string | null,
): Promise<boolean> => {
	const { getRequestUrl } = await import("@tanstack/react-start/server");
	const copy = patientAccessMessages(getLocale()).inviteEmail;
	const sender = await run(
		Effect.map(Effect.serviceOption(Email), (email) => Option.getOrNull(email)),
	);
	if (!sender) return false;
	const acceptPath = await run(
		inviteAcceptPath({ email: to, kind: "patient", inviterName: doctorName }),
	);
	const url = new URL(acceptPath ?? "/login/patient", getRequestUrl()).toString();
	try {
		await sender.send({
			to,
			subject: copy.subject(doctorName),
			text: copy.body(doctorName, patientName, url, acceptPath !== null),
		});
		return true;
	} catch (error) {
		console.error("patient invite email failed", error);
		return false;
	}
};

/** Invite an email to a patient record of the acting doctor. */
export const invitePatientFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeInvite(input))
	.handler(async ({ data }): Promise<InvitePatientResult> => {
		const user = await getDoctorUser();
		if (!user) return { ok: false, error: "failed" };
		const result = await runAs(
			user,
			Effect.gen(function* () {
				const service = yield* PatientLinks;
				const row = yield* service.invite(data);
				const db = yield* Db;
				const [patient] = yield* Effect.promise(() =>
					db
						.select({ name: patients.name, tenantId: patients.tenantId })
						.from(patients)
						.where(eq(patients.id, data.patientId)),
				);
				// T-149: under ZK the stored name is ciphertext the server
				// cannot read — the invite email must be metadata-only (no
				// patient name). The gate fails closed: an unresolvable
				// tenant gets the generic copy rather than a leak.
				const zk =
					patient !== undefined &&
					(yield* Effect.promise(() => tenantZkOrClosed(db, patient.tenantId)));
				return {
					ok: true as const,
					link: { id: row.id, email: row.email ?? "", status: row.status },
					// Deleted between the ownership check and this read — the
					// grant stands, there is just no name for the email. Under
					// ZK the name is dropped the same way.
					patientName: patient === undefined || zk ? null : patient.name,
					patientExists: patient !== undefined,
				};
			}).pipe(
				Effect.catchTag("PatientInviteRejected", (e) =>
					Effect.succeed({ ok: false as const, error: e.code }),
				),
				Effect.catchTag("Forbidden", () =>
					Effect.succeed({ ok: false as const, error: "failed" as const }),
				),
			),
		);
		if (!result.ok) return result;
		const emailed = !result.patientExists
			? false
			: await notifyInvitee(
					result.link.email,
					user.doctor.name ?? user.doctor.email,
					result.patientName,
				);
		return { ok: true, link: result.link, emailed };
	});

/** Apply `action` to link `id` as the acting doctor; `{ ok: false }`
 * for non-doctors and for a link that is not one of their patients'. */
const changeLink = async (action: "approve" | "revoke", id: number) => {
	const user = await getDoctorUser();
	if (!user) return { ok: false };
	return runAs(
		user,
		Effect.gen(function* () {
			const service = yield* PatientLinks;
			return { ok: yield* service[action](id) };
		}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false }))),
	);
};

// Each server fn is its own top-level `createServerFn` chain: the Start
// compiler only turns those into RPC stubs. One built by a factory is
// left as-is, so its handler would run — and fail — in the browser.

/** Approve a link still pending on one of the acting doctor's patients. */
export const approvePatientLinkFn = createServerFn({ method: "POST" })
	.validator((id: number) => decodeNumber(id))
	.handler(({ data: id }) => changeLink("approve", id));

/** Remove a link from one of the acting doctor's patients. */
export const revokePatientLinkFn = createServerFn({ method: "POST" })
	.validator((id: number) => decodeNumber(id))
	.handler(({ data: id }) => changeLink("revoke", id));

/** A registered portal device of a user holding an active link — the
 * recipient a clinic device wraps record DEKs to (T-148). */
export interface PortalReader {
	readonly readerId: string;
	readonly wrapPublicKey: string;
}

/**
 * Everything an approved clinic device needs to extend portal access
 * to one of the acting doctor's patients (T-148): the registered
 * device pubkeys of users holding an *active* link (`portal_keys` —
 * users publish them on portal login) and the patient's ciphered
 * consultations — the entities whose DEKs get wrapped to those
 * pubkeys. Null for non-doctors and foreign patients (the
 * `PatientLinks.list` authz decides).
 */
export const portalReadersFn = createServerFn({ method: "GET" })
	.validator((id: number) => decodeNumber(id))
	.handler(
		async ({
			data: patientId,
		}): Promise<{
			readonly readers: readonly PortalReader[];
			readonly cipheredConsultationIds: readonly number[];
		} | null> => {
			const user = await getDoctorUser();
			if (!user) return null;
			return runAs(
				user,
				Effect.gen(function* () {
					const service = yield* PatientLinks;
					// Ownership gate — same authz as the links page itself.
					yield* service.list(patientId);
					const db = yield* Db;
					const linked = yield* Effect.promise(() =>
						db
							.select({ userId: patientAccess.userId })
							.from(patientAccess)
							.where(
								and(
									eq(patientAccess.patientId, patientId),
									eq(patientAccess.status, "active"),
									isNotNull(patientAccess.userId),
								),
							),
					);
					const userIds = linked.map((l) => l.userId!);
					const readers = yield* Effect.promise(() =>
						userIds.length === 0
							? Promise.resolve([] as PortalReader[])
							: db
									.select({
										readerId: portalKeys.userId,
										wrapPublicKey: portalKeys.wrapPublicKey,
									})
									.from(portalKeys)
									.where(inArray(portalKeys.userId, userIds)),
					);
					const ciphered = yield* Effect.promise(() =>
						db
							.select({ id: consultations.id })
							.from(consultations)
							.where(
								and(
									eq(consultations.patientId, patientId),
									or(like(consultations.anamnesis, "v1.%"), like(consultations.transcript, "v1.%")),
								),
							),
					);
					return { readers, cipheredConsultationIds: ciphered.map((c) => c.id) };
				}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null))),
			);
		},
	);
