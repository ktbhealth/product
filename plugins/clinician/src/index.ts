import { ActivityIcon, ClipboardListIcon, HouseIcon, UsersIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Query } from "@effect-server-utils/cqrs";

import { Audit, auditServicesPlugin, type AuditListResult } from "@ktb/audit";
import { AuditActivityPage } from "@ktb/audit/activity-page";
import { Principal } from "@ktb/authz";
import { Consultations } from "@ktb/consultations";
import { consultationsServicesPlugin } from "@ktb/consultations";
import { definePlugin, type ChromeContribution, type Page, type Plugin } from "@ktb/kernel";
import { Patients } from "@ktb/patients";
import { PatientRecordConsultationsQueries } from "@ktb/patients/api";
import { patientsServicesPlugin } from "@ktb/patients";
import { portalShellPlugin } from "@ktb/portal";

import {
	ClinicianConsultationRecordPage,
	ClinicianConsultationsPage,
	ClinicianHomePage,
	ClinicianPatientRecordPage,
	ClinicianPatientsPage,
} from "./views/index.ts";

/**
 * The clinical portals this plugin ships (P-081): the same workspace —
 * home, patients, consultations — mounted once per role. `/portal/doctor`
 * admits own-profile doctors, `/portal/secretary` delegated secretaries;
 * both run page loaders under the doctor-resolved acting user
 * (`subject: "doctor"`), so owner-scoped services see the same Principal
 * the plugins' own server fns bind. Pages, sidebar items and in-view
 * links are shared through per-instance factories so nav and loaders
 * stay identical across the two.
 */
const CLINICAL_INSTANCES = [
	{ id: "doctor", label: "Doctor", audience: "doctor" },
	{ id: "secretary", label: "Secretary", audience: "secretary" },
] as const;

type ClinicalInstanceId = (typeof CLINICAL_INSTANCES)[number]["id"];

const instanceBase = (id: ClinicalInstanceId) => `/portal/${id}`;

/** Subpath segments under a portal prefix — "patients/5/edit" →
 * ["5", "edit"]; the exact list path never reaches a wildcard. */
const subpath = (path: string, prefix: string) =>
	path
		.slice(prefix.length)
		.replace(/^\/+|\/+$/g, "")
		.split("/");

const patientsLoader = () =>
	Effect.gen(function* () {
		const principal = yield* Principal;
		if (principal === null) return [];
		const patients = yield* Patients;
		return yield* patients
			.list(principal.userId)
			.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
	});

const consultationsLoader = () =>
	Effect.gen(function* () {
		const principal = yield* Principal;
		if (principal === null) return [];
		const consultations = yield* Consultations;
		return yield* consultations
			.list(principal.userId)
			.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
	});

const patientRecordGuard = (prefix: string) => (path: string) =>
	Effect.gen(function* () {
		const [head, tail, ...rest] = subpath(path, prefix);
		if (head === "new" && tail === undefined) return true;
		const id = Number(head);
		const shaped = rest.length === 0 && (tail === undefined || tail === "edit");
		if (!shaped || !Number.isInteger(id) || id <= 0) return false;
		const principal = yield* Principal;
		if (principal === null) return false;
		const patients = yield* Patients;
		const patient = yield* patients
			.get(principal.userId, id)
			.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
		return patient !== null;
	});

const patientRecordLoader = (prefix: string) => (path: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const [head, tail, ...rest] = subpath(path, prefix);
			if (head === "new" && tail === undefined) return { view: "new" };
			const id = Number(head);
			const principal = yield* Principal;
			if (
				principal === null ||
				rest.length > 0 ||
				!Number.isInteger(id) ||
				id <= 0 ||
				(tail !== undefined && tail !== "edit")
			) {
				return { view: "missing" };
			}
			const patients = yield* Patients;
			const patient = yield* patients
				.get(principal.userId, id)
				.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
			if (patient === null) return { view: "missing" };
			if (tail === "edit") return { view: "edit", patient };
			const queries = yield* Query.dispatcher(PatientRecordConsultationsQueries);
			const recordConsultations = yield* queries["patients.recordConsultations"]({
				patientId: id,
			});
			return { view: "detail", patient, consultations: recordConsultations };
		}),
	);

const consultationRecordGuard = (prefix: string) => (path: string) =>
	Effect.gen(function* () {
		const [head, tail] = subpath(path, prefix);
		if (head === "new" && tail === undefined) return true;
		const id = Number(head);
		if (tail !== undefined || !Number.isInteger(id) || id <= 0) return false;
		const principal = yield* Principal;
		if (principal === null) return false;
		const consultations = yield* Consultations;
		const c = yield* consultations
			.get(id, principal.userId)
			.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
		return c !== null;
	});

const consultationRecordLoader = (prefix: string) => (path: string) =>
	Effect.gen(function* () {
		const [head, tail] = subpath(path, prefix);
		const principal = yield* Principal;
		if (principal === null) return { view: "missing" };
		if (head === "new" && tail === undefined) {
			const patients = yield* Patients;
			const list = yield* patients
				.list(principal.userId)
				.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
			return { view: "new", patients: list };
		}
		const id = Number(head);
		if (tail !== undefined || !Number.isInteger(id) || id <= 0) {
			return { view: "missing" };
		}
		const consultations = yield* Consultations;
		const c = yield* consultations
			.get(id, principal.userId)
			.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
		if (c === null) return { view: "missing" };
		const history = c.patientId
			? yield* consultations.history(c.patientId, principal.userId, c.id)
			: null;
		return { view: "detail", c, history };
	});

