import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HeartPulseIcon, HouseIcon } from "lucide-react";
import { physical } from "@tanstack/virtual-file-routes";

import { Forbidden, Principal } from "@ktb/authz";
import { Audit, audit, auditServicesPlugin, type AuditListResult } from "@ktb/audit";
import { Consultations, consultationsServicesPlugin } from "@ktb/consultations";
import { Db } from "@ktb/db";
import { Doctors, doctorsServicesPlugin } from "@ktb/doctors";
import { patientAccessServicesPlugin, PortalAccess } from "@ktb/patient-access";
import { Patients, patientsServicesPlugin } from "@ktb/patients";
import { isEnvelope } from "@ktb/patients/zk";
import { enrollPortalDevice, entityDekEnvelope, portalDeviceOf, type PortalKey } from "@ktb/vault";
import { definePlugin, type Page, type Plugin } from "@ktb/kernel";
import { routeContribution } from "@ktb/platform/routes";
import { portalShellPlugin } from "@ktb/portal";
import { getPatientContext } from "@ktb/server-fns";

import {
	PatientPortalActivityPage,
	PatientPortalConsultationPage,
	PatientPortalHomePage,
} from "./views/index.ts";

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

/**
 * Patient portal port — the *patient* side: read-only on clinical data,
 * and everything is scoped to the signed-in user themself. Fails
 * `Forbidden` without a principal and under delegation (a secretary
 * acting for a doctor has no business in someone's portal).
 *
 * T-141: this service no longer reads other plugins' tables — every
 * row comes through the owning plugin's service: `PortalAccess`
 * (patient-access) resolves the active `patient_access` link every
 * read gates on, `Consultations`/`Patients`/`Doctors` own the record,
 * owner and display-name reads, and `@ktb/vault`'s portal helpers own
 * the device/DEK envelope lookups (portal users hold no tenant, so the
 * tenant-bound `Vault` service cannot serve them — the repo helpers
 * are the owner's portal surface by design).
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
		const access = yield* PortalAccess;
		const consultations = yield* Consultations;
		const doctors = yield* Doctors;
		const patients = yield* Patients;
		const self = (path: string) =>
			Effect.flatMap(Principal, (principal) =>
				principal === null || principal.actorId !== undefined
					? Effect.fail(new Forbidden({ path }))
					: Effect.succeed(principal.userId),
			);
		return PatientPortal.of({
			profile: Effect.fn("PatientPortal.profile")(function* (patientId: number) {
				yield* self("portal.read");
				const link = yield* access.link(patientId);
				if (link === null) return yield* Effect.fail(new Forbidden({ path: "portal.read" }));
				const owner = yield* patients.ownerOf(patientId);
				const doctorName = owner === null ? null : yield* doctors.displayName(owner.ownerId);
				return {
					patientId: link.patientId,
					relation: link.relation,
					name: link.name,
					doctorName,
				};
			}),
			consultations: Effect.fn("PatientPortal.consultations")(function* (patientId: number) {
				yield* self("portal.read");
				const rows = yield* consultations.portalList(patientId);
				return rows.flatMap(({ anamnesis, ...row }): PortalConsultationSummary[] => {
					// T-148: a ZK row is opaque — list it with the raw envelope so the
					// client can decrypt; the complaint derives after decrypting.
					if (isEnvelope(anamnesis)) return [{ ...row, chiefComplaint: null, anamnesis }];
					const parsed = parseAnamnesis(anamnesis);
					if (parsed === null) return [];
					return [
						{ ...row, chiefComplaint: written(parsed.queixa_principal.content), anamnesis: null },
					];
				});
			}),
			consultation: Effect.fn("PatientPortal.consultation")(function* (id: number) {
				yield* self("portal.read");
				const row = yield* consultations.portalGet(id);
				if (row === null) return yield* Effect.fail(new Forbidden({ path: "portal.read" }));
				// The link was just authorized inside portalGet — re-read it
				// for the record name (and to fail on a revocation landing
				// between the two reads).
				const link = yield* access.link(row.patientId);
				if (link === null) return yield* Effect.fail(new Forbidden({ path: "portal.read" }));
				const doctorName = row.userId === null ? null : yield* doctors.displayName(row.userId);
				const base = {
					id: row.id,
					createdAt: row.createdAt,
					patientId: row.patientId,
					patientName: link.name,
					doctorName,
				};
				let consultation: PortalConsultation;
				// T-148: a ZK row ships its envelope untouched — the portal
				// unwraps the record DEK for the caller's device and
				// decrypts client-side.
				if (isEnvelope(row.anamnesis)) {
					consultation = { ...base, sections: [], anamnesis: row.anamnesis };
				} else {
					const parsed = parseAnamnesis(row.anamnesis);
					if (parsed === null) {
						return yield* Effect.fail(new Forbidden({ path: "portal.read" }));
					}
					consultation = { ...base, sections: portalSections(parsed), anamnesis: null };
				}
				// Sensitive-read audit (P-086 feed): same `consultations.read`
				// action the clinician detail read emits, `via: "portal"`
				// marks the patient-facing path; tenant_id is row-authoritative.
				// ids only — the record content never leaves the audit log.
				yield* audit({
					action: "consultations.read",
					targetType: "consultation",
					targetId: row.id,
					tenantId: row.tenantId,
					detail: { patientId: row.patientId, via: "portal" },
				});
				return consultation;
			}),
			awaitingInvites: Effect.fn("PatientPortal.awaitingInvites")(function* () {
				yield* self("portal.read");
				return yield* access.awaitingInvites();
			}),
			registerDevice: Effect.fn("PatientPortal.registerDevice")(function* (input) {
				const userId = yield* self("portal.device");
				return yield* Effect.promise(() => enrollPortalDevice(db, { userId, ...input }));
			}),
			dekEnvelopes: Effect.fn("PatientPortal.dekEnvelopes")(function* (input) {
				const userId = yield* self("portal.read");
				// The wrap pubkey must be registered to the caller — one
				// check up front, before any record resolution.
				const device = yield* Effect.promise(() => portalDeviceOf(db, userId, input.wrapPublicKey));
				if (device === null) return {};
				const out: Record<string, string> = {};
				for (const rawId of input.entityIds) {
					const entityId = Number(rawId);
					if (!Number.isInteger(entityId)) continue;
					let tenantId: number | null;
					if (input.entityType === "consultation") {
						// portalScope carries the active-link check — a
						// consultation the caller cannot see resolves to
						// nothing, indistinguishable from "no grant".
						const scope = yield* consultations.portalScope(entityId);
						if (scope === null) continue;
						tenantId = scope.tenantId;
					} else {
						const owner = yield* patients.ownerOf(entityId);
						if (owner === null || (yield* access.link(entityId)) === null) continue;
						tenantId = owner.tenantId;
					}
					// entity_deks rows are tenant-owned — a personal
					// (tenantless) record can never carry a grant.
					if (tenantId === null) continue;
					const dek = yield* Effect.promise(() =>
						entityDekEnvelope(db, tenantId, input.entityType, entityId, input.wrapPublicKey),
					);
					if (dek !== null) out[String(rawId)] = dek.wrappedDek;
				}
				return out;
			}),
		});
	}),
);

export const patientPortalServicesPlugin = definePlugin({
	id: "patient-portal.services",
	meta: { keywords: ["patient-portal", "services", "patient"] },
	// Every read composes another plugin's service: patient-access owns
	// the active-link grant, consultations/patients/doctors own the
	// record, owner and display-name reads behind it. Audit resolves via
	// serviceOption per call — the dep edge is an ordering hint only;
	// absence of the audit plugin is legal.
	requiredDeps: [
		patientAccessServicesPlugin.id,
		consultationsServicesPlugin.id,
		doctorsServicesPlugin.id,
		patientsServicesPlugin.id,
	],
	optionalDeps: [auditServicesPlugin.id],
	services: PatientPortalLive,
});

/** Subpath segments under a portal prefix — "consultations/5" →
 * ["5"]; the exact list path never reaches a wildcard. */
