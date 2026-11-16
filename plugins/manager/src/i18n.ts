/**
 * Manager plugin copy, one typed catalog per locale — same convention as
 * the other plugin i18n modules: plugins cannot import the host's
 * Paraglide output, so the panel page ctx injects the active locale and
 * the view resolves strings here.
 */

import { paramMessage } from "@ktb/i18n";

export const MANAGER_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "manager";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): ManagerMessages => managerMessages(locale);
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
	readonly tabTable: string;
	readonly tabMap: string;
	readonly viewDependencies: string;
	readonly viewChannels: string;
	readonly viewDomains: string;
	readonly viewHierarchy: string;
	readonly edgeRequired: string;
	readonly edgeOptional: string;
	readonly edgeRegion: string;
	readonly edgeKind: string;
	readonly edgeTree: string;
	readonly keywordsLabel: string;
	readonly depsSection: string;
	readonly dependentsSection: string;
	readonly regionsSection: string;
	readonly fullscreenEnter: string;
	readonly fullscreenExit: string;
	readonly layoutLoading: string;
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
	filteredCount: paramMessage("en", "Showing {shown} of {total}", ["shown", "total"]),
	noResults: "No plugins match the current filters.",
	rowActions: paramMessage("en", "Actions for {name}", ["name"]),
	actionConfigure: "Configure",
	configDialogTitle: paramMessage("en", "Configure {name}", ["name"]),
	paginationPrevious: "Previous",
	paginationNext: "Next",
	paginationPage: paramMessage("en", "Page {page}", ["page"]),
	statusEnabled: "Enabled",
	statusDisabled: "Disabled",
	statusBlocked: "Blocked",
	statusSystem: "System",
	systemHint: "System plugin — always enabled and cannot be disabled.",
	blockedHint: paramMessage("en", "Requires {deps} to be enabled first.", ["deps"]),
	enable: "Enable",
	disable: "Disable",
	confirmDisableTitle: "Disable plugin?",
	confirmDisableBody: paramMessage(
		"en",
		"This also disables {names}, which depend on it. Their data is retained.",
		["names"],
	),
	confirmDisableAction: "Disable all",
	cancel: "Cancel",
	configSave: "Save",
	configSaved: "Saved.",
	configSaveFailed: "Could not save the configuration.",
	empty: "No plugins discovered.",
	requiredMark: "required",
	tabTable: "Table",
	tabMap: "Map",
	viewDependencies: "Dependencies",
	viewChannels: "Channels",
	viewDomains: "Domains",
	viewHierarchy: "Hierarchy",
	edgeRequired: "Required dep",
	edgeOptional: "Optional dep",
	edgeRegion: "Publishes to region",
	edgeKind: "Contributes kind",
	edgeTree: "Namespace",
	keywordsLabel: "Keywords",
	depsSection: "Dependencies",
	dependentsSection: "Required by",
	regionsSection: "Channels",
	fullscreenEnter: "Full screen",
	fullscreenExit: "Exit full screen",
	layoutLoading: "Organizing graph…",
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
	filteredCount: paramMessage("pt-BR", "Exibindo {shown} de {total}", ["shown", "total"]),
	noResults: "Nenhum plugin corresponde aos filtros.",
	rowActions: paramMessage("pt-BR", "Ações de {name}", ["name"]),
	actionConfigure: "Configurar",
	configDialogTitle: paramMessage("pt-BR", "Configurar {name}", ["name"]),
	paginationPrevious: "Anterior",
	paginationNext: "Próxima",
	paginationPage: paramMessage("pt-BR", "Página {page}", ["page"]),
	statusEnabled: "Ativo",
	statusDisabled: "Inativo",
	statusBlocked: "Bloqueado",
	statusSystem: "Sistema",
	systemHint: "Plugin do sistema — sempre ativo e não pode ser desativado.",
	blockedHint: paramMessage("pt-BR", "Requer {deps} ativado primeiro.", ["deps"]),
	enable: "Ativar",
	disable: "Desativar",
	confirmDisableTitle: "Desativar plugin?",
	confirmDisableBody: paramMessage(
		"pt-BR",
		"Isso também desativa {names}, que dependem dele. Os dados são mantidos.",
		["names"],
	),
	confirmDisableAction: "Desativar todos",
	cancel: "Cancelar",
	configSave: "Salvar",
	configSaved: "Salvo.",
	configSaveFailed: "Não foi possível salvar a configuração.",
	empty: "Nenhum plugin encontrado.",
	requiredMark: "obrigatório",
	tabTable: "Tabela",
	tabMap: "Mapa",
	viewDependencies: "Dependências",
	viewChannels: "Canais",
	viewDomains: "Domínios",
	viewHierarchy: "Hierarquia",
	edgeRequired: "Dep obrigatória",
	edgeOptional: "Dep opcional",
	edgeRegion: "Publica na region",
	edgeKind: "Contribui kind",
	edgeTree: "Namespace",
	keywordsLabel: "Palavras-chave",
	depsSection: "Dependências",
	dependentsSection: "Requerido por",
	regionsSection: "Canais",
	fullscreenEnter: "Tela cheia",
	fullscreenExit: "Sair da tela cheia",
	layoutLoading: "Organizando grafo…",
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
	filteredCount: paramMessage("es", "Mostrando {shown} de {total}", ["shown", "total"]),
	noResults: "Ningún plugin coincide con los filtros.",
	rowActions: paramMessage("es", "Acciones de {name}", ["name"]),
	actionConfigure: "Configurar",
	configDialogTitle: paramMessage("es", "Configurar {name}", ["name"]),
	paginationPrevious: "Anterior",
	paginationNext: "Siguiente",
	paginationPage: paramMessage("es", "Página {page}", ["page"]),
	statusEnabled: "Activo",
	statusDisabled: "Inactivo",
	statusBlocked: "Bloqueado",
	statusSystem: "Sistema",
	systemHint: "Plugin del sistema — siempre activo y no se puede desactivar.",
	blockedHint: paramMessage("es", "Requiere {deps} activado primero.", ["deps"]),
	enable: "Activar",
	disable: "Desactivar",
	confirmDisableTitle: "¿Desactivar plugin?",
	confirmDisableBody: paramMessage(
		"es",
		"Esto también desactiva {names}, que dependen de él. Los datos se conservan.",
		["names"],
	),
	confirmDisableAction: "Desactivar todos",
	cancel: "Cancelar",
	configSave: "Guardar",
	configSaved: "Guardado.",
	configSaveFailed: "No se pudo guardar la configuración.",
	empty: "No se encontraron plugins.",
	requiredMark: "obligatorio",
	tabTable: "Tabla",
	tabMap: "Mapa",
	viewDependencies: "Dependencias",
	viewChannels: "Canales",
	viewDomains: "Dominios",
	viewHierarchy: "Jerarquía",
	edgeRequired: "Dep obligatoria",
	edgeOptional: "Dep opcional",
	edgeRegion: "Publica en region",
	edgeKind: "Contribuye kind",
	edgeTree: "Namespace",
	keywordsLabel: "Palabras clave",
	depsSection: "Dependencias",
	dependentsSection: "Requerido por",
	regionsSection: "Canales",
	fullscreenEnter: "Pantalla completa",
	fullscreenExit: "Salir de pantalla completa",
	layoutLoading: "Organizando grafo…",
};

const catalogs: Record<ManagerLocale, ManagerMessages> = { en, "pt-BR": ptBR, es };

export const managerMessages = (locale?: string): ManagerMessages =>
	catalogs[(locale as ManagerLocale) ?? BASE_LOCALE] ?? catalogs[BASE_LOCALE];
