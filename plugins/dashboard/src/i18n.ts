/**
 * Dashboard plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the panel page ctx and the view resolves its
 * strings here. A locale catalog must implement `DashboardMessages`
 * in full — a missing key is a type error, not an English fallback.
 */

export const DASHBOARD_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "dashboard";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): DashboardMessages => dashboardMessages(locale);
export type DashboardLocale = (typeof DASHBOARD_LOCALES)[number];
export const BASE_LOCALE: DashboardLocale = "en";

export interface DashboardMessages {
	readonly title: string;
	readonly subtitle: string;
	readonly stats: {
		readonly patients: string;
		readonly consultations: string;
		readonly live: string;
		readonly plugins: string;
	};
	readonly byStatus: string;
	readonly bySource: string;
	readonly recentConsultations: string;
	readonly noConsultations: string;
	readonly viewAll: string;
	readonly registeredPlugins: string;
	readonly managePlugins: string;
	readonly colId: string;
	readonly colStatus: string;
	readonly colSource: string;
	readonly colOwner: string;
	readonly colCreated: string;
	readonly colState: string;
	readonly colContributions: string;
	readonly stateEnabled: string;
	readonly stateDisabled: string;
	readonly stateSystem: string;
	readonly consoleActivity: string;
	readonly unreadNotifications: string;
	readonly noNotifications: string;
}

const en: DashboardMessages = {
	title: "Dashboard",
	subtitle: "System overview.",
	stats: {
		patients: "Patients",
		consultations: "Consultations",
		live: "Live now",
		plugins: "Plugins",
	},
	byStatus: "Consultations by status",
	bySource: "By source",
	recentConsultations: "Recent consultations",
	noConsultations: "No consultations yet.",
	viewAll: "View all",
	registeredPlugins: "Registered plugins",
	managePlugins: "Manage",
	colId: "Id",
	colStatus: "Status",
	colSource: "Source",
	colOwner: "Owner",
	colCreated: "Created",
	colState: "State",
	colContributions: "Contributions",
	stateEnabled: "Enabled",
	stateDisabled: "Disabled",
	stateSystem: "System",
	consoleActivity: "Console activity",
	unreadNotifications: "Unread notifications",
	noNotifications: "No notifications yet.",
};

const ptBR: DashboardMessages = {
	title: "Painel",
	subtitle: "Visão geral do sistema.",
	stats: {
		patients: "Pacientes",
		consultations: "Consultas",
		live: "Ao vivo",
		plugins: "Plugins",
	},
	byStatus: "Consultas por status",
	bySource: "Por origem",
	recentConsultations: "Consultas recentes",
	noConsultations: "Nenhuma consulta ainda.",
	viewAll: "Ver tudo",
	registeredPlugins: "Plugins registrados",
	managePlugins: "Gerenciar",
	colId: "Id",
	colStatus: "Status",
	colSource: "Origem",
	colOwner: "Proprietário",
	colCreated: "Criada em",
	colState: "Estado",
	colContributions: "Contribuições",
	stateEnabled: "Ativo",
	stateDisabled: "Inativo",
	stateSystem: "Sistema",
	consoleActivity: "Atividade do console",
	unreadNotifications: "Notificações não lidas",
	noNotifications: "Nenhuma notificação ainda.",
};

const es: DashboardMessages = {
	title: "Panel",
	subtitle: "Resumen del sistema.",
	stats: {
		patients: "Pacientes",
		consultations: "Consultas",
		live: "En vivo",
		plugins: "Plugins",
	},
	byStatus: "Consultas por estado",
	bySource: "Por origen",
	recentConsultations: "Consultas recientes",
	noConsultations: "Ninguna consulta aún.",
	viewAll: "Ver todo",
	registeredPlugins: "Plugins registrados",
	managePlugins: "Gestionar",
	colId: "Id",
	colStatus: "Estado",
	colSource: "Origen",
	colOwner: "Propietario",
	colCreated: "Creada",
	colState: "Estado",
	colContributions: "Contribuciones",
	stateEnabled: "Activo",
	stateDisabled: "Inactivo",
	stateSystem: "Sistema",
	consoleActivity: "Actividad de la consola",
	unreadNotifications: "Notificaciones no leídas",
	noNotifications: "Ninguna notificación aún.",
};

const CATALOGS: Record<DashboardLocale, DashboardMessages> = { en, "pt-BR": ptBR, es };

export const isDashboardLocale = (locale: string): locale is DashboardLocale =>
	(DASHBOARD_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const dashboardMessages = (locale: string): DashboardMessages =>
	CATALOGS[isDashboardLocale(locale) ? locale : BASE_LOCALE];
