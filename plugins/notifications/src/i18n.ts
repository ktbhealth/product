/**
 * Notifications plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale (header-action prop, `getLocale()` at event ingest) and
 * copy resolves here. A locale catalog must implement
 * `NotificationMessages` in full — a missing key is a type error, not
 * an English fallback at runtime.
 */

import { paramMessage } from "@ktb/i18n";

export const NOTIFICATION_LOCALES = ["en", "pt-BR", "es"] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];
export const BASE_LOCALE: NotificationLocale = "en";

export interface NotificationMessages {
	readonly label: string;
	readonly unreadCount: (n: number) => string;
	readonly markAllRead: string;
	readonly empty: string;
	readonly markAsRead: (title: string) => string;
	/** Persisted notification titles, keyed by event kind. */
	readonly titles: {
		readonly patientCreated: string;
		readonly patientDeleted: string;
		readonly consultationCreated: string;
		readonly appointmentReminder: string;
	};
	/** Persisted notification bodies, keyed by event kind. */
	readonly bodies: {
		/** "Patient name — 14:30" for plaintext tenants. */
		readonly appointmentReminder: (name: string, time: string) => string;
		/** Metadata-only variant under ZK — the patient's `v1.` name
		 * envelope never lands in the row; only the schedule time. */
		readonly appointmentReminderZk: (time: string) => string;
	};
	/** /platform dashboard slot: the console-activity card contributed
	 * via portal.dashboard.sections. */
	readonly dashboard: {
		readonly consoleActivity: string;
		readonly unreadNotifications: string;
		readonly noNotifications: string;
	};
}

const en: NotificationMessages = {
	label: "Notifications",
	unreadCount: paramMessage("en", "{n} unread", ["n"]),
	markAllRead: "Mark all read",
	empty: "No notifications",
	markAsRead: paramMessage("en", 'Mark "{title}" as read', ["title"]),
	titles: {
		patientCreated: "Patient created",
		patientDeleted: "Patient deleted",
		consultationCreated: "Consultation started",
		appointmentReminder: "Appointment starting soon",
	},
	bodies: {
		appointmentReminder: paramMessage("en", "{name} — {time}", ["name", "time"]),
		appointmentReminderZk: paramMessage("en", "Starts at {time}", ["time"]),
	},
	dashboard: {
		consoleActivity: "Console activity",
		unreadNotifications: "Unread notifications",
		noNotifications: "No notifications yet.",
	},
};

const ptBR: NotificationMessages = {
	label: "Notificações",
	unreadCount: paramMessage("pt-BR", "{n, plural, =1{{n} não lida} other{{n} não lidas}}", ["n"]),
	markAllRead: "Marcar todas como lidas",
	empty: "Nenhuma notificação",
	markAsRead: paramMessage("pt-BR", 'Marcar "{title}" como lida', ["title"]),
	titles: {
		patientCreated: "Paciente criado",
		patientDeleted: "Paciente excluído",
		consultationCreated: "Consulta iniciada",
		appointmentReminder: "Consulta prestes a começar",
	},
	bodies: {
		appointmentReminder: paramMessage("pt-BR", "{name} — {time}", ["name", "time"]),
		appointmentReminderZk: paramMessage("pt-BR", "Começa às {time}", ["time"]),
	},
	dashboard: {
		consoleActivity: "Atividade do console",
		unreadNotifications: "Notificações não lidas",
		noNotifications: "Nenhuma notificação ainda.",
	},
};

const es: NotificationMessages = {
	label: "Notificaciones",
	unreadCount: paramMessage("es", "{n} sin leer", ["n"]),
	markAllRead: "Marcar todas como leídas",
	empty: "Ninguna notificación",
	markAsRead: paramMessage("es", 'Marcar "{title}" como leída', ["title"]),
	titles: {
		patientCreated: "Paciente creado",
		patientDeleted: "Paciente eliminado",
		consultationCreated: "Consulta iniciada",
		appointmentReminder: "Consulta a punto de comenzar",
	},
	bodies: {
		appointmentReminder: paramMessage("es", "{name} — {time}", ["name", "time"]),
		appointmentReminderZk: paramMessage("es", "Empieza a las {time}", ["time"]),
	},
	dashboard: {
		consoleActivity: "Actividad de la consola",
		unreadNotifications: "Notificaciones no leídas",
		noNotifications: "Ninguna notificación aún.",
	},
};

const CATALOGS: Record<NotificationLocale, NotificationMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isNotificationLocale = (locale: string): locale is NotificationLocale =>
	(NOTIFICATION_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const notificationMessages = (locale: string): NotificationMessages =>
	CATALOGS[isNotificationLocale(locale) ? locale : BASE_LOCALE];

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "notifications";

/** Locale→catalog accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): NotificationMessages =>
	notificationMessages(locale);