/** The clinical page set for one instance — identical descriptors under
 * its base path; per-request `path` resolves wildcard data, so the same
 * loaders serve both portals. */
const clinicalPages = (instance: ClinicalInstanceId): Page[] => {
	const base = instanceBase(instance);
	const patientsBase = `${base}/patients`;
	const consultationsBase = `${base}/consultations`;
	return [
		{
			id: `clinician.${instance}.home`,
			path: base,
			component: ClinicianHomePage,
		},
		{
			id: `clinician.${instance}.patients`,
			path: patientsBase,
			component: ClinicianPatientsPage,
			loader: patientsLoader,
		},
		{
			id: `clinician.${instance}.consultations`,
			path: consultationsBase,
			component: ClinicianConsultationsPage,
			loader: consultationsLoader,
		},
		{
			id: `clinician.${instance}.patients.record`,
			path: `${patientsBase}/*`,
			component: ClinicianPatientRecordPage,
			guard: patientRecordGuard(patientsBase),
			loader: patientRecordLoader(patientsBase),
		},
		{
			id: `clinician.${instance}.consultations.record`,
			path: `${consultationsBase}/*`,
			component: ClinicianConsultationRecordPage,
			guard: consultationRecordGuard(consultationsBase),
			loader: consultationRecordLoader(consultationsBase),
		},
		// Staff activity feed (P-085): mounted once per clinical
		// instance so each portal owns its copy — moved here from the
		// audit plugin. The guard asks the Audit service whether the
		// bound tenant holds `audit.read` — absent service or grant
		// both deny; the loader degrades a denial to an empty page,
		// same contract as the other pages.
		{
			id: `clinician.${instance}.activity`,
			path: `${base}/activity`,
			component: AuditActivityPage,
			guard: () =>
				Effect.gen(function* () {
					const audit = yield* Effect.serviceOption(Audit);
					if (Option.isNone(audit)) return false;
					return yield* audit.value.activityAccess();
				}),
			loader: () =>
				Effect.gen(function* () {
					const audit = yield* Effect.serviceOption(Audit);
					const empty: AuditListResult = { entries: [], total: 0, limit: 200, offset: 0 };
					if (Option.isNone(audit)) return empty;
					return yield* audit.value
						.activityList()
						.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(empty)));
				}),
		},
	];
};

/** Sidebar entries scoped to one clinical instance — the portal.*
 * chrome region renders them only inside its base path. */
const sidebarChrome = (instance: ClinicalInstanceId): ChromeContribution[] => {
	const base = instanceBase(instance);
	return [
		{
			id: `clinician.${instance}.nav.home`,
			region: "portal.sidebar",
			portal: instance,
			content: {
				kind: "sidebarItem",
				item: { to: base, label: "Home", icon: HouseIcon, exact: true },
			},
		},
		{
			id: `clinician.${instance}.nav.patients`,
			region: "portal.sidebar",
			portal: instance,
			content: {
				kind: "sidebarItem",
				item: {
					to: `${base}/patients`,
					label: "Patients",
					icon: UsersIcon,
					group: "Care",
				},
			},
		},
		{
			id: `clinician.${instance}.nav.consultations`,
			region: "portal.sidebar",
			portal: instance,
			content: {
				kind: "sidebarItem",
				item: {
					to: `${base}/consultations`,
					label: "Consultations",
					icon: ClipboardListIcon,
					group: "Care",
				},
			},
		},
		{
			id: `clinician.${instance}.activity.sidebar`,
			region: "portal.sidebar",
			portal: instance,
			content: {
				kind: "sidebarItem",
				item: {
					to: `${base}/activity`,
					label: "Activity",
					icon: ActivityIcon,
					group: "Governance",
				},
			},
		},
	];
};

export const clinicianPortalPlugin = definePlugin({
	id: "clinician.portal",
	meta: { keywords: ["clinician", "shell", "doctor"] },
	requiredDeps: [portalShellPlugin.id],
	portals: CLINICAL_INSTANCES.map((instance) => ({
		id: instance.id,
		basePath: instanceBase(instance.id),
		label: instance.label,
		audience: instance.audience,
		subject: "doctor" as const,
	})),
});

/** Portal pages under /portal/doctor/* and /portal/secretary/* — domain
 * views mounted as page descriptors; loaders call the owner-scoped
 * services under the bound acting Principal. Forbidden collapses to
 * empty lists exactly like the app routes' fns. */
export const clinicianPagesPlugin = definePlugin({
	id: "clinician.pages",
	meta: { keywords: ["clinician", "ui", "doctor"] },
	requiredDeps: [patientsServicesPlugin.id, consultationsServicesPlugin.id],
	// The activity feed resolves the Audit service via serviceOption —
	// the dep edge orders it after audit.services when that plugin is
	// present, but a deployment without it still works (guard denies).
	optionalDeps: [auditServicesPlugin.id],
	pages: [...clinicalPages("doctor"), ...clinicalPages("secretary")],
});

export const clinicianChromePlugin = definePlugin({
	id: "clinician.chrome",
	meta: { keywords: ["clinician", "ui", "doctor"] },
	requiredDeps: [clinicianPortalPlugin.id],
	chrome: [...sidebarChrome("doctor"), ...sidebarChrome("secretary")],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	clinicianPortalPlugin,
	clinicianPagesPlugin,
	clinicianChromePlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"clinician.portal": true;
		"clinician.pages": true;
		"clinician.chrome": true;
	}
}
