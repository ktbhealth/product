import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { physical } from "@tanstack/virtual-file-routes";

import { Forbidden, Principal } from "@ktb/authz";
import { audit, auditServicesPlugin } from "@ktb/audit";
import { Db, type DbClient } from "@ktb/db";
import { consultations, doctors, entityDeks, patientAccess, patients, user } from "@ktb/db/schema";
import { normalizeEmail } from "@ktb/patient-access";
import { enrollPortalDevice, portalDeviceOf, type PortalKey } from "@ktb/vault";
import { definePlugin, type Plugin } from "@ktb/kernel";

import { parseAnamnesis, portalSections, written, type PortalSection } from "./sections.ts";

export type { PortalSection } from "./sections.ts";
export { parseAnamnesis, portalSections } from "./sections.ts";

/**
 * The patient record a portal profile opens: whose it is and who keeps
 * it. The portal is read-only and shows consultations only — the
 * record's registration data stays on the doctor side.
 */
export interface PortalProfile {
	readonly patientId: number;
	readonly relation: string;
	readonly name: string;
	/** Display name of the doctor who keeps the record, when known. */
	readonly doctorName: string | null;
}

/** The record `patientId` as `userId` may see it — null unless they hold
 * an *active* link to it. */
export async function getPortalProfile(
	db: DbClient,
	userId: string,
	patientId: number,
): Promise<PortalProfile | null> {
	const [row] = await db
		.select({
			patientId: patients.id,
			relation: patientAccess.relation,
			name: patients.name,
			doctorName: doctors.displayName,
		})
		.from(patientAccess)
		.innerJoin(patients, eq(patientAccess.patientId, patients.id))
		.leftJoin(doctors, eq(doctors.userId, patients.ownerId))
		.where(
			and(
				eq(patientAccess.patientId, patientId),
				eq(patientAccess.userId, userId),
				eq(patientAccess.status, "active"),
			),
		);
	return row ?? null;
}

/** `v1.` AEAD envelope marker (same rule as `@ktb/patients/zk`'s
 * `isEnvelope`): an envelope in a clinical column means the row is
 * client-encrypted — the server ships it opaque and the portal
 * decrypts in the browser (T-148). */
const isEnvelope = (value: unknown): value is string =>
	typeof value === "string" && value.startsWith("v1.");

/** A consultation as the portal lists it. */
export interface PortalConsultationSummary {
	readonly id: number;
	readonly createdAt: Date;
	/** Chief complaint as the doctor recorded it, when there is one.
	 * Null under ZK — the client fills it after decrypting `anamnesis`. */
	readonly chiefComplaint: string | null;
	/** The raw `anamnesis` column when it is a `v1.` envelope, else null —
	 * the client decrypts and derives the complaint itself. */
	readonly anamnesis: string | null;
}

/** A consultation as the portal shows it: the saved record, read-only.
 * Transcript and audio never leave the doctor side. */
export interface PortalConsultation {
	readonly id: number;
	readonly createdAt: Date;
	readonly patientId: number;
	/** Patient display name — a `v1.` envelope under ZK; the client
	 * decrypts it with the patient-record DEK granted to its device. */
	readonly patientName: string;
	/** Display name of the doctor who recorded it, when known. */
	readonly doctorName: string | null;
	readonly sections: readonly PortalSection[];
	/** The raw `anamnesis` column when it is a `v1.` envelope, else null —
	 * under ZK `sections` is empty and the client decrypts this. */
	readonly anamnesis: string | null;
}

/** Internal read shape: `getPortalConsultation` also returns the row's
 * `tenant_id` so the service can scope the sensitive-read audit entry —
 * it is stripped before the value crosses the wire (portal clients get
 * {@link PortalConsultation} only). */
export type PortalConsultationRead = PortalConsultation & {
	readonly tenantId: number | null;
};

/** Rows of `consultations` a holder of an *active* link may see: the
 * ones with a saved record. A consultation still being transcribed, or
 * saved without an anamnesis, is not shown. */
