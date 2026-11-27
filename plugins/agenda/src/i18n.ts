/**
 * Agenda plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale (`ctx.locale` on pages, `getLocale()` in fns) and copy
 * resolves here. A locale catalog must implement `AgendaMessages` in
 * full — a missing key is a type error, not an English fallback at
 * runtime.
 */

import { paramMessage } from "@ktb/i18n";

export const AGENDA_LOCALES = ["en", "pt-BR", "es"] as const;
export type AgendaLocale = (typeof AGENDA_LOCALES)[number];
export const BASE_LOCALE: AgendaLocale = "en";

export interface AgendaMessages {
	readonly title: string;
	readonly sidebarLabel: string;
	readonly newAppointment: string;
	readonly empty: string;
	readonly today: string;
	readonly previousWeek: string;
	readonly nextWeek: string;
	readonly form: {
		readonly patient: string;
		readonly date: string;
		readonly time: string;
		readonly durationMin: string;
		readonly note: string;
		readonly notePlaceholder: string;
		readonly save: string;
		readonly cancel: string;
		readonly required: string;
		/** Slot overlaps another live appointment of the same doctor. */
		readonly conflict: string;
	};
	readonly status: {
		readonly scheduled: string;
		readonly confirmed: string;
		readonly completed: string;
		readonly noShow: string;
		readonly cancelled: string;
	};
	readonly actions: {
		readonly confirm: string;
		readonly start: string;
		readonly started: string;
		readonly complete: string;
		readonly noShow: string;
		readonly edit: string;
		readonly cancel: string;
	};
	readonly zk: {
		/** Patient name shown when the row's `v1.` envelope cannot be
		 * read on this device (ZK tenant, no grant). */
		readonly lockedName: string;
	};
	/** Calendar views (T-259). */
	readonly views: {
		readonly list: string;
		readonly week: string;
		readonly month: string;
	};
	readonly previousMonth: string;
	readonly nextMonth: string;
	/** Month cell overflow — "+2 more". */
	readonly moreCount: (count: number) => string;
	/** Empty week-grid slot — "New appointment at 09:30". */
	readonly newAt: (time: string) => string;
	readonly detailsTitle: string;
	readonly startingSoon: (minutes: number) => string;
	readonly durationMin: (minutes: number) => string;
}

const en: AgendaMessages = {
	title: "Agenda",
	sidebarLabel: "Agenda",
	newAppointment: "New appointment",
	empty: "No appointments in this period.",
	today: "Today",
	previousWeek: "Previous week",
	nextWeek: "Next week",
	form: {
		patient: "Patient",
		date: "Date",
		time: "Time",
		durationMin: "Duration (min)",
		note: "Note",
		notePlaceholder: "Logistics only — e.g. bring exams",
		save: "Save",
		cancel: "Cancel",
		required: "Required",
		conflict: "This time overlaps another appointment.",
	},
	status: {
		scheduled: "Scheduled",
		confirmed: "Confirmed",
		completed: "Completed",
		noShow: "No-show",
		cancelled: "Cancelled",
	},
	actions: {
		confirm: "Confirm",
		start: "Start consult",
		started: "Open consult",
		complete: "Complete",
		noShow: "No-show",
		edit: "Edit",
		cancel: "Cancel",
	},
	zk: {
		lockedName: "Locked record",
	},
	views: { list: "List", week: "Week", month: "Month" },
	previousMonth: "Previous month",
	nextMonth: "Next month",
	moreCount: paramMessage("en", "+{count} more", ["count"]),
	newAt: paramMessage("en", "New appointment at {time}", ["time"]),
	detailsTitle: "Appointment",
	startingSoon: paramMessage("en", "Starts in {minutes} min", ["minutes"]),
	durationMin: paramMessage("en", "{minutes} min", ["minutes"]),
};

const ptBR: AgendaMessages = {
	title: "Agenda",
	sidebarLabel: "Agenda",
	newAppointment: "Novo agendamento",
	empty: "Nenhum agendamento neste período.",
	today: "Hoje",
	previousWeek: "Semana anterior",
	nextWeek: "Próxima semana",
	form: {
		patient: "Paciente",
		date: "Data",
		time: "Hora",
		durationMin: "Duração (min)",
		note: "Observação",
		notePlaceholder: "Somente logística — ex.: trazer exames",
		save: "Salvar",
		cancel: "Cancelar",
		required: "Obrigatório",
		conflict: "Este horário conflita com outro agendamento.",
	},
	status: {
		scheduled: "Agendado",
		confirmed: "Confirmado",
		completed: "Concluído",
		noShow: "Não compareceu",
		cancelled: "Cancelado",
	},
	actions: {
		confirm: "Confirmar",
		start: "Iniciar consulta",
		started: "Abrir consulta",
		complete: "Concluir",
		noShow: "Não compareceu",
		edit: "Editar",
		cancel: "Cancelar",
	},
	zk: {
		lockedName: "Registro bloqueado",
	},
	views: { list: "Lista", week: "Semana", month: "Mês" },
	previousMonth: "Mês anterior",
	nextMonth: "Próximo mês",
	moreCount: paramMessage("pt-BR", "+{count} mais", ["count"]),
	newAt: paramMessage("pt-BR", "Novo agendamento às {time}", ["time"]),
	detailsTitle: "Agendamento",
	startingSoon: paramMessage("pt-BR", "Começa em {minutes} min", ["minutes"]),
	durationMin: paramMessage("pt-BR", "{minutes} min", ["minutes"]),
};

const es: AgendaMessages = {
	title: "Agenda",
	sidebarLabel: "Agenda",
	newAppointment: "Nueva cita",
	empty: "No hay citas en este período.",
	today: "Hoy",
	previousWeek: "Semana anterior",
	nextWeek: "Semana siguiente",
	form: {
		patient: "Paciente",
		date: "Fecha",
		time: "Hora",
		durationMin: "Duración (min)",
		note: "Nota",
		notePlaceholder: "Solo logística — ej.: traer exámenes",
		save: "Guardar",
		cancel: "Cancelar",
		required: "Obligatorio",
		conflict: "Este horario se superpone con otra cita.",
	},
	status: {
		scheduled: "Agendada",
		confirmed: "Confirmada",
		completed: "Completada",
		noShow: "No asistió",
		cancelled: "Cancelada",
	},
	actions: {
		confirm: "Confirmar",
		start: "Iniciar consulta",
		started: "Abrir consulta",
		complete: "Completar",
		noShow: "No asistió",
		edit: "Editar",
		cancel: "Cancelar",
	},
	zk: {
		lockedName: "Registro bloqueado",
	},
	views: { list: "Lista", week: "Semana", month: "Mes" },
	previousMonth: "Mes anterior",
	nextMonth: "Mes siguiente",
	moreCount: paramMessage("es", "+{count} más", ["count"]),
	newAt: paramMessage("es", "Nueva cita a las {time}", ["time"]),
	detailsTitle: "Cita",
	startingSoon: paramMessage("es", "Empieza en {minutes} min", ["minutes"]),
	durationMin: paramMessage("es", "{minutes} min", ["minutes"]),
};

const CATALOGS: Record<AgendaLocale, AgendaMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isAgendaLocale = (locale: string): locale is AgendaLocale =>
	(AGENDA_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const agendaMessages = (locale: string): AgendaMessages =>
	CATALOGS[isAgendaLocale(locale) ? locale : BASE_LOCALE];

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "agenda";

/** Locale→catalog accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): AgendaMessages => agendaMessages(locale);
