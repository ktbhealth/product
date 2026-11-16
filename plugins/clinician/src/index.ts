import { ClipboardListIcon, HouseIcon, UsersIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import { Query } from "@effect-server-utils/cqrs";

import { Principal } from "@ktb/authz";
import { Consultations } from "@ktb/consultations";
import { consultationsServicesPlugin } from "@ktb/consultations";
import { definePlugin, type Plugin } from "@ktb/kernel";
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

const PATIENTS_PREFIX = "/portal/clinician/patients";
const CONSULTATIONS_PREFIX = "/portal/clinician/consultations";

/** Subpath segments under a portal prefix — "patients/5/edit" →
 * ["5", "edit"]; the exact list path never reaches a wildcard. */
const subpath = (path: string, prefix: string) =>
	path
		.slice(prefix.length)
		.replace(/^\/+|\/+$/g, "")
		.split("/");

/**
 * The clinician portal instance (P-081): `/portal/clinician/*` is the
 * doctor/secretary workspace — a dynamic sidebar over the clinical
 * domains, scoped by the `clinician` audience rule (own doctor profile
 * OR delegated secretary access) and running page loaders under the
 * doctor-resolved acting user (`subject: "doctor"`), so owner-scoped
 * services see the same Principal the plugins' own server fns bind.
 * System: false — a deployment without clinical plugins can disable it.
 */
export const clinicianPortalPlugin = definePlugin({
	id: "clinician.portal",
	requiredDeps: [portalShellPlugin.id],
	portals: [
		{
			id: "clinician",
			basePath: "/portal/clinician",
			label: "Clinician",
			audience: "clinician",
			subject: "doctor",
		},
	],
});

/** Portal pages under /portal/clinician/* — domain views mounted as
 * page descriptors; loaders call the owner-scoped services under the
 * bound acting Principal. Forbidden collapses to empty lists exactly
 * like the app routes' fns. */
export const clinicianPagesPlugin = definePlugin({
	id: "clinician.pages",
	requiredDeps: [patientsServicesPlugin.id, consultationsServicesPlugin.id],
	pages: [
		{
			id: "clinician.home",
			path: "/portal/clinician",
			component: ClinicianHomePage,
		},
		{
			id: "clinician.patients",
			path: "/portal/clinician/patients",
			component: ClinicianPatientsPage,
			loader: () =>
				Effect.gen(function* () {
					const principal = yield* Principal;
					if (principal === null) return [];
					const patients = yield* Patients;
					return yield* patients
						.list(principal.userId)
						.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
				}),
		},
		{
			id: "clinician.consultations",
			path: "/portal/clinician/consultations",
			component: ClinicianConsultationsPage,
			loader: () =>
				Effect.gen(function* () {
					const principal = yield* Principal;
					if (principal === null) return [];
					const consultations = yield* Consultations;
					return yield* consultations
						.list(principal.userId)
						.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
				}),
		},
		{
			id: "clinician.patients.record",
			path: `${PATIENTS_PREFIX}/*`,
			component: ClinicianPatientRecordPage,
			guard: (path) =>
				Effect.gen(function* () {
					const [head, tail, ...rest] = subpath(path, PATIENTS_PREFIX);
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
				}),
			loader: (path) =>
				Effect.scoped(
					Effect.gen(function* () {
						const [head, tail, ...rest] = subpath(path, PATIENTS_PREFIX);
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
				),
		},
		{
			id: "clinician.consultations.record",
			path: `${CONSULTATIONS_PREFIX}/*`,
			component: ClinicianConsultationRecordPage,
			guard: (path) =>
				Effect.gen(function* () {
					const [head, tail] = subpath(path, CONSULTATIONS_PREFIX);
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
				}),
			loader: (path) =>
				Effect.gen(function* () {
					const [head, tail] = subpath(path, CONSULTATIONS_PREFIX);
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
				}),
		},
	],
});

/** Sidebar entries scoped to the clinician instance — the portal.*
 * chrome region renders them only inside /portal/clinician. */
export const clinicianChromePlugin = definePlugin({
	id: "clinician.chrome",
	requiredDeps: [clinicianPortalPlugin.id],
	chrome: [
		{
			id: "clinician.nav.home",
			region: "portal.sidebar",
			portal: "clinician",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/portal/clinician",
					label: "Home",
					icon: HouseIcon,
					exact: true,
				},
			},
		},
		{
			id: "clinician.nav.patients",
			region: "portal.sidebar",
			portal: "clinician",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/portal/clinician/patients",
					label: "Patients",
					icon: UsersIcon,
					group: "Care",
				},
			},
		},
		{
			id: "clinician.nav.consultations",
			region: "portal.sidebar",
			portal: "clinician",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/portal/clinician/consultations",
					label: "Consultations",
					icon: ClipboardListIcon,
					group: "Care",
				},
			},
		},
	],
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