const visibleTo = (userId: string) =>
	and(
		eq(patientAccess.userId, userId),
		eq(patientAccess.status, "active"),
		isNotNull(consultations.anamnesis),
	);

/**
 * The consultations of `patientId` as `userId` may see them, newest
 * first — empty unless they hold an *active* link to the record.
 */
export async function listPortalConsultations(
	db: DbClient,
	userId: string,
	patientId: number,
): Promise<PortalConsultationSummary[]> {
	const rows = await db
		.select({
			id: consultations.id,
			createdAt: consultations.createdAt,
			anamnesis: consultations.anamnesis,
		})
		.from(consultations)
		.innerJoin(patientAccess, eq(patientAccess.patientId, consultations.patientId))
		.where(and(eq(consultations.patientId, patientId), visibleTo(userId)))
		.orderBy(desc(consultations.createdAt), desc(consultations.id));
	return rows.flatMap(({ anamnesis, ...row }): PortalConsultationSummary[] => {
		// T-148: a ZK row is opaque — list it with the raw envelope so the
		// client can decrypt; the complaint derives after decrypting.
		if (isEnvelope(anamnesis)) return [{ ...row, chiefComplaint: null, anamnesis }];
		const parsed = parseAnamnesis(anamnesis);
		if (parsed === null) return [];
		return [{ ...row, chiefComplaint: written(parsed.queixa_principal.content), anamnesis: null }];
	});
}

/**
 * Consultation `id` as `userId` may see it — null unless it has a saved
 * record and they hold an *active* link to its patient.
 */
export async function getPortalConsultation(
	db: DbClient,
	userId: string,
	id: number,
): Promise<PortalConsultationRead | null> {
	const [row] = await db
		.select({
			id: consultations.id,
			createdAt: consultations.createdAt,
			anamnesis: consultations.anamnesis,
			patientId: patients.id,
			tenantId: consultations.tenantId,
			patientName: patients.name,
			doctorName: doctors.displayName,
		})
		.from(consultations)
		.innerJoin(patients, eq(consultations.patientId, patients.id))
		.innerJoin(patientAccess, eq(patientAccess.patientId, patients.id))
		.leftJoin(doctors, eq(doctors.userId, consultations.userId))
		.where(and(eq(consultations.id, id), visibleTo(userId)));
	if (row === undefined) return null;
	const { anamnesis, ...consultation } = row;
	// T-148: a ZK row ships its envelope untouched — the portal unwraps
	// the record DEK for the caller's device and decrypts client-side.
	if (isEnvelope(anamnesis)) return { ...consultation, sections: [], anamnesis };
	const parsed = parseAnamnesis(anamnesis);
	if (parsed === null) return null;
	return { ...consultation, sections: portalSections(parsed), anamnesis: null };
}

/**
 * Invites addressed to the user's account email still sitting unclaimed
 * because the address is not verified — how many records wait on the
 * verification step. Zero for a verified address: every matching invite
 * is claimed by `syncLinks` on the next entry point, so a lingering one
 * can only belong to an unverified account. The email comparison uses
 * the same normalization the invite write path applies.
 */
export async function countAwaitingInvites(db: DbClient, userId: string): Promise<number> {
	const [account] = await db
		.select({ email: user.email, emailVerified: user.emailVerified })
		.from(user)
		.where(eq(user.id, userId));
	if (account === undefined || account.emailVerified) return 0;
	const rows = await db
		.select({ id: patientAccess.id })
		.from(patientAccess)
		.where(
			and(
				eq(patientAccess.email, normalizeEmail(account.email)),
				eq(patientAccess.status, "invited"),
			),
		);
	return rows.length;
}