const subpath = (path: string, prefix: string) =>
	path
		.slice(prefix.length)
		.replace(/^\/+|\/+$/g, "")
		.split("/");

/**
 * Everything the portal home shows. An entry point: `syncLinks` claims
 * pending invites first, so a new link shows up as soon as the patient
 * opens the portal. The context resolves the signed-in account and its
 * linked records (the ktb_patient selector cookie picks the open one);
 * the service reads run under the session Principal the page gate
 * bound — `subject: "session"`, so delegated doctor access never leaks
 * into someone's portal.
 */
const homeLoader = () =>
	Effect.gen(function* () {
		const context = yield* Effect.promise(() => getPatientContext(undefined, { syncLinks: true }));
		if (context === null) return { view: "missing" };
		const { user, profiles, active } = context;
		const portal = yield* PatientPortal;
		const empty = { profiles: [] as typeof profiles, profile: null, consultations: [] };
		return yield* Effect.gen(function* () {
			return {
				view: "home" as const,
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
					view: "home" as const,
					user: { name: user.name, email: user.email },
					awaitingInvites: 0,
					...empty,
				}),
			),
		);
	});

const CONSULTATIONS_PREFIX = "/portal/patient/consultations";

const consultationId = (path: string): number | null => {
	const [head, tail, ...rest] = subpath(path, CONSULTATIONS_PREFIX);
	const id = Number(head);
	return rest.length === 0 && tail === undefined && Number.isInteger(id) && id > 0 ? id : null;
};

