import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CalendarClockIcon } from "lucide-react";

import { clinicianPortalPlugin } from "@ktb/clinician";
import { consultationsServicesPlugin } from "@ktb/consultations";
import { physical } from "@tanstack/virtual-file-routes";

import { definePlugin, type ChromeContribution, type Page, type Plugin } from "@ktb/kernel";
import { Principal } from "@ktb/authz";
import { Patients, patientsServicesPlugin, type Patient } from "@ktb/patients";
import { rbacServicesPlugin } from "@ktb/rbac-plugin";
import { vaultSecretsPlugin } from "@ktb/vault";

import { appointments, calendarConnections } from "@ktb/db/schema";
import { AgendaPortalPage, type AgendaListItem } from "./views/index.ts";
import { Appointments, AppointmentsLive } from "./service.ts";
import { CalendarIntegrationsLive } from "./calendar.ts";
import { AGENDA_WINDOW } from "./window.ts";

export {
	APPOINTMENT_STATUSES,
	APPOINTMENT_SYNC_STATES,
	APPOINTMENT_TRANSITIONS,
	appointments,
	calendarConnections,
	CALENDAR_CONNECTION_STATUSES,
	type Appointment,
	type CalendarConnection,
	type CalendarConnectionStatus,
	type AppointmentStatus,
	type AppointmentSyncState,
} from "./schema.ts";
export {
	AppointmentConflict,
	Appointments,
	AppointmentsLive,
	appointmentScope,
	claimReminder,
	findOverlappingAppointment,
	createAppointment,
	DEFAULT_DURATION_MIN,
	getAppointment,
	listAppointments,
	listDueAppointments,
	REMINDER_LEAD_MS,
	updateAppointment,
	type AppointmentInput,
	type AppointmentListItem,
	type AppointmentPatch,
	type AppointmentRow,
} from "./service.ts";
export {
	CalendarIntegrationError,
	CalendarIntegrations,
	CalendarIntegrationsLive,
	type CalendarConnectionCard,
	type CalendarImportConflictItem,
	type CalendarImportResult,
	type CalendarImportReviewItem,
} from "./calendar.ts";

export {
	AppointmentCancelled,
	AppointmentReminderDue,
	AppointmentScheduled,
	AppointmentUpdated,
} from "./api.ts";

const agendaLoader = () =>
	Effect.gen(function* () {
		const principal = yield* Principal;
		if (principal === null) return { appointments: [], patients: [] };
		const appointments = yield* Appointments;
		// Loader poke (P-008): every agenda view runs the same idempotent
		// reminder sweep the cron fires — keeps dev (no crons) live and
		// covers any missed windows in prod. System path, cheap indexed
		// read, failure must never 500 the page.
		yield* appointments.dispatchDueReminders().pipe(Effect.catch(() => Effect.succeed(0)));
		const now = Date.now();
		const [items, patientsSvc] = yield* Effect.all([
			appointments
				.list(principal.userId, {
					from: new Date(now - AGENDA_WINDOW.pastDays * 86_400_000),
					to: new Date(now + AGENDA_WINDOW.aheadDays * 86_400_000),
				})
				.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as AgendaListItem[]))),
			Effect.serviceOption(Patients),
		]);
		const patientRows =
			patientsSvc._tag === "Some"
				? yield* patientsSvc.value
						.list(principal.userId)
						.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as Patient[])))
				: [];
		return {
			appointments: items,
			patients: patientRows.map((p) => ({ id: p.id, name: p.name })),
		};
	});

const CLINICAL_INSTANCES = ["doctor", "secretary"] as const;

/** The agenda pages for one clinical instance — the same descriptor
 * serves /portal/doctor/agenda and /portal/secretary/agenda; loaders
 * run under the doctor-resolved Principal (`subject: "doctor"`), so a
 * delegated secretary reads/writes the doctor's agenda and a patient
 * account never reaches the page (the portal audience gate). */
const agendaPages = (instance: (typeof CLINICAL_INSTANCES)[number]): Page[] => {
	const base = `/portal/${instance}`;
	return [
		{
			id: `agenda.${instance}.home`,
			path: `${base}/agenda`,
			component: AgendaPortalPage,
			loader: agendaLoader,
		},
	];
};

const agendaChrome = (instance: (typeof CLINICAL_INSTANCES)[number]): ChromeContribution[] => [
	{
		id: `agenda.${instance}.nav`,
		region: "portal.sidebar",
		portal: instance,
		content: {
			kind: "sidebarItem",
			item: {
				to: `/portal/${instance}/agenda`,
				label: "Agenda",
				icon: CalendarClockIcon,
				group: "Care",
			},
		},
	},
];

export const agendaTablesPlugin = definePlugin({
	id: "agenda.tables",
	meta: { keywords: ["agenda", "tables"] },
	tables: { appointments, calendarConnections },
});

export const agendaServicesPlugin = definePlugin({
	id: "agenda.services",
	meta: { keywords: ["agenda", "services"] },
	// Patient ownership checks ride the patients.ownerOf query; "start
	// consult" delegates to the Consultations service — both must be
	// composed first. rbac.services orders ahead so the Permissions
	// port the patient-link tuple check consumes is composed (still
	// optional — absent fails the check closed).
	requiredDeps: [patientsServicesPlugin.id, consultationsServicesPlugin.id],
	optionalDeps: [rbacServicesPlugin.id, vaultSecretsPlugin.id],
	services: CalendarIntegrationsLive.pipe(Layer.provideMerge(AppointmentsLive)),
});

/** OAuth/connect API routes for external calendar providers. Modules
 * live in this package and reach the composed runtime through
 * @ktb/server-fns — no host route files. */
export const agendaRoutesPlugin = definePlugin({
	id: "agenda.routes",
	meta: { keywords: ["agenda", "routes", "calendar"] },
	requiredDeps: [agendaServicesPlugin.id],
	routes: [physical("/api", "../../../../plugins/agenda/src/api-routes")],
});

/** Agenda pages under the clinical portals (P-081): mounted as page
 * descriptors the host's splat dispatcher serves — patients never
 * reach them because only doctor/secretary portal instances exist for
 * these paths and the audience gate runs before the page does.
 * clinician.portal is an ordering hint: without the clinical portals
 * the paths simply match nothing. */
export const agendaPagesPlugin = definePlugin({
	id: "agenda.pages",
	meta: { keywords: ["agenda", "ui", "doctor", "secretary"] },
	requiredDeps: [patientsServicesPlugin.id],
	optionalDeps: [clinicianPortalPlugin.id],
	pages: [...agendaPages("doctor"), ...agendaPages("secretary")],
});

export const agendaChromePlugin = definePlugin({
	id: "agenda.chrome",
	meta: { keywords: ["agenda", "ui", "doctor", "secretary"] },
	optionalDeps: [clinicianPortalPlugin.id],
	chrome: [...agendaChrome("doctor"), ...agendaChrome("secretary")],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	agendaTablesPlugin,
	agendaServicesPlugin,
	agendaRoutesPlugin,
	agendaPagesPlugin,
	agendaChromePlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"agenda.tables": true;
		"agenda.services": true;
		"agenda.routes": true;
		"agenda.pages": true;
		"agenda.chrome": true;
	}
}