/**
 * The `entity_deks` envelope addressed to one of the caller's OWN
 * portal devices for one record (T-148) — the portal-side counterpart
 * of the member-scoped `vault.dekEnvelope`. Authorization is the
 * portal rule, not tenant membership: the `wrapPublicKey` must be
 * registered to the caller (`portal_keys`), the record must resolve to
 * a patient the caller holds an *active* link to, and the tenant id is
 * read off the record itself (a portal identity spans clinics). Any
 * check failing yields null — indistinguishable from "no grant".
 */
export async function portalDekEnvelope(
	db: DbClient,
	userId: string,
	input: {
		readonly entityType: "patient" | "consultation";
		readonly entityId: number | string;
		readonly wrapPublicKey: string;
	},
): Promise<string | null> {
	const entityId = Number(input.entityId);
	if (!Number.isInteger(entityId)) return null;
	const device = await portalDeviceOf(db, userId, input.wrapPublicKey);
	if (device === null) return null;
	let patientId: number;
	let tenantId: number | null;
	if (input.entityType === "consultation") {
		const [row] = await db
			.select({ patientId: consultations.patientId, tenantId: consultations.tenantId })
			.from(consultations)
			.where(eq(consultations.id, entityId))
			.limit(1);
		if (row === undefined || row.patientId === null) return null;
		patientId = row.patientId;
		tenantId = row.tenantId;
	} else {
		const [row] = await db
			.select({ tenantId: patients.tenantId })
			.from(patients)
			.where(eq(patients.id, entityId))
			.limit(1);
		if (row === undefined) return null;
		patientId = entityId;
		tenantId = row.tenantId;
	}
	// entity_deks rows are tenant-owned — a personal (tenantless)
	// record can never carry a grant.
	if (tenantId === null) return null;
	const [link] = await db
		.select({ id: patientAccess.id })
		.from(patientAccess)
		.where(
			and(
				eq(patientAccess.patientId, patientId),
				eq(patientAccess.userId, userId),
				eq(patientAccess.status, "active"),
			),
		)
		.limit(1);
	if (link === undefined) return null;
	const [dek] = await db
		.select({ wrappedDek: entityDeks.wrappedDek })
		.from(entityDeks)
		.where(
			and(
				eq(entityDeks.tenantId, tenantId),
				eq(entityDeks.entityType, input.entityType),
				eq(entityDeks.entityId, String(entityId)),
				eq(entityDeks.readerPubkey, input.wrapPublicKey),
			),
		)
		.limit(1);
	return dek?.wrappedDek ?? null;
}

/**
 * Patient portal port — the *patient* side: read-only on clinical data,
 * and everything is scoped to the signed-in user themself. Fails
 * `Forbidden` without a principal and under delegation (a secretary
 * acting for a doctor has no business in someone's portal).
 */
export class PatientPortal extends Context.Service<
	PatientPortal,
	{
		/** A record the caller holds an active link to; Forbidden otherwise. */
		readonly profile: (patientId: number) => Effect.Effect<PortalProfile, Forbidden>;
		/** The consultations of a record the caller holds an active link
		 * to, newest first — empty without one. */
		readonly consultations: (
			patientId: number,
		) => Effect.Effect<PortalConsultationSummary[], Forbidden>;
		/** One consultation of a record the caller holds an active link
		 * to; Forbidden otherwise, and for one with no saved record. */
		readonly consultation: (id: number) => Effect.Effect<PortalConsultation, Forbidden>;
		/** Invites addressed to the caller's email still waiting on email
		 * verification — the count behind the "confirm your email" notice. */
		readonly awaitingInvites: () => Effect.Effect<number, Forbidden>;
		/** Register the caller's portal device pubkeys (T-148) — the
		 * non-extractable browser keypair's public halves, published so a
		 * clinic device can wrap record DEKs to them. Idempotent. */
		readonly registerDevice: (input: {
			readonly wrapPublicKey: string;
			readonly signPublicKey: string;
		}) => Effect.Effect<PortalKey, Forbidden>;
		/** The caller's wrapped DEKs for a batch of records, keyed by
		 * entityId — records without a grant are absent (T-148). */
		readonly dekEnvelopes: (input: {
			readonly entityType: "patient" | "consultation";
			readonly entityIds: readonly (number | string)[];
			readonly wrapPublicKey: string;
		}) => Effect.Effect<Record<string, string>, Forbidden>;
	}
