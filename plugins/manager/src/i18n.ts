/**
 * Manager plugin copy, one typed catalog per locale — same convention as
 * the other plugin i18n modules: plugins cannot import the host's
 * Paraglide output, so the panel page ctx injects the active locale and
 * the view resolves strings here.
 */

export const MANAGER_LOCALES = ["en", "pt-BR", "es"] as const;
export type ManagerLocale = (typeof MANAGER_LOCALES)[number];
export const BASE_LOCALE: ManagerLocale = "en";

export interface ManagerMessages {
	readonly title: string;
	readonly description: string;
	readonly colPlugin: string;
	readonly colKind: string;
	readonly colStatus: string;
	readonly colActions: string;
	readonly searchPlaceholder: string;
	readonly searchLabel: string;
	readonly statusFilterLabel: string;
	readonly filterAll: string;
	readonly filteredCount: (shown: number, total: number) => string;
	readonly noResults: string;
	readonly rowActions: (name: string) => string;
	readonly actionConfigure: string;
	readonly configDialogTitle: (name: string) => string;
	readonly paginationPrevious: string;
	readonly paginationNext: string;
	readonly paginationPage: (page: number) => string;
	readonly statusEnabled: string;
	readonly statusDisabled: string;
	readonly statusBlocked: string;
	readonly statusSystem: string;
	readonly systemHint: string;
	readonly blockedHint: (deps: string) => string;
	readonly enable: string;
	readonly disable: string;
	readonly confirmDisableTitle: string;
	readonly confirmDisableBody: (names: string) => string;
	readonly confirmDisableAction: string;
	readonly cancel: string;
	readonly configSave: string;
	readonly configSaved: string;
	readonly configSaveFailed: string;
	readonly empty: string;
	readonly requiredMark: string;
}

const en: ManagerMessages = {
	title: "Plugins",
	description:
		"Every plugin ships in the bundle; toggling controls its UI surface and dispatch. Disabling a plugin also disables everything that depends on it.",
	colPlugin: "Plugin",
	colKind: "Contributions",
	colStatus: "Status",
	colActions: "Actions",
	searchPlaceholder: "Filter by name or id…",
	searchLabel: "Filter plugins",
	statusFilterLabel: "Filter by status",
	filterAll: "All",
	filteredCount: (shown, total) => `Showing ${shown} of ${total}`,
	noResults: "No plugins match the current filters.",
	rowActions: (name) => `Actions for ${name}`,
	actionConfigure: "Configure",
	configDialogTitle: (name) => `Configure ${name}`,
	paginationPrevious: "Previous",
	paginationNext: "Next",
	paginationPage: (page) => `Page ${page}`,
	statusEnabled: "Enabled",
	statusDisabled: "Disabled",
	statusBlocked: "Blocked",
	statusSystem: "System",
	systemHint: "System plugin — always enabled and cannot be disabled.",
	blockedHint: (deps) => `Requires ${deps} to be enabled first.`,
	enable: "Enable",
	disable: "Disable",
	confirmDisableTitle: "Disable plugin?",
	confirmDisableBody: (names) =>
		`This also disables ${names}, which depend on it. Their data is retained.`,
	confirmDisableAction: "Disable all",
	cancel: "Cancel",
	configSave: "Save",
	configSaved: "Saved.",
	configSaveFailed: "Could not save the configuration.",
	empty: "No plugins discovered.",
	requiredMark: "required",
};

const ptBR: ManagerMessages = {
	title: "Plugins",
	description:
		"Todos os plugins vão no bundle; ativar/desativar controla a superfície de UI e o dispatch. Desativar um plugin também desativa tudo que depende dele.",
	colPlugin: "Plugin",
	colKind: "Contribuições",
	colStatus: "Status",
	colActions: "Ações",
	searchPlaceholder: "Filtrar por nome ou id…",
	searchLabel: "Filtrar plugins",
	statusFilterLabel: "Filtrar por status",
	filterAll: "Todos",
	filteredCount: (shown, total) => `Exibindo ${shown} de ${total}`,
	noResults: "Nenhum plugin corresponde aos filtros.",
	rowActions: (name) => `Ações de ${name}`,
	actionConfigure: "Configurar",
	configDialogTitle: (name) => `Configurar ${name}`,
	paginationPrevious: "Anterior",
	paginationNext: "Próxima",
	paginationPage: (page) => `Página ${page}`,
	statusEnabled: "Ativo",
	statusDisabled: "Inativo",
	statusBlocked: "Bloqueado",
	statusSystem: "Sistema",
	systemHint: "Plugin do sistema — sempre ativo e não pode ser desativado.",
	blockedHint: (deps) => `Requer ${deps} ativado primeiro.`,
	enable: "Ativar",
	disable: "Desativar",
	confirmDisableTitle: "Desativar plugin?",
	confirmDisableBody: (names) =>
		`Isso também desativa ${names}, que dependem dele. Os dados são mantidos.`,
	confirmDisableAction: "Desativar todos",
	cancel: "Cancelar",
	configSave: "Salvar",
	configSaved: "Salvo.",
	configSaveFailed: "Não foi possível salvar a configuração.",
	empty: "Nenhum plugin encontrado.",
	requiredMark: "obrigatório",
};

const es: ManagerMessages = {
	title: "Plugins",
	description:
		"Todos los plugins van en el bundle; activarlos/desactivarlos controla la superficie de UI y el dispatch. Desactivar un plugin también desactiva todo lo que depende de él.",
	colPlugin: "Plugin",
	colKind: "Contribuciones",
	colStatus: "Estado",
	colActions: "Acciones",
	searchPlaceholder: "Filtrar por nombre o id…",
	searchLabel: "Filtrar plugins",
	statusFilterLabel: "Filtrar por estado",
	filterAll: "Todos",
	filteredCount: (shown, total) => `Mostrando ${shown} de ${total}`,
	noResults: "Ningún plugin coincide con los filtros.",
	rowActions: (name) => `Acciones de ${name}`,
	actionConfigure: "Configurar",
	configDialogTitle: (name) => `Configurar ${name}`,
	paginationPrevious: "Anterior",
	paginationNext: "Siguiente",
	paginationPage: (page) => `Página ${page}`,
	statusEnabled: "Activo",
	statusDisabled: "Inactivo",
	statusBlocked: "Bloqueado",
	statusSystem: "Sistema",
	systemHint: "Plugin del sistema — siempre activo y no se puede desactivar.",
	blockedHint: (deps) => `Requiere ${deps} activado primero.`,
	enable: "Activar",
	disable: "Desactivar",
	confirmDisableTitle: "¿Desactivar plugin?",
	confirmDisableBody: (names) =>
		`Esto también desactiva ${names}, que dependen de él. Los datos se conservan.`,
	confirmDisableAction: "Desactivar todos",
	cancel: "Cancelar",
	configSave: "Guardar",
	configSaved: "Guardado.",
	configSaveFailed: "No se pudo guardar la configuración.",
	empty: "No se encontraron plugins.",
	requiredMark: "obligatorio",
};

const catalogs: Record<ManagerLocale, ManagerMessages> = { en, "pt-BR": ptBR, es };

export const managerMessages = (locale?: string): ManagerMessages =>
	catalogs[(locale as ManagerLocale) ?? BASE_LOCALE] ?? catalogs[BASE_LOCALE];