const consultationGuard = (path: string) =>
	Effect.gen(function* () {
		const id = consultationId(path);
		if (id === null) return false;
		const portal = yield* PatientPortal;
		const consultation = yield* portal
			.consultation(id)
			.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
		return consultation !== null;
	});

const consultationLoader = (path: string) =>
	Effect.gen(function* () {
		const id = consultationId(path);
		if (id === null) return { view: "missing" };
		const portal = yield* PatientPortal;
		const consultation = yield* portal
			.consultation(id)
			.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
		return consultation === null ? { view: "missing" } : { view: "detail", consultation };
	});

/** Page size the portal activity feed asks for (P-086). */
const PATIENT_ACTIVITY_LIMIT = 100;

const ACTIVITY_EMPTY: AuditListResult = {
	entries: [],
	total: 0,
	limit: PATIENT_ACTIVITY_LIMIT,
	offset: 0,
};

/**
 * The patient-facing access log (P-086) for the record currently open
 * in the portal: audit entries naming its `patientId`, across every
 * clinic that keeps it. Same fail-closed contract as
 * `patientActivityFn` — no open record, an absent audit plugin and a
 * denied `PatientAuditAccess` check all collapse to an empty page, so
 * the route never learns which case it was. Runs under the session
 * Principal the portal page gate bound.
 */
const activityLoader = () =>
	Effect.gen(function* () {
		const context = yield* Effect.promise(() => getPatientContext());
		const patientId = context?.active?.patientId ?? null;
		if (patientId === null) return ACTIVITY_EMPTY;
		const auditService = yield* Effect.serviceOption(Audit);
		if (Option.isNone(auditService)) return ACTIVITY_EMPTY;
		return yield* auditService.value
			.patientList({ patientId, limit: PATIENT_ACTIVITY_LIMIT })
			.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(ACTIVITY_EMPTY)));
	});

/**
 * The patient portal instance (P-081): `/portal/patient` admits the
 * `patient` audience — accounts holding an active patient link, and
 * patient-only accounts with no doctor profile. Pages run under the
 * session subject (the default): the portal shows what the person
 * signed in may see, and `PatientPortal` itself still fails
 * `Forbidden` for anonymous or delegated principals.
 */
export const patientPortalInstancePlugin = definePlugin({
	id: "patient-portal.portal",
	meta: { keywords: ["patient-portal", "shell", "patient"] },
	requiredDeps: [portalShellPlugin.id],
	portals: [
		{
			id: "patient",
			basePath: "/portal/patient",
			label: "Patient",
			audience: "patient",
		},
	],
});