>()("@ktb/patient-portal/PatientPortal") {}

export const PatientPortalLive = Layer.effect(
	PatientPortal,
	Effect.gen(function* () {
		const db = yield* Db;
		const self = (path: string) =>
			Effect.flatMap(Principal, (principal) =>
				principal === null || principal.actorId !== undefined
					? Effect.fail(new Forbidden({ path }))
					: Effect.succeed(principal.userId),
			);
		return PatientPortal.of({
			profile: Effect.fn("PatientPortal.profile")(function* (patientId: number) {
				const userId = yield* self("portal.read");
				const profile = yield* Effect.promise(() => getPortalProfile(db, userId, patientId));
				if (profile === null) return yield* Effect.fail(new Forbidden({ path: "portal.read" }));
				return profile;
			}),
			consultations: Effect.fn("PatientPortal.consultations")(function* (patientId: number) {
				const userId = yield* self("portal.read");
				return yield* Effect.promise(() => listPortalConsultations(db, userId, patientId));
			}),
			consultation: Effect.fn("PatientPortal.consultation")(function* (id: number) {
				const userId = yield* self("portal.read");
				const found = yield* Effect.promise(() => getPortalConsultation(db, userId, id));
				if (found === null) return yield* Effect.fail(new Forbidden({ path: "portal.read" }));
				// Sensitive-read audit (P-086 feed): same `consultations.read`
				// action the clinician detail read emits, `via: "portal"`
				// marks the patient-facing path; tenant_id is row-authoritative.
				// ids only — the record content never leaves the audit log.
				yield* audit({
					action: "consultations.read",
					targetType: "consultation",
					targetId: found.id,
					tenantId: found.tenantId,
					detail: { patientId: found.patientId, via: "portal" },
				});
				const { tenantId: _tenantId, ...consultation } = found;
				return consultation;
			}),
			awaitingInvites: Effect.fn("PatientPortal.awaitingInvites")(function* () {
				const userId = yield* self("portal.read");
				return yield* Effect.promise(() => countAwaitingInvites(db, userId));
			}),
			registerDevice: Effect.fn("PatientPortal.registerDevice")(function* (input) {
				const userId = yield* self("portal.device");
				return yield* Effect.promise(() => enrollPortalDevice(db, { userId, ...input }));
			}),
			dekEnvelopes: Effect.fn("PatientPortal.dekEnvelopes")(function* (input) {
				const userId = yield* self("portal.read");
				const out: Record<string, string> = {};
				for (const entityId of input.entityIds) {
					const envelope = yield* Effect.promise(() =>
						portalDekEnvelope(db, userId, {
							entityType: input.entityType,
							entityId,
							wrapPublicKey: input.wrapPublicKey,
						}),
					);
					if (envelope !== null) out[String(entityId)] = envelope;
				}
				return out;
			}),
		});
	}),
);

export const patientPortalServicesPlugin = definePlugin({
	id: "patient-portal.services",
	// Audit resolves via serviceOption per call — the dep edge is an
	// ordering hint only; absence of the audit plugin is legal.
	optionalDeps: [auditServicesPlugin.id],
	services: PatientPortalLive,
});

// Route subtree composed into the host's virtualRouteConfig: the route
// modules live in THIS package (src/routes/**), discovered by a
// physical() directory scan relative to the host's routes directory.
export const patientPortalRoutesPlugin = definePlugin({
	id: "patient-portal.routes",
	routes: [physical("/portal", "../../../../plugins/patient-portal/src/routes")],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [patientPortalServicesPlugin, patientPortalRoutesPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"patient-portal.services": true;
		"patient-portal.routes": true;
	}
}
