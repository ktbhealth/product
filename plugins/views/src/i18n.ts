import { paramMessage } from "@ktb/i18n";

/**
 * Views plugin copy, one typed catalog per locale — same contract as
 * plugins/document-store/src/i18n.ts: plugins cannot import the host's
 * Paraglide output, so surfaces resolve strings here from the active
 * locale (PageContext.locale). A locale catalog must implement
 * `ViewMessages` in full.
 */

export const VIEWS_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "views";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): ViewMessages => viewsMessages(locale);
export type ViewsLocale = (typeof VIEWS_LOCALES)[number];

export interface ViewMessages {
	/** Empty-state copy when the path matches no view (or the view is
	 * disabled/forbidden — same collapse contract as other pages). */
	readonly notFoundTitle: string;
	readonly notFoundDescription: string;
	/** Detail mode: the record id isn't visible/found. */
	readonly recordNotFoundTitle: string;
	readonly recordNotFoundDescription: string;
	/** Filter bar. */
	readonly filtersLabel: string;
	readonly resetFilters: string;
	/** Pagination. */
	readonly prevPage: string;
	readonly nextPage: string;
	readonly pageInfo: (current: number, total: number) => string;
	/** Empty list. */
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	/** Detail back link — param is the view title. */
	readonly backToView: (title: string) => string;
	/** Refetch failure on filter/pagination changes. */
	readonly loadFailed: string;
}

const en: ViewMessages = {
	notFoundTitle: "View not found",
	notFoundDescription: "This view does not exist or is not available.",
	recordNotFoundTitle: "Record not found",
	recordNotFoundDescription: "This record does not exist or is not visible to you.",
	filtersLabel: "Filters",
	resetFilters: "Reset",
	prevPage: "Previous",
	nextPage: "Next",
	pageInfo: paramMessage("en", "Page {current} of {total}", ["current", "total"]),
	emptyTitle: "No records",
	emptyDescription: "No records match this view.",
	backToView: paramMessage("en", "Back to {title}", ["title"]),
	loadFailed: "Could not load records. Try again.",
};

const ptBR: ViewMessages = {
	notFoundTitle: "Visualização não encontrada",
	notFoundDescription: "Esta visualização não existe ou não está disponível.",
	recordNotFoundTitle: "Registro não encontrado",
	recordNotFoundDescription: "Este registro não existe ou não está visível para você.",
	filtersLabel: "Filtros",
	resetFilters: "Limpar",
	prevPage: "Anterior",
	nextPage: "Próxima",
	pageInfo: paramMessage("pt-BR", "Página {current} de {total}", ["current", "total"]),
	emptyTitle: "Nenhum registro",
	emptyDescription: "Nenhum registro corresponde a esta visualização.",
	backToView: paramMessage("pt-BR", "Voltar para {title}", ["title"]),
	loadFailed: "Não foi possível carregar os registros. Tente novamente.",
};

const es: ViewMessages = {
	notFoundTitle: "Vista no encontrada",
	notFoundDescription: "Esta vista no existe o no está disponible.",
	recordNotFoundTitle: "Registro no encontrado",
	recordNotFoundDescription: "Este registro no existe o no es visible para ti.",
	filtersLabel: "Filtros",
	resetFilters: "Restablecer",
	prevPage: "Anterior",
	nextPage: "Siguiente",
	pageInfo: paramMessage("es", "Página {current} de {total}", ["current", "total"]),
	emptyTitle: "Sin registros",
	emptyDescription: "Ningún registro coincide con esta vista.",
	backToView: paramMessage("es", "Volver a {title}", ["title"]),
	loadFailed: "No se pudieron cargar los registros. Inténtalo de nuevo.",
};

const CATALOGS: Record<ViewsLocale, ViewMessages> = { en, "pt-BR": ptBR, es };

/** Resolve the messages catalog for `locale`; unknown locales fall
 * back to the base locale (en). */
export const viewsMessages = (locale: string): ViewMessages =>
	CATALOGS[locale as ViewsLocale] ?? en;