/** Portal pages under /portal/patient/* — the read-only record views
 * mounted as page descriptors; loaders call `PatientPortal` under the
 * bound session Principal. A consultation the caller holds no active
 * link to is a plain 404, like one that does not exist. */
export const patientPortalPagesPlugin = definePlugin({
	id: "patient-portal.pages",
	meta: { keywords: ["patient-portal", "ui", "patient"] },
	requiredDeps: [patientPortalServicesPlugin.id],
	pages: [
		{
			id: "patient-portal.home",
			path: "/portal/patient",
			component: PatientPortalHomePage,
			loader: homeLoader,
		},
		{
			id: "patient-portal.consultation",
			path: `${CONSULTATIONS_PREFIX}/*`,
			component: PatientPortalConsultationPage,
			guard: consultationGuard,
			loader: consultationLoader,
		},
		{
			id: "patient-portal.activity",
			path: "/portal/patient/activity",
			component: PatientPortalActivityPage,
			loader: activityLoader,
		},
	] satisfies Page[],
});

export const patientPortalChromePlugin = definePlugin({
	id: "patient-portal.chrome",
	meta: { keywords: ["patient-portal", "ui", "patient"] },
	requiredDeps: [patientPortalInstancePlugin.id],
	chrome: [
		{
			id: "patient-portal.nav.home",
			region: "portal.sidebar",
			portal: "patient",
			content: {
				kind: "sidebarItem",
				item: { to: "/portal/patient", label: "Home", icon: HouseIcon, exact: true },
			},
		},
		// /login picker tile (P-099): the patient sign-in flow's gate is
		// the "patient" PortalInstance's entryEnabled check — package-
		// granular on pkg "patient-portal". No `requires` needed: this
		// contribution only renders while patient-portal.chrome is
		// enabled, which already makes packageLive("patient-portal")
		// true — the same package the instance belongs to.
		{
			id: "patient-portal.login.tile",
			region: "app.login.tiles",
			order: 0,
			content: {
				kind: "loginTile",
				to: "/login/patient",
				labelKey: "nav_patient_login",
				fallback: "Patient sign in",
				icon: HeartPulseIcon,
			},
		},
	],
});

// Route subtree composed into the host's virtualRouteConfig: the route
// modules live in THIS package (src/routes/**), discovered by a
// physical() directory scan relative to the host's routes directory.
// Today they are only the pre-instance paths kept as redirects —
// /portal → /portal/patient, /portal/consultations/$id → the instance
// twin — so existing links and emails keep landing in the right place.
export const patientPortalRoutesPlugin = definePlugin({
	id: "patient-portal.routes",
	meta: { keywords: ["patient-portal", "routes", "patient"] },
	routes: [physical("/portal", "../../../../plugins/patient-portal/src/routes")],
	// Route-registry defs (PL-011) for the pre-instance file routes
	// above (kept as redirects) — the instance pages under
	// /portal/patient* self-register from their descriptors.
	contributions: [
		routeContribution("patient-portal.index", { path: "/portal" }),
		routeContribution("patient-portal.activity", { path: "/portal/activity" }),
		routeContribution("patient-portal.consultation", {
			path: "/portal/consultations/:id",
			params: ["id"],
		}),
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	patientPortalServicesPlugin,
	patientPortalInstancePlugin,
	patientPortalPagesPlugin,
	patientPortalChromePlugin,
	patientPortalRoutesPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"patient-portal.services": true;
		"patient-portal.portal": true;
		"patient-portal.pages": true;
		"patient-portal.chrome": true;
		"patient-portal.routes": true;
	}
}

// Route-registry keys (PL-011): the path literal must match the
// `routeContribution` meta above — `Routes.route()` types params off it.
declare module "@ktb/platform/routes" {
	interface RouteRegistry {
		"patient-portal.index": "/portal";
		"patient-portal.activity": "/portal/activity";
		"patient-portal.consultation": "/portal/consultations/:id";
	}
}
