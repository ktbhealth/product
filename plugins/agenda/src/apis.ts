import type { AgendaApi, AppointmentDraft } from "./views/index.ts";
import type { AppointmentStatus } from "./schema.ts";
import {
	createAppointmentFn,
	setAppointmentStatusFn,
	startAppointmentFn,
	updateAppointmentFn,
} from "./fns.ts";

/**
 * View-facing API adapter for the agenda pages (P-033): the views speak
 * a small interface; this binds it to the plugin's server fns. Kept in
 * one module so the wiring is testable without a router.
 */
export const agendaApi: AgendaApi = {
	create: (draft: AppointmentDraft) => createAppointmentFn({ data: draft }),
	update: (id, patch) => updateAppointmentFn({ data: { ...patch, id } }),
	setStatus: (id: number, status: AppointmentStatus) =>
		setAppointmentStatusFn({ data: { id, status } }),
	start: (id: number) => startAppointmentFn({ data: { id } }),
};
