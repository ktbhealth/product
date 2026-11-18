import * as Effect from "effect/Effect";
import { CalendarClockIcon } from "lucide-react";

import { clinicianPortalPlugin } from "@ktb/clinician";
import { consultationsServicesPlugin } from "@ktb/consultations";
import { definePlugin, type ChromeContribution, type Page, type Plugin } from "@ktb/kernel";
import { Principal } from "@ktb/authz";
import { Patients, patientsServicesPlugin, type Patient } from "@ktb/patients";

import { appointments } from "@ktb/db/schema";
import { AgendaPortalPage, type AgendaListItem } from "./views/index.ts";
import { Appointments, AppointmentsLive } from "./service.ts";

export {
	APPOINTMENT_STATUSES,
	APPOINTMENT_SYNC_STATES,
	APPOINTMENT_TRANSITIONS,
	appointments,
	type Appointment,
	type AppointmentStatus,
	type AppointmentSyncState,
} from "./schema.ts";
export {
	Appointments,
	AppointmentsLive,
	appointmentScope,
	claimReminder,
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
	AppointmentCancelled,
	AppointmentReminderDue,
	AppointmentScheduled,
	AppointmentUpdated,
} from "./api.ts";

/** Standalone DDL for tests (and cross-plugin test fixtures) — mirrors
 * the drizzle-generated migration; keep in sync with ./schema.ts. The
 * FK targets (patients/groups/consultations/user) come from the
 * caller's fixture. */
export const AGENDA_TEST_DDL = `
CREATE TABLE appointments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	owner_id TEXT NOT NULL,
	patient_id INTEGER NOT NULL REFERENCES patients(id),
	tenant_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
	status TEXT NOT NULL DEFAULT 'scheduled',
	starts_at INTEGER NOT NULL,
	duration_min INTEGER NOT NULL DEFAULT 30,
	consultation_id INTEGER REFERENCES consultations(id),
	note TEXT,
	reminder_sent_at INTEGER,
	external_provider TEXT,
	external_calendar_id TEXT,
	external_event_id TEXT,
	external_etag TEXT,
	sync_state TEXT NOT NULL DEFAULT 'local',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX appointments_owner_start_idx ON appointments (owner_id, starts_at);
CREATE INDEX appointments_reminder_idx ON appointments (reminder_sent_at, starts_at);
CREATE INDEX appointments_tenant_id_idx ON appointments (tenant_id);
CREATE INDEX appointments_patient_idx ON appointments (patient_id);
CREATE UNIQUE INDEX appointments_external_idx ON appointments (external_provider, external_calendar_id, external_event_id);
`;

/** Window the agenda loaders read — the current week plus margin so
 * the view can page one week either way without a refetch. */
const AGENDA_WINDOW = { pastDays: 14, aheadDays: 21 } as const;

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
	tables: { appointments },
});

export const agendaServicesPlugin = definePlugin({
	id: "agenda.services",
	meta: { keywords: ["agenda", "services"] },
	// Patient ownership checks ride the patients.ownerOf query; "start
	// consult" delegates to the Consultations service — both must be
	// composed first.
	requiredDeps: [patientsServicesPlugin.id, consultationsServicesPlugin.id],
	services: AppointmentsLive,
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
	agendaPagesPlugin,
	agendaChromePlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"agenda.tables": true;
		"agenda.services": true;
		"agenda.pages": true;
		"agenda.chrome": true;
	}
}
