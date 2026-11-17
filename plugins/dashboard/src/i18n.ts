/**
 * Dashboard plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the panel page ctx and the view resolves its
 * strings here. A locale catalog must implement `DashboardMessages`
 * in full — a missing key is a type error, not an English fallback.
 * Domain copy (patients, consultations, notifications) lives in each
 * domain plugin's own catalog — the dashboard only owns shell strings.
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
		readonly plugins: string;
	};
	readonly registeredPlugins: string;
	readonly managePlugins: string;
	readonly stateEnabled: string;
	readonly stateDisabled: string;
	readonly stateSystem: string;
}

const en: DashboardMessages = {
	title: "Dashboard",
	subtitle: "System overview.",
	stats: {
		plugins: "Plugins",
	},
	registeredPlugins: "Registered plugins",
	managePlugins: "Manage",
	stateEnabled: "Enabled",
	stateDisabled: "Disabled",
	stateSystem: "System",
};

const ptBR: DashboardMessages = {
	title: "Painel",
	subtitle: "Visão geral do sistema.",
	stats: {
		plugins: "Plugins",
	},
	registeredPlugins: "Plugins registrados",
	managePlugins: "Gerenciar",
	stateEnabled: "Ativo",
	stateDisabled: "Inativo",
	stateSystem: "Sistema",
};

const es: DashboardMessages = {
	title: "Panel",
	subtitle: "Resumen del sistema.",
	stats: {
		plugins: "Plugins",
	},
	registeredPlugins: "Plugins registrados",
	managePlugins: "Gestionar",
	stateEnabled: "Activo",
	stateDisabled: "Inactivo",
	stateSystem: "Sistema",
};

const CATALOGS: Record<DashboardLocale, DashboardMessages> = { en, "pt-BR": ptBR, es };

export const isDashboardLocale = (locale: string): locale is DashboardLocale =>
	(DASHBOARD_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const dashboardMessages = (locale: string): DashboardMessages =>
	CATALOGS[isDashboardLocale(locale) ? locale : BASE_LOCALE];
